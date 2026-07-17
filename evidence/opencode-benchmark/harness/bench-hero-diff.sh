#!/bin/bash
# §1 correction — prove the RESULT survives a mid-typecheck pause, not just the exit code.
# Captures full stdout+stderr of an UNINTERRUPTED typecheck and one PAUSED-mid-run, and
# diffs them. Timing values differ run-to-run; we strip those and compare the content.
set +e
NODE=$(command -v node); BASE=localhost:4750
OUT=/tmp/hero-diff; mkdir -p "$OUT"
sudo pkill -9 -f "daemon/dist" 2>/dev/null; sudo pkill -9 -f firecracker 2>/dev/null; sleep 2
cd ~/hotcell
sudo -E env HOTCELL_DRIVER=firecracker HOTCELL_DB=:memory: HOTCELL_FC_KERNEL=helpers/hotcell-vz/guest/vmlinux-fc \
  setsid bash -c "$NODE packages/daemon/dist/index.js > /tmp/hotcelld-hero.log 2>&1" </dev/null & disown
for i in $(seq 1 30); do curl -s --max-time 2 $BASE/healthz | grep -q ok && break; sleep 1; done
val(){ $NODE -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(d).id||""))}catch{}})'; }
exj(){ curl -s --max-time 900 -N -X POST "$BASE/sandboxes/$1/exec" -H 'content-type: application/json' -d "$2" | sed -n 's/^data: //p' | $NODE -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{d.trim().split("\n").forEach(l=>{try{let e=JSON.parse(l);if(e.type=="stdout"||e.type=="stderr")process.stdout.write(e.data)}catch{}})})'; }
WS=$(curl -s --max-time 180 -X POST $BASE/sandboxes -H 'content-type: application/json' -d '{"image":"ubuntu:24.04","driver":"firecracker","networked":true,"memoryMb":24576,"cpus":8,"cpuset":"0-7"}' | val)
echo "sandbox=$WS"
curl -fsSL "https://raw.githubusercontent.com/anomalyco/opencode/provider-benchmark/script/provider-benchmark.sh" -o /tmp/pb.sh
PB64=$(base64 -w0 /tmp/pb.sh); exj "$WS" "{\"command\":\"echo $PB64 | base64 -d > /root/pb.sh\"}" >/dev/null
echo "installing opencode (KEEP_ROOT, ~2min)..."
exj "$WS" '{"command":"BENCH_PROVIDER=hotcell BENCH_ROOT=/workspace/bench BENCH_KEEP_ROOT=true bash /root/pb.sh >/dev/null 2>&1; echo installed"}'
TC='cd /workspace/bench/repo && PATH=/workspace/bench/bun/bin:$PATH bun typecheck'
echo "=== baseline (uninterrupted) -> base.log ==="
exj "$WS" "{\"command\":\"$TC > /workspace/base.log 2>&1; echo BASE_EXIT=\$?\"}"
echo "=== interrupted (pause mid-run, resume) -> intr.log ==="
exj "$WS" "{\"command\":\"nohup sh -c '$TC > /workspace/intr.log 2>&1; echo INTR_EXIT=\$? >> /workspace/intr.log' >/dev/null 2>&1 & echo started\"}"
sleep 12; curl -s -X POST "$BASE/sandboxes/$WS/pause" >/dev/null; echo "paused mid-run"; sleep 5
curl -s -X POST "$BASE/sandboxes/$WS/start" >/dev/null; echo "resumed"
for i in $(seq 1 120); do [ "$(exj "$WS" '{"command":"grep -c INTR_EXIT /workspace/intr.log 2>/dev/null || echo 0"}')" = "1" ] && break; sleep 2; done
exj "$WS" '{"command":"cat /workspace/base.log"}' > "$OUT/base.log"
exj "$WS" '{"command":"cat /workspace/intr.log"}' > "$OUT/intr.log"
# strip our EXIT markers + numeric timing values (durations differ run-to-run) for a content diff
sed -E 's/[0-9]+(\.[0-9]+)?m?s//g; /BASE_EXIT|INTR_EXIT/d' "$OUT/base.log" > "$OUT/base.clean"
sed -E 's/[0-9]+(\.[0-9]+)?m?s//g; /BASE_EXIT|INTR_EXIT/d' "$OUT/intr.log" > "$OUT/intr.clean"
echo "=== RESULT hero-diff ==="
echo "base_exit: $(grep -o 'BASE_EXIT=[0-9]*' "$OUT/base.log")  intr_exit: $(grep -o 'INTR_EXIT=[0-9]*' "$OUT/intr.log")"
if diff -q "$OUT/base.clean" "$OUT/intr.clean" >/dev/null; then
  echo "RESULT hero: interrupted output CONTENT-IDENTICAL to baseline (timing values stripped)"
else
  echo "RESULT hero: output DIFFERS beyond timing — diff:"; diff "$OUT/base.clean" "$OUT/intr.clean" | head -40
fi
curl -s -X DELETE "$BASE/sandboxes/$WS" >/dev/null 2>&1
echo HERODIFFDONE
