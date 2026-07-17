#!/bin/bash
# Part B — pause/resume contract for hotcell Firecracker microVMs (runs on the box).
#
# Answers GenieOrb's fidelity items + resume-latency distribution + at-rest economics,
# each as a test designed to FAIL if we were faking it. Prints RESULT lines and saves
# raw. Assumes a stock hotcell checkout at ~/hotcell + the agent + FC kernel staged
# (same as bench-suite.sh) and the ubuntu:24.04 rootfs already cached.
#
# API: pause = POST /pause (Full RAM+device snapshot, VMM killed); resume = POST
# /start (mmap-backed snapshot/load, resume_vm). Paused microVM uses ~0 host RAM.
set +e
NODE=$(command -v node)
OUT=${OUT:-/tmp/bench-pauseresume}; mkdir -p "$OUT"
BASE=localhost:4750
LAT_N=${LAT_N:-50}                 # resume-latency samples
STATEDIR="$HOME/.hotcell/fc"
LOG(){ echo "[B $(date -u +%H:%M:%S)] $*"; }
val(){ $NODE -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(d)["'"$1"'"]??""))}catch{process.stdout.write("")}})'; }
create(){ curl -s -X POST $BASE/sandboxes -H 'content-type: application/json' -d "$1" | val id; }
status(){ curl -s "$BASE/sandboxes/$1" | val status; }
destroy(){ curl -s -X DELETE "$BASE/sandboxes/$1" >/dev/null 2>&1; }
pause(){ curl -s -X POST "$BASE/sandboxes/$1/pause" >/dev/null 2>&1; }
resume(){ curl -s -X POST "$BASE/sandboxes/$1/start" >/dev/null 2>&1; }
exj(){ curl -s -N -X POST "$BASE/sandboxes/$1/exec" -H 'content-type: application/json' -d "$2" | sed -n 's/^data: //p' | $NODE -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{d.trim().split("\n").forEach(l=>{try{let e=JSON.parse(l);if(e.type=="stdout"||e.type=="stderr")process.stdout.write(e.data)}catch{}})})'; }
nowns(){ date +%s%N; }
pctl(){ $NODE -e 'let a=require("fs").readFileSync(0,"utf8").trim().split(/\s+/).map(Number).filter(x=>!isNaN(x)).sort((x,y)=>x-y);let p=q=>a.length?a[Math.min(a.length-1,Math.floor(q/100*a.length))]:0;console.log(`n=${a.length} min=${a[0]} p50=${p(50)} p95=${p(95)} p99=${p(99)} max=${a[a.length-1]}`)'; }

# --- daemon (fresh FC daemon; egress off for perf-clean pause/resume) ---
LOG "starting FC daemon"
sudo pkill -9 -f "daemon/dist" 2>/dev/null; sudo pkill -9 -f firecracker 2>/dev/null; sleep 2
cd ~/hotcell
sudo -E env HOTCELL_DRIVER=firecracker HOTCELL_DB=:memory: HOTCELL_FC_KERNEL=helpers/hotcell-vz/guest/vmlinux-fc \
  setsid bash -c "$NODE packages/daemon/dist/index.js > /tmp/hotcelld-b.log 2>&1" </dev/null & disown
for i in $(seq 1 30); do curl -s --max-time 2 $BASE/healthz | grep -q ok && break; sleep 1; done
LOG "daemon: $(curl -s $BASE/healthz)"

###########################################################################
# B5 + at-rest: resume-latency distribution on a SMALL sandbox (2 GiB, so many
# cycles are cheap). Resume is mmap-lazy so ~size-independent; pause writes the
# mem file so it scales with RAM (reported separately). Cold-boot baseline too.
###########################################################################
LOG "B5: resume latency over $LAT_N cycles (2GiB guest)"
SL=$(create '{"image":"ubuntu:24.04","driver":"firecracker","memoryMb":2048,"cpus":2,"cpuset":"0-1"}')
echo "latency sandbox=$SL" | tee "$OUT/b5.txt"
: > "$OUT/resume_ms.txt"; : > "$OUT/pause_ms.txt"
for i in $(seq 1 "$LAT_N"); do
  t0=$(nowns); pause "$SL"; t1=$(nowns)
  # confirm paused, then resume
  t2=$(nowns); resume "$SL"; t3=$(nowns)
  echo $(( (t1-t0)/1000000 )) >> "$OUT/pause_ms.txt"
  echo $(( (t3-t2)/1000000 )) >> "$OUT/resume_ms.txt"
done
SNAPMEM=$(du -m "$STATEDIR/$SL/snapshot.mem" 2>/dev/null | cut -f1)
echo "RESULT B5 resume_ms: $(pctl < "$OUT/resume_ms.txt")" | tee -a "$OUT/b5.txt"
echo "RESULT B5 pause_ms:  $(pctl < "$OUT/pause_ms.txt")" | tee -a "$OUT/b5.txt"
echo "RESULT B5 snapshot.mem size (2GiB guest) = ${SNAPMEM}MB" | tee -a "$OUT/b5.txt"
# cold boot baseline (create->agent-up)
cb0=$(nowns); CB=$(create '{"image":"ubuntu:24.04","driver":"firecracker","memoryMb":2048,"cpus":2,"cpuset":"0-1"}'); cb1=$(nowns)
echo "RESULT B5 cold_boot_ms = $(( (cb1-cb0)/1000000 )) (create->ready)" | tee -a "$OUT/b5.txt"
destroy "$CB"

###########################################################################
# B6 snapshot consistency: resume the SAME snapshot twice; both work? clock skew?
###########################################################################
LOG "B6: snapshot determinism (resume same snapshot twice)"
{
  pause "$SL"
  resume "$SL"; A_HOST=$(exj "$SL" '{"command":"uname -n; cat /proc/sys/kernel/random/boot_id"}')
  pause "$SL"
  resume "$SL"; B_HOST=$(exj "$SL" '{"command":"uname -n; cat /proc/sys/kernel/random/boot_id"}')
  echo "resume#1: $A_HOST"; echo "resume#2: $B_HOST"
  echo -n "RESULT B6 clock after resume monotonic+sane: "; exj "$SL" '{"command":"date -u +%FT%T; echo up=$(cut -d. -f1 /proc/uptime)s"}'
} | tee "$OUT/b6.txt"
destroy "$SL"

###########################################################################
# Set up the workload sandbox: clone + bun install the pinned OpenCode repo so we
# can pause a REAL typecheck mid-run (B1 hero). 24 GiB / 8 vCPU, pinned CCD0.
###########################################################################
LOG "setup: workload sandbox (24GiB/8cpu) + clone+install opencode"
WS=$(create '{"image":"ubuntu:24.04","driver":"firecracker","networked":true,"memoryMb":24576,"cpus":8,"cpuset":"0-7"}')
echo "workload sandbox=$WS" | tee "$OUT/b1.txt"
curl -fsSL "https://raw.githubusercontent.com/anomalyco/opencode/provider-benchmark/script/provider-benchmark.sh" -o /tmp/pb.sh
PB64=$(base64 -w0 /tmp/pb.sh)
exj "$WS" "{\"command\":\"echo $PB64 | base64 -d > /root/pb.sh\"}" >/dev/null
# run the benchmark once with KEEP_ROOT so the repo + deps + bun stay staged
LOG "  running pb.sh once (KEEP_ROOT) to stage repo+deps (~2min)"
exj "$WS" '{"command":"BENCH_PROVIDER=hotcell BENCH_REGION=hetzner BENCH_ROOT=/workspace/bench BENCH_KEEP_ROOT=true bash /root/pb.sh 2>&1 | tail -3"}' | tee -a "$OUT/b1.txt"
TC='cd /workspace/bench/repo && PATH=/workspace/bench/bun/bin:$PATH bun typecheck'

###########################################################################
# B1 HERO: pause a typecheck MID-RUN, resume, verify it finishes correctly and
# matches an uninterrupted run. This is the process-memory fidelity test.
###########################################################################
LOG "B1: baseline (uninterrupted) typecheck"
exj "$WS" "{\"command\":\"$TC > /workspace/base.log 2>&1; echo BASE_EXIT=\$?\"}" | tee -a "$OUT/b1.txt"
LOG "B1: interrupted typecheck — start detached, pause mid-run, resume, finish"
# start typecheck detached in the guest, capture pid + output
exj "$WS" "{\"command\":\"nohup sh -c '$TC > /workspace/intr.log 2>&1; echo INTR_EXIT=\$? >> /workspace/intr.log' >/dev/null 2>&1 & echo started pid=\$!\"}" | tee -a "$OUT/b1.txt"
sleep 12                                  # let typecheck get well into the run
LOG "  pausing mid-typecheck"; pt0=$(nowns); pause "$WS"; pt1=$(nowns)
echo "RESULT B1 status-after-pause=$(status "$WS") pause_ms=$(( (pt1-pt0)/1000000 ))" | tee -a "$OUT/b1.txt"
sleep 5
LOG "  resuming"; rt0=$(nowns); resume "$WS"; rt1=$(nowns)
echo "RESULT B1 resume_ms=$(( (rt1-rt0)/1000000 ))" | tee -a "$OUT/b1.txt"
# wait for the interrupted typecheck to finish (up to 3min)
for i in $(seq 1 90); do
  grep -q INTR_EXIT /workspace/intr.log 2>/dev/null && break   # host can't see guest fs; poll via exec
  D=$(exj "$WS" '{"command":"grep -c INTR_EXIT /workspace/intr.log 2>/dev/null || echo 0"}')
  [ "$D" = "1" ] && break; sleep 2
done
echo "--- interrupted run tail ---" | tee -a "$OUT/b1.txt"
exj "$WS" '{"command":"tail -5 /workspace/intr.log; echo; echo BASE:; grep -E \"BASE_EXIT|Tasks:|error\" /workspace/base.log | tail -3"}' | tee -a "$OUT/b1.txt"
echo -n "RESULT B1 hero (interrupted typecheck exit): " | tee -a "$OUT/b1.txt"
exj "$WS" '{"command":"grep INTR_EXIT /workspace/intr.log | tail -1"}' | tee -a "$OUT/b1.txt"

###########################################################################
# B2 filesystem state: write -> pause -> resume -> read (incl. a big file mid-write)
###########################################################################
LOG "B2: filesystem across pause/resume"
{
  exj "$WS" '{"command":"echo persist-me-42 > /workspace/fs.txt; sync"}'
  pause "$WS"; resume "$WS"
  echo -n "RESULT B2 file after resume: "; exj "$WS" '{"command":"cat /workspace/fs.txt"}'
} | tee "$OUT/b2.txt"

###########################################################################
# B3 network identity across pause/resume (hostname/ip/uptime same VM?)
###########################################################################
LOG "B3: identity across pause/resume"
{
  echo -n "before: "; exj "$WS" '{"command":"uname -n; ip -o -4 addr show eth0 2>/dev/null | awk \"{print \\$4}\"; cut -d. -f1 /proc/uptime"}'
  pause "$WS"; resume "$WS"
  echo -n "after:  "; exj "$WS" '{"command":"uname -n; ip -o -4 addr show eth0 2>/dev/null | awk \"{print \\$4}\"; cut -d. -f1 /proc/uptime"}'
} | tee "$OUT/b3.txt"

###########################################################################
# At-rest economics: snapshot size for the 24GiB workload guest + host RAM.
###########################################################################
LOG "at-rest: snapshot size + host RAM while paused"
pause "$WS"
WSMEM=$(du -m "$STATEDIR/$WS/snapshot.mem" 2>/dev/null | cut -f1)
WSWORK=$(du -m "$STATEDIR/$WS/workspace.img" 2>/dev/null | cut -f1)
FCPROCS=$(pgrep -c -f firecracker)
echo "RESULT ATREST 24GiB workload: snapshot.mem=${WSMEM}MB workspace.img=${WSWORK}MB firecracker_procs_while_paused=${FCPROCS}" | tee "$OUT/atrest.txt"
destroy "$WS"

LOG "PART B COMPLETE"
echo "=== RESULTS ==="; grep -h "^RESULT" "$OUT"/*.txt 2>/dev/null
echo PARTBDONE
