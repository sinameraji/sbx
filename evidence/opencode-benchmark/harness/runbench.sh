#!/bin/bash
# Guest-side wrapper: run dax's provider-benchmark.sh while sampling whole-guest
# memory so we can report the true peak working set (the floor for this workload)
# — measured, not guessed. tsgo is a Go binary whose heap tracks the working set,
# so this peak is stable across RAM sizes and pins the memory floor from one run.
( while :; do awk '/MemAvailable/{print $2}' /proc/meminfo; sleep 0.3; done ) > /tmp/mem.log 2>/dev/null &
S=$!
cd /tmp
BENCH_PROVIDER="${BENCH_PROVIDER:-hotcell}" BENCH_REGION="${BENCH_REGION:-unknown}" \
  BENCH_ROOT=/workspace/bench bash /tmp/pb.sh 2>&1
RC=$?
kill "$S" 2>/dev/null
TOTAL=$(awk '/MemTotal/{print $2}' /proc/meminfo)
MIN=$(sort -n /tmp/mem.log 2>/dev/null | head -1)
[ -z "$MIN" ] && MIN=$TOTAL
echo "BENCH_MEM	total_kib	$TOTAL"
echo "BENCH_MEM	min_avail_kib	$MIN"
echo "BENCH_MEM	peak_used_kib	$((TOTAL - MIN))"
awk -v x="$((TOTAL - MIN))" 'BEGIN{printf "BENCH_MEM\tpeak_used_gib\t%.2f\n", x/1048576}'
exit "$RC"
