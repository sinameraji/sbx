#!/bin/bash
# B7 — snapshot compressibility. zstd -3 on REAL Full snapshots (snapshots are
# Full, not diff — confirmed in the driver code). Two labeled cases, because
# they answer different questions and compress very differently:
#   idle2g    — a 2 GiB guest paused right after boot (the Part C/D "large paused
#               fleet" economics case; mostly zero pages, expect a silly ratio)
#   worked16g — a 16 GiB guest paused after the REAL OpenCode clone+install+
#               typecheck (KEEP_ROOT) — the realistic "agent at rest" case.
# Reports raw size, compressed size, ratio, wall time (zstd -3 -T0).
set +e
NODE=$(command -v node); BASE=localhost:4750
sudo pkill -9 -f "daemon/dist" 2>/dev/null; sudo pkill -9 -f firecracker 2>/dev/null; sleep 2
cd ~/hotcell
command -v zstd >/dev/null 2>&1 || { apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq zstd >/dev/null 2>&1; }
sudo -E env HOTCELL_DRIVER=firecracker HOTCELL_DB=:memory: HOTCELL_FC_KERNEL=helpers/hotcell-vz/guest/vmlinux-fc \
  setsid bash -c "$NODE packages/daemon/dist/index.js > /tmp/hotcelld-zstd.log 2>&1" </dev/null & disown
for i in $(seq 1 30); do curl -s --max-time 2 $BASE/healthz | grep -q ok && break; sleep 1; done
val(){ $NODE -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(d).id||""))}catch{}})'; }
exj(){ curl -s --max-time 900 -N -X POST "$BASE/sandboxes/$1/exec" -H 'content-type: application/json' -d "$2" | sed -n 's/^data: //p' | $NODE -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{d.trim().split("\n").forEach(l=>{try{let e=JSON.parse(l);if(e.type=="stdout"||e.type=="stderr")process.stdout.write(e.data)}catch{}})})'; }
snapfor(){ find /root/.hotcell -name "snapshot.mem" -path "*$1*" 2>/dev/null | head -1; }
zr(){ # <file> <label>
  local f="$1" lbl="$2"
  [ -z "$f" ] || [ ! -f "$f" ] && { echo "RESULT B7 $lbl: SNAPSHOT NOT FOUND"; return; }
  local sz; sz=$(stat -c%s "$f")
  local t0; t0=$(date +%s%N)
  zstd -3 -T0 -f -q -o "/tmp/snap-$lbl.zst" "$f"
  local t1; t1=$(date +%s%N)
  local cz; cz=$(stat -c%s "/tmp/snap-$lbl.zst")
  awk -v a="$sz" -v b="$cz" -v ms="$(( (t1-t0)/1000000 ))" -v l="$lbl" \
    'BEGIN{printf "RESULT B7 %s: raw=%.2fGB zst=%.2fGB ratio=%.1fx zstd3_T0_ms=%d\n", l, a/1e9, b/1e9, a/b, ms}'
  rm -f "/tmp/snap-$lbl.zst"
}

echo "=== case 1: idle 2GiB guest (no NIC, default posture) ==="
A=$(curl -s --max-time 180 -X POST $BASE/sandboxes -H 'content-type: application/json' -d '{"image":"ubuntu:24.04","driver":"firecracker","memoryMb":2048,"cpus":2}' | val)
echo "sandbox=$A"; sleep 5
curl -s --max-time 120 -X POST "$BASE/sandboxes/$A/pause" >/dev/null; sleep 2
zr "$(snapfor "$A")" idle2g

echo "=== case 2: 16GiB guest paused after REAL OpenCode workload ==="
B=$(curl -s --max-time 180 -X POST $BASE/sandboxes -H 'content-type: application/json' -d '{"image":"ubuntu:24.04","driver":"firecracker","networked":true,"memoryMb":16384,"cpus":8,"cpuset":"0-7"}' | val)
echo "sandbox=$B"
curl -fsSL "https://raw.githubusercontent.com/anomalyco/opencode/provider-benchmark/script/provider-benchmark.sh" -o /tmp/pb.sh
PB64=$(base64 -w0 /tmp/pb.sh)
exj "$B" "{\"command\":\"echo $PB64 | base64 -d > /tmp/pb.sh\"}" >/dev/null
echo "running full benchmark in guest (KEEP_ROOT, ~2min)..."
exj "$B" '{"command":"BENCH_PROVIDER=hotcell BENCH_ROOT=/workspace/bench BENCH_KEEP_ROOT=true bash /tmp/pb.sh >/dev/null 2>&1; echo workload_done"}'
curl -s --max-time 300 -X POST "$BASE/sandboxes/$B/pause" >/dev/null; sleep 2
zr "$(snapfor "$B")" worked16g

curl -s -X DELETE "$BASE/sandboxes/$A" >/dev/null 2>&1
curl -s -X DELETE "$BASE/sandboxes/$B" >/dev/null 2>&1
echo ZSTDDONE
