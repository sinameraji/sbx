#!/bin/bash
# Part C — spike / thundering-herd. Build a pool of N PAUSED sandboxes (each pause
# kills the VMM -> ~0 host RAM at rest), then wake ALL of them AT ONCE and measure
# the resume-latency distribution + how many succeed before the host breaks
# (RAM exhaustion / admission refusal). Small 2 GiB guests so N can be pushed.
# The breaking point IS the finding. Runs on the box.
set +e
NODE=$(command -v node); BASE=localhost:4750
OUT=${OUT:-/tmp/bench-spike}; mkdir -p "$OUT"
MEM=${MEM:-2048}
N=${N:-80}
STATEDIR="$HOME/.hotcell/fc"
LOG(){ echo "[C $(date -u +%H:%M:%S)] $*"; }
freemb(){ awk '/MemAvailable/{printf "%d", $2/1024}' /proc/meminfo; }
val(){ $NODE -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(d)["'"$1"'"]??""))}catch{process.stdout.write("")}})'; }
pctl(){ $NODE -e 'let a=require("fs").readFileSync(0,"utf8").trim().split(/\s+/).map(Number).filter(x=>!isNaN(x)).sort((x,y)=>x-y);let p=q=>a.length?a[Math.min(a.length-1,Math.floor(q/100*a.length))]:0;console.log(`n=${a.length} min=${a[0]} p50=${p(50)} p95=${p(95)} p99=${p(99)} max=${a[a.length-1]}`)'; }

sudo pkill -9 -f "daemon/dist"; sudo pkill -9 -f firecracker; sleep 2
cd ~/hotcell
sudo -E env HOTCELL_DRIVER=firecracker HOTCELL_DB=:memory: HOTCELL_FC_KERNEL=helpers/hotcell-vz/guest/vmlinux-fc setsid bash -c "$NODE packages/daemon/dist/index.js > /tmp/hotcelld-c.log 2>&1" </dev/null & disown
for i in $(seq 1 30); do curl -s --max-time 2 $BASE/healthz | grep -q ok && break; sleep 1; done
LOG "daemon up; host MemAvailable=$(freemb)MB (host ~125GiB)"

# --- build the pool: create -> pause, one at a time (setup RAM stays ~1 live guest) ---
LOG "building pool of up to $N paused ${MEM}MB sandboxes"
: > "$OUT/ids.txt"
for k in $(seq 1 "$N"); do
  id=$(curl -s -X POST $BASE/sandboxes -H 'content-type: application/json' -d "{\"image\":\"ubuntu:24.04\",\"driver\":\"firecracker\",\"memoryMb\":${MEM},\"cpus\":1}" | val id)
  if [ -z "$id" ] || echo "$id" | grep -qi err; then LOG "  create #$k refused/failed -> pool caps at $((k-1))"; break; fi
  curl -s -X POST "$BASE/sandboxes/$id/pause" >/dev/null 2>&1
  echo "$id" >> "$OUT/ids.txt"
  [ $((k % 10)) -eq 0 ] && LOG "  ...$k paused (MemAvailable=$(freemb)MB)"
done
POOL=$(wc -l < "$OUT/ids.txt")
SNAP=$(du -sm "$STATEDIR" 2>/dev/null | cut -f1)
echo "RESULT C at-rest: $POOL paused ${MEM}MB sandboxes -> MemAvailable=$(freemb)MB, snapshot disk=${SNAP}MB" | tee "$OUT/result.txt"

# --- THE SPIKE: wake ALL at once (parallel), time each resume ---
LOG "THUNDERING HERD: waking all $POOL at once"
: > "$OUT/resume_ms.txt"; : > "$OUT/fail.txt"
spike0=$(date +%s%N)
while read -r id; do
  ( t0=$(date +%s%N)
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 120 -X POST "$BASE/sandboxes/$id/start")
    t1=$(date +%s%N)
    if [ "$code" = "200" ]; then echo $(( (t1-t0)/1000000 )) >> "$OUT/resume_ms.txt"; else echo "$id $code" >> "$OUT/fail.txt"; fi
  ) &
done < "$OUT/ids.txt"
wait
spike1=$(date +%s%N)
OK=$(wc -l < "$OUT/resume_ms.txt" 2>/dev/null || echo 0); FAIL=$(wc -l < "$OUT/fail.txt" 2>/dev/null || echo 0)
OOMK=$(dmesg 2>/dev/null | grep -c -i "killed process\|out of memory")
echo "RESULT C spike: woke $POOL at once -> $OK resumed / $FAIL failed; wall=$(( (spike1-spike0)/1000000 ))ms; MemAvailable_after=$(freemb)MB; oom_kills=$OOMK" | tee -a "$OUT/result.txt"
echo "RESULT C resume_ms under herd: $(pctl < "$OUT/resume_ms.txt")" | tee -a "$OUT/result.txt"
echo "RESULT C failure codes: $(awk '{print $2}' "$OUT/fail.txt" 2>/dev/null | sort | uniq -c | tr '\n' ' ')" | tee -a "$OUT/result.txt"

LOG "cleanup"; while read -r id; do curl -s -X DELETE "$BASE/sandboxes/$id" >/dev/null 2>&1; done < "$OUT/ids.txt"
echo "=== RESULTS ==="; cat "$OUT/result.txt"
echo PARTCDONE
