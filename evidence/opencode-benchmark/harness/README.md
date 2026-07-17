# Harness

Scripts that run dax's OpenCode provider benchmark on hotcell Firecracker microVMs
and record the results. See `../README.md` for how to run them and the disclosures.

- **`bench-suite.sh`** — the ladder runner. Takes `CONFIGS` (a list of `MEM:CPU` guest
  configs), `REPS`, and `REGION`; creates a fresh microVM per run (cold, no reuse),
  samples peak guest memory, and classifies each outcome `PASS` / `OOM` / `INSTALL_FLAKE`
  / `ADMISSION` / `OTHER`. Writes full raw stdout per run + a `summary.tsv`. Per-exec and
  per-create timeouts keep one stalled guest from blocking the whole run.
- **`runbench.sh`** — guest-side wrapper: runs the benchmark while sampling
  `/proc/meminfo` `MemAvailable` every 0.3 s, so the peak working set is measured.
- **`bench-pauseresume.sh`** — Part B: the pause/resume fidelity contract (not run yet).
- **`bench-spike.sh`** — Part C: the thundering-herd / breaking-point test (not run yet).

Every published number traces back to a raw file under `../raw/<host>/`.
