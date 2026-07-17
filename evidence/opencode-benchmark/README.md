# OpenCode provider benchmark — hotcell evidence

Raw results and the harness for running dax's OpenCode provider benchmark
(`anomalyco/opencode` @ `provider-benchmark`, `script/provider-benchmark.sh`) on
hotcell Firecracker microVMs. Everything here is measured; nothing is
extrapolated. Full raw stdout for every run is preserved under `raw/`.

The benchmark is run **verbatim** — we never edit dax's script. It clones a
pinned OpenCode commit, `bun install`s it, and `bun typecheck`s it (a *build*
workload; OpenCode is never executed as an agent, no LLM calls). It reports
`BENCH_META` / `BENCH_CACHE` / `BENCH_DISK` / `BENCH_PHASE` lines and a markdown
table. Workload total = clone + install + typecheck.

## What "good" means here

This is a filter, not a leaderboard. A green row from one big config is
cherry-picking; the useful artifact is the **demand curve** — the memory floor
below which the workload dies at typecheck, the CPU knee beyond which more cores
stop helping, and the at-rest economics dax actually needs for a large, spiky
userbase. Every rung, including every failure, is published.

## Layout

- `harness/bench-suite.sh` — runs a list of `MEM:CPU` guest configs, `REPS` times
  each, cold (fresh microVM per run), samples peak guest memory, and classifies
  each outcome: `PASS` / `OOM` / `INSTALL_FLAKE` / `ADMISSION` / `OTHER`. Writes
  full raw stdout per run + a `summary.tsv`. Never retries-until-green.
- `harness/runbench.sh` — guest-side wrapper: runs the benchmark while sampling
  `/proc/meminfo` `MemAvailable` every 0.3 s, so peak working set is measured.
- `raw/<host>/` — full stdout per run, named `mem<MB>_cpu<N>_<RESULT>.txt`.

## Host requirements & not-nested proof

The headline runs are on **bare metal** (real KVM, NVMe physically in the box).
Before any run, record and commit:

```bash
lscpu; free -h; uname -r
lsblk -d -o NAME,MODEL,TRAN,SIZE          # TRAN=nvme, disk in-chassis
ls -l /dev/kvm                            # must exist
systemd-detect-virt                       # must print: none  (bare metal)
```

If `systemd-detect-virt` is anything but `none`, the run is labeled as such. The
`gcp-n2-nested/` rows are exactly that — the same ladder on a **nested-virt**
shared cloud VM — kept only to quantify the nesting tax against bare metal.

## Reproduce

On a fresh Ubuntu bare-metal host with Docker, Node ≥22, Firecracker + `/dev/kvm`:

```bash
# one-time: put the guest agent somewhere reboot-persistent, clone hotcell
scp hotcell-agent-linux-amd64 <host>:~/            # or build: agent/ (go build)
git clone https://github.com/sinameraji/hotcell.git ~/hotcell

# memory ladder (fixed 8 vCPU), 3 cold runs per rung:
CONFIGS="4096:8 6144:8 8192:8 12288:8 16384:8 32768:8" REPS=3 REGION=hetzner-ax102 \
  bash ~/hotcell/evidence/opencode-benchmark/harness/bench-suite.sh

# CPU ladder (fixed RAM at floor+1 rung), 3 cold runs per rung:
CONFIGS="16384:2 16384:4 16384:8 16384:16" REPS=3 REGION=hetzner-ax102 \
  bash ~/hotcell/evidence/opencode-benchmark/harness/bench-suite.sh

# same, with default-deny egress ON + the minimal allowlist delta (Part A3):
EGRESS=1 ALLOWLIST_EXTRA="nodejs.org,..." CONFIGS="16384:8" REPS=3 \
  bash ~/hotcell/evidence/opencode-benchmark/harness/bench-suite.sh
```

Results land in `/tmp/bench-suite/` (raw per run + `summary.tsv`); copy them into
`raw/<host>/` and commit.

## Disclosure

- **Cold caches.** The benchmark drops the guest page cache (`echo 3 >
  /proc/sys/vm/drop_caches`) and prints `BENCH_CACHE guest_page_cache dropped`.
  On a real kernel (Firecracker microVM) this succeeds — the numbers are truly
  cold. A container that can't drop caches prints `unavailable`; its "cold"
  number is warmed by the host page cache. Confirm every run shows `dropped`.
- **node-gyp fidelity shim.** The benchmark installs Node at runtime and symlinks
  `node`/`npm` but not `node-gyp`. If a native-module prebuilt fetch misses,
  `bun install` falls back to a source build and, with no `node-gyp` on PATH,
  hard-crashes (`spawn node-gyp ENOENT`) — which surfaces as a *typecheck*
  failure even though it's a network/toolchain issue. The hotcell guest image
  puts npm's bundled `node-gyp` on PATH (`helpers/hotcell-vz/convert-image.sh`)
  so the guest is a faithful build environment and the memory ladder measures
  memory, not network luck. This touches no workload and no isolation code.
- **Egress.** Where noted, runs are with default-deny egress ON. The denial log
  and the minimal `HOTCELL_ALLOWLIST_EXTRA` needed to complete are recorded — the
  point is: same number, produced with egress enforcement on.
- **Guest specs are the guest's.** The table reads the guest's own `/proc`, so
  `CPU / RAM` is the microVM's, never the host's. The host is deliberately larger.
