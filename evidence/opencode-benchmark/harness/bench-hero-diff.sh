#!/bin/bash
# §1 correction, v2 — prove the typecheck RESULT survives a mid-run pause/resume.
#
# v1 flaw (kept in the raw for honesty): the baseline ran first and warmed the
# Turborepo cache, so the resumed run's log differed only in cache state
# ("cache miss, executing" vs "cache hit, replaying") plus a one-time telemetry
# banner — not a real output difference. v1 also echoed BASE_EXIT to the exec
# stream instead of the log, so the exit-code grep read nothing.
#
# v2: BOTH runs are cold (all .turbo dirs + node_modules/.cache/turbo removed
# before each run), telemetry disabled, and the verdict is SEMANTIC:
#   exit code + turbo "Tasks: N successful, N total" + "Cached:" line + TS error count.
# A sorted, timing-stripped content diff is reported as an informational appendix
# (parallel task interleaving makes raw line ORDER meaningless).
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
# CLEAN: force a fully cold turbo state (root + per-package .turbo dirs, both cache locations)
CLEAN='cd /workspace/bench/repo && rm -rf node_modules/.cache/turbo && find . -name .turbo -type d -prune -exec rm -rf {} + 2>/dev/null; true'
TC='cd /workspace/bench/repo && TURBO_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 PATH=/workspace/bench/bun/bin:$PATH bun typecheck'
echo "=== baseline (COLD cache, uninterrupted) -> base.log ==="
exj "$WS" "{\"command\":\"$CLEAN; $TC > /workspace/base.log 2>&1; echo BASE_EXIT=\$? >> /workspace/base.log; echo baseline done\"}"
echo "=== interrupted (COLD cache, pause mid-run, resume) -> intr.log ==="
exj "$WS" "{\"command\":\"$CLEAN; nohup sh -c '$TC > /workspace/intr.log 2>&1; echo INTR_EXIT=\$? >> /workspace/intr.log' >/dev/null 2>&1 & echo started\"}"
sleep 12; curl -s -X POST "$BASE/sandboxes/$WS/pause" >/dev/null; echo "paused mid-run"; sleep 5
curl -s -X POST "$BASE/sandboxes/$WS/start" >/dev/null; echo "resumed"
for i in $(seq 1 120); do [ "$(exj "$WS" '{"command":"grep -c INTR_EXIT /workspace/intr.log 2>/dev/null || echo 0"}')" = "1" ] && break; sleep 2; done
exj "$WS" '{"command":"cat /workspace/base.log"}' > "$OUT/base.log"
exj "$WS" '{"command":"cat /workspace/intr.log"}' > "$OUT/intr.log"
echo "=== RESULT hero-diff v2 ==="
bex=$(grep -o 'BASE_EXIT=[0-9]*' "$OUT/base.log" | tail -1 | cut -d= -f2)
iex=$(grep -o 'INTR_EXIT=[0-9]*' "$OUT/intr.log" | tail -1 | cut -d= -f2)
btasks=$(grep -E '^[[:space:]]*Tasks:' "$OUT/base.log" | tail -1 | tr -s ' ' | sed 's/^ //')
itasks=$(grep -E '^[[:space:]]*Tasks:' "$OUT/intr.log" | tail -1 | tr -s ' ' | sed 's/^ //')
bcache=$(grep -E '^[[:space:]]*Cached:' "$OUT/base.log" | tail -1 | tr -s ' ' | sed 's/^ //')
icache=$(grep -E '^[[:space:]]*Cached:' "$OUT/intr.log" | tail -1 | tr -s ' ' | sed 's/^ //')
berr=$(grep -c 'error TS' "$OUT/base.log")
ierr=$(grep -c 'error TS' "$OUT/intr.log")
echo "base: exit=$bex | $btasks | $bcache | TS_errors=$berr"
echo "intr: exit=$iex | $itasks | $icache | TS_errors=$ierr"
echo "cold check (both must show '0 cached'): base[$bcache] intr[$icache]"
if [ -n "$bex" ] && [ "$bex" = "$iex" ] && [ -n "$btasks" ] && [ "$btasks" = "$itasks" ] && [ "$berr" = "$ierr" ]; then
  echo "RESULT hero: SEMANTIC-IDENTICAL — same exit code ($bex), same task summary ($btasks), same TS error count ($berr)"
else
  echo "RESULT hero: SEMANTIC DIFFERS — see the two lines above"
fi
# informational appendix: sorted, timing-stripped content diff
cleanlog(){ sed -E 's/[0-9]+(\.[0-9]+)?m?s\b//g; /^[[:space:]]*Time:/d; /BASE_EXIT|INTR_EXIT/d; /[Tt]elemetry/d' "$1" | LC_ALL=C sort; }
cleanlog "$OUT/base.log" > "$OUT/base.sorted"
cleanlog "$OUT/intr.log" > "$OUT/intr.sorted"
if diff -q "$OUT/base.sorted" "$OUT/intr.sorted" >/dev/null; then
  echo "content check (informational): sorted timing-stripped logs IDENTICAL"
else
  echo "content check (informational): sorted logs differ — first 30 diff lines:"
  diff "$OUT/base.sorted" "$OUT/intr.sorted" | head -30
fi
curl -s -X DELETE "$BASE/sandboxes/$WS" >/dev/null 2>&1
echo HERODIFFDONE
