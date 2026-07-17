# Artifact 1 — the Part A tweet (POST-READY; Sina posts)

Voice: lowercase, terse, no marketing. Category + cost + table + link. No methodology
assertion. Real CPU name, EPYC quirk footnoted. Numbers = per-phase median of 5 cold
reps (exact, unrounded). Link resolves (raw committed to evidence/).

---

not a provider — self-hosted infra you run yourself. ran the benchmark on a
**€0.36/hr hetzner auction box**. bare metal, `systemd-detect-virt=none`, real kvm.

| Provider | CPU / RAM | Region / CPU | Clone | Install | Typecheck | Workload total | Result |
|---|---|---|---:|---:|---:|---:|---|
| **hotcell** | 32 CPU / 31.37 GiB | hetzner HEL1, Ryzen 9 5950X | 4.336s | 13.437s | 17.415s | 35.188s | ✅ |

(the guest's `/proc` reports "AMD EPYC" under firecracker's cpuid; the real host cpu
is the Ryzen 9 5950X in the table.)

cold host, same stock script: typecheck **14.673s**

median of 5 cold reps (workload total 34.5–36.7s). raw evidence + bare-metal proof:
github.com/sinameraji/hotcell/tree/main/evidence/opencode-benchmark

---

## Notes for Sina (not part of the tweet)

- **Numbers:** per-phase median of 5 cold reps (34.49 / 35.11 / 35.39 / 35.57 / 36.73s
  totals). Tight ~6% spread — the earlier 41.7 was a post-reboot warmup rep, not noise.
  All 5 PASS, all pinned `cpus_allowed=0-31` (verified). Raw: evidence/…/32vcpu-5reps.txt.
- **Real CPU** in table (Ryzen 9 5950X); EPYC-under-CPUID footnoted. RAM 31.37 unrounded.
- **Cut** the methodology line; kept the host typecheck *number* (data).
- **IF ASKED "why is your sandbox 17% slower than your own metal?"** → the honest answer
  is **"the gap is real; we haven't isolated the cause yet"** (candidates: 31 GiB guest
  vs 125 GiB host page cache, virtio-block-on-file vs raw NVMe, virt overhead — a test at
  120 GiB guest will separate memory from virt). **Do NOT call it "the isolation tax."**
  That's unproven and could be mislabeling a memory config as product overhead.
- **Speed framing:** median ~35.2s is honestly the slowest of the three; typecheck 17.4s
  ties Namespace's 17.18; Cocoon's 14.9 is their newer 9700X. Win = category + €0.36/hr.
- Parts B–D (pause/resume = dax's req #3, spike, economics) = a SEPARATE follow-up post.
