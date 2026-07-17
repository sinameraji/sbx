# First HN comment — DRAFT ONLY (you paste this by hand, seconds after you submit)

<!--
  Founder voice. Factual, short. No marketing. No links beyond the submission.
  This is the author's own reply-to-self giving context + limitations.
-->

Author here. A few honest notes so nobody has to reverse-engineer them:

The key that "leaks" on the bare-Docker side is a canary — shaped like a real
OpenRouter key, deliberately fake. Burning a live key on camera would be dumb.
The real key sits on the daemon and never enters a sandbox; the sandbox only ever
holds a revocable token (the `hc-...` string in the demo).

There are two independent things happening, and either one alone stops the theft:
(1) there's nothing real in the sandbox to steal, and (2) egress is default-deny,
so even the worthless token can't leave. An attacker has to beat both.

Limitations, stated plainly:
- Lock 2 (default-deny egress) is kernel-enforced only on Linux, with a
  privileged daemon — it's iptables underneath. On macOS the container driver's
  enforcement is advisory. The real answer on a Mac is the microVM driver, where
  the guest has *no network interface at all* — the exfil there isn't blocked,
  it's impossible (there's literally no eth0; `ip link` shows only loopback).
- I tried a live prompt-injection (hide the exfil instruction in a file the agent
  reads). The model I tested declined it — it just summarized the repo and
  ignored the instruction. So I'm NOT claiming an agent chose to steal. The
  vector that actually leaks needs no cooperation: a dependency's postinstall
  script. That's the demo.

The obvious objection is "this is just an egress firewall plus a key vault, we've
had those for 30 years." Correct. The mechanism is old. The only claim I'm making
is that no agent sandbox ships them turned on by default, self-hosted, with a
per-sandbox spend cap. The novelty is the absence, not the invention.

What I'd love feedback on: whether the default-deny + token-swap model breaks any
real agent workflow you care about, and whether the microVM (no-NIC) path is the
right default on macOS. Still in progress: warm-pool tuning and the spend-cap UX.

It's Apache-2.0 and runs on your own box. Repro steps and raw logs are in the repo.
