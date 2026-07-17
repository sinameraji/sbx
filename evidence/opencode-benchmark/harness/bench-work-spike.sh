#!/bin/bash
# §3 correction — Part C "wake AND work". Cumulatively wake paused guests and make each
# actually TOUCH ~TOUCH_MB of memory (fault pages in for real, via tmpfs+dd), tracking host
# MemAvailable, until the wall. Reports how many concurrently-WORKING guests fit and HOW it
# gives.
#
# KEY CONTEXT (confirmed in code): admission control (capacity.admit -> 503) gates `create`
# but NOT the resume/start path (server.ts startSandbox -> resumeSandbox -> driver.start,
# no admit call). So a wake-spike has NO admission gate — the wall CANNOT be a clean 503 on
# resume; it will over-commit and give ungracefully (host OOM / thrash). We measure that.
#
# Memory-proxy note: the guest has no swap, so tmpfs pages can't be evicted inside the guest
# (they're a real resident working set). We also `swapoff -a` on the host so a wall shows as
# a clean OOM rather than being softened by host swap. (Firecracker guest RAM is file-backed
# to the snapshot, so the host can also reclaim by write-back — if the wall is soft, that's
# why, and it's reported as observed, not asserted.)
set +e
NODE=$(command -v node); BASE=localhost:4750
OUT=/tmp/work-spike; mkdir -p "$OUT"; : > "$OUT/ramp.tsv"
MEM=${MEM:-2048}; N=${N:-90}; TOUCH_MB=${TOUCH_MB:-1500}
freemb(){ awk '/MemAvailable/{printf "%d",$2/1024}' /proc/meminfo; }
ooms(){ sudo dmesg 2>/dev/null | grep -ci "killed process\|out of memory"; }
val(){ $NODE -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(d).id||""))}catch{}})'; }
exj(){ curl -s --max-time 120 -N -X POST "$BASE/sandboxes/$1/exec" -H 'content-type: application/json' -d "$2" | sed -n 's/^data: //p' | $NODE -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{d.trim().split("\n").forEach(l=>{try{let e=JSON.parse(l);if(e.type=="stdout"||e.type=="stderr")process.stdout.write(e.data)}catch{}})})'; }
sudo pkill -9 -f "daemon/dist" 2>/dev/null; sudo pkill -9 -f firecracker 2>/dev/null; sleep 2
cd ~/hotcell
sudo -E env HOTCELL_DRIVER=firecracker HOTCELL_DB=:memory: HOTCELL_FC_KERNEL=helpers/hotcell-vz/guest/vmlinux-fc setsid bash -c "$NODE packages/daemon/dist/index.js > /tmp/hotcelld-work.log 2>&1" </dev/null & disown
for i in $(seq 1 30); do curl -s --max-time 2 $BASE/healthz | grep -q ok && break; sleep 1; done
sudo dmesg -C 2>/dev/null
sudo swapoff -a 2>/dev/null; echo "host swap: $(awk '/SwapTotal/{print $2}' /proc/meminfo)kB — box is NO-SWAP by default (Hetzner installimage), so this IS the realistic config, not artificially harshened"
echo "daemon up; baseline MemAvailable=$(freemb)MB"
# build pool of paused guests
: > "$OUT/ids.txt"
for k in $(seq 1 $N); do
  id=$(curl -s --max-time 180 -X POST $BASE/sandboxes -H 'content-type: application/json' -d "{\"image\":\"ubuntu:24.04\",\"driver\":\"firecracker\",\"memoryMb\":${MEM},\"cpus\":1}" | val)
  [ -z "$id" ] && { echo "create #$k refused (pool caps at $((k-1)))"; break; }
  curl -s -X POST "$BASE/sandboxes/$id/pause" >/dev/null 2>&1; echo "$id" >> "$OUT/ids.txt"
done
POOL=$(wc -l < "$OUT/ids.txt"); BASE_MEM=$(freemb); echo "pool: $POOL paused ${MEM}MB; MemAvailable=${BASE_MEM}MB"
echo "=== ramp: wake + touch ${TOUCH_MB}MB per guest, cumulative ==="
# NOTE: guest rootfs is ext4 read-only; /tmp and /run are the writable RAM-backed (tmpfs)
# paths (verified by bench-guest-probe.sh). We mount a sized tmpfs on /tmp/h so each guest's
# dd is a real *resident* working set (no guest swap => tmpfs pages are pinned).
w=0; WALL=""
while read -r id; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 60 -X POST "$BASE/sandboxes/$id/start")
  if [ "$code" != "200" ]; then WALL="admission-503"; echo "RESULT WALL: resume refused at $w working guests (HTTP $code) — CLEAN admission refusal"; break; fi
  r=$(exj "$id" "{\"command\":\"mkdir -p /tmp/h && mount -t tmpfs -o size=$((TOUCH_MB+300))m tmpfs /tmp/h && dd if=/dev/zero of=/tmp/h/x bs=1M count=${TOUCH_MB} 2>&1 | tail -1 || echo TOUCH_FAILED\"}")
  w=$((w+1)); mem=$(freemb); oom=$(ooms); alive=$(pgrep -c -f firecracker)
  if [ "$w" = "1" ]; then d=$((BASE_MEM - mem)); if [ "$d" -lt $((TOUCH_MB/2)) ]; then echo "ABORT: first touch moved only ${d}MB (<$((TOUCH_MB/2))) — memory not faulted in; dd=[$r]"; WALL="touch-broken"; break; fi; echo "first-touch OK: host memory moved ${d}MB for one ${TOUCH_MB}MB guest"; fi
  echo "worked=$w MemAvailable=${mem}MB alive_fc=$alive oom_kills=$oom dd=[$(echo "$r" | tr '\n' ' ' | tail -c 60)]"
  printf '%s\t%s\t%s\t%s\n' "$w" "$mem" "$oom" "$alive" >> "$OUT/ramp.tsv"
  [ "$oom" -gt 0 ] && { WALL="host-OOM"; echo "RESULT WALL: host OOM-killed a guest at ~$w working guests (MemAvailable=${mem}MB) — UNGRACEFUL crash (resume path has NO admission gate), not a clean refusal"; break; }
  [ "$mem" -lt 1500 ] && { WALL="near-exhaustion"; echo "RESULT WALL: MemAvailable hit ${mem}MB at $w working guests (near exhaustion, no OOM yet)"; break; }
done < "$OUT/ids.txt"
MINMEM=$(awk 'NR==1||$2<m{m=$2}END{print m+0}' "$OUT/ramp.tsv" 2>/dev/null)
if [ -z "$WALL" ]; then
  echo "RESULT work-spike: NO HARD WALL INDUCED — reached pool max ($w working ${MEM}MB guests, each touched ${TOUCH_MB}MB) without OOM or exhaustion. MemAvailable bottomed at ${MINMEM}MB. Report as 'could not induce a wall with this method' (file-backed guest pages are reclaimable via host write-back), NOT as 'no wall exists'."
else
  echo "RESULT work-spike: WALL=$WALL at $w concurrently-WORKING ${MEM}MB guests (each touched ${TOUCH_MB}MB); MemAvailable bottomed ${MINMEM}MB; final=$(freemb)MB oom_kills=$(ooms). Over-commit, not admission — resume path is ungated."
fi
while read -r id; do curl -s -X DELETE "$BASE/sandboxes/$id" >/dev/null 2>&1; done < "$OUT/ids.txt"
echo WORKSPIKEDONE
