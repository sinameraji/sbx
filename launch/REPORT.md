# Launch evidence — report (§8)

Status: evidence gathered, code fix shipped, drafts ready. **Nothing published.**
Every public action is yours to take.

## §1 — the launch-blocker fix: SHIPPED (v0.1.3)

The dry run's first `create` failed 422 — a stale pre-rename `sbx-egress` Docker
network squatting the enforcement subnet. Fixed and released:
- The daemon now reconciles at startup: adopt our own network, remove an *idle,
  hotcell-managed* stale one and recreate, or **fail loudly** naming a foreign /
  in-use network + the `HOTCELL_EGRESS_SUBNET` override (never deletes anything a
  user might own). Regression test `check:netreconcile` (both scenarios) in CI.
- Bonus footgun also fixed: on native Linux the egress gateway auto-binds
  `0.0.0.0` under enforcement (a loopback bind is unreachable from sandboxes →
  every outbound call ECONNREFUSED). Both fixes validated live on the box.
- Published: **hotcell / @hotcell/* 0.1.3 on npm, hotcell 0.1.3 on PyPI.**

## §2 + §3 — the attack matrix (4 cells + macOS)

Setup: hotcell host (Linux, enforce on, real key on the daemon) + a **separate**
attacker VM running a collector. Canary key = `sk-or-v1-CANARY0000…` (fake).

| Vector | Bare Docker | hotcell (Linux) |
|---|---|---|
| **Malicious npm dependency** (deterministic) | 🔑 **LEAKED** — collector `count: 1`, canary captured, `from: 10.128.0.13` | 🔒 **0** — env holds `hc-2c64e899…` (token, not key); postinstall exfil blocked; collector `count: 0` |
| **Prompt injection** (model-dependent) | moot (model declined) | **model declined** — Kimi K2.5 summarized the repo and ignored the hidden exfil instruction (verbatim in evidence) |

**macOS / Apple VZ cell (the strongest):**
```
$ ip link                → 1: lo: <LOOPBACK,UP>   (the only interface)
$ ls /sys/class/net      → lo
$ wget http://<attacker> → wget: can't connect: Network unreachable
$ echo $OPENROUTER_API_KEY → hc-fc573158…   (token, not key)
$ <LLM call over vsock>  → real Kimi K2.5 completion, cost $0.00028
```
The guest has **no network device**. The exfil isn't blocked — it's impossible.
The agent still works, over vsock. This converts the "your stage is a privileged
Linux box, my laptop is a Mac" objection into our best line.

Raw logs: `evidence/vector2-dependency/`, `evidence/vector1-injection/`,
`evidence/macos-vz/`. Reproduction: `evidence/README.md`.

### The surprising / unflattering results (led with, per §8)
1. **The prompt injection did NOT land** on the model I tested. Kimi declined it
   across the placements I could cleanly capture. Honest and publishable — and it
   selects the dependency-based title. We are not claiming an agent chose to steal.
2. **OpenCode's agentic runs wouldn't transcript-capture headless** (needs a TTY;
   even PTY-wrapping failed in the harness), so the full-agent injection cell is
   inconclusive, not a refusal. Reported as a limitation, not spun as a win.
3. The dry run caught **two real config footguns** (stale-network 422 + loopback
   gateway bind) that any Linux adopter would have hit. Both are now fixed and
   shipped — that's the §1 work, and it's the kind of thing that matters more than
   the demo.

## §4 — framing: `launch/framing.md` (two locks; attack a belief, not a company)
## §5 — title: recommend **"Nobody escaped the sandbox. The API key left anyway."**
Reasoning in `launch/title-options.md`. (If a re-run with a stronger agent lands
the injection, switch to "The prompt injection worked. The exfiltration didn't.")
Show HN, separate: "Show HN: Hotcell – agent sandboxes where the API key never
enters the sandbox."
## §6 — video: `launch/video-shotlist.md` (60–90s, two panes, no narration)
## §7 — first comment: `launch/first-comment.md` (paste by hand after you submit)

## Housekeeping
- Attacker VM `hotcell-attacker` (GCP) is still up with an external IP for the
  collector — tear it down when the video's shot (`gcloud compute instances
  delete hotcell-attacker --zone=us-central1-a`).
- The hotcell host `sbx-test-linux` is running the enforce daemon; leave or stop.
