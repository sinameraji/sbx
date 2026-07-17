# Artifact 1 — the Part A tweet (POST-READY; Sina posts)

Voice: lowercase, terse, no marketing. Category + cost + table + link. No methodology
assertion. Real CPU name, EPYC quirk footnoted. Numbers = per-phase median of 5 cold
reps (exact, unrounded). Link resolves (raw committed to evidence/).

---

not a provider — self-hosted infra you run yourself. ran the benchmark on a
**€0.36/hr hetzner auction box**. bare metal, `systemd-detect-virt=none`, real kvm.

| Provider | CPU / RAM | Region / CPU | Clone | Install | Typecheck | Workload total | Result |
|---|---|---|---:|---:|---:|---:|---|
| **hotcell** | 32 CPU / 31.37 GiB | hetzner HEL1, Ryzen 9 5950X | 5.055s | 13.492s | 16.838s | 35.385s | ✅ |

(the guest's `/proc` reports "AMD EPYC" under firecracker's cpuid; the real host cpu
is the Ryzen 9 5950X in the table.)

cold host, same stock script: typecheck **14.673s**

median of 5 cold reps · range 34.5–36.7s. raw evidence + bare-metal proof:
github.com/sinameraji/hotcell/tree/main/evidence/opencode-benchmark

---

## Notes for Sina (not part of the tweet)

- **Numbers = the median RUN (r2), not composite.** 5 totals: 34.49 / 35.11 / 35.39 /
  35.57 / 36.73s → median run = 35.385s (r2), its own clone/install/typecheck, arithmetic
  checks. All 5 PASS, all pinned `cpus_allowed=0-31`. Raw: evidence/…/32vcpu-5reps.txt.
- **No warmup narrative.** The earlier one-off 41.7 is unexplained — the new run's rep 1
  (35.57) is dead-average, so "warmup" doesn't fit. Honest line: don't know what 41.7 was;
  the clean box then produced 5 tight reps (34.5–36.7, ~6% spread). That's the publishable set.
- **Real CPU** in table (Ryzen 9 5950X); EPYC-under-CPUID footnoted. RAM 31.37 unrounded.
- **Cut** the methodology line; kept the host typecheck *number* (data).
- **IF ASKED "why is your sandbox 17% slower than your own metal?"** → the honest answer
  is **"the gap is real; we haven't isolated the cause yet"** (candidates: 31 GiB guest
  vs 125 GiB host page cache, virtio-block-on-file vs raw NVMe, virt overhead — a test at
  120 GiB guest will separate memory from virt). **Do NOT call it "the isolation tax."**
  That's unproven and could be mislabeling a memory config as product overhead.
- **Speed framing:** the win is category + €0.36/hr self-hosted, not raw speed. Don't
  oversell the row.
- Parts B–D (pause/resume = dax's req #3, spike, economics) = a SEPARATE follow-up post.
