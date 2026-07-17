# Launch framing (internal — the argument, not the copy)

> Governing rule: we publish what happened, including what didn't. A hostile
> reader must be able to re-run `evidence/` and get the same output.

## The one idea: two independent locks

An agent's API key never has to leave a sandbox, and here is proof that it
doesn't — twice over. When we told a compromised process inside a hotcell
sandbox to steal the key and mail it to an attacker's server, it failed for two
independent reasons, either of which alone defeats the attack:

- **Lock 1 — there was nothing real to steal.** The sandbox held
  `hc-2c64e899…`, a revocable token, not the provider key. The real key lives on
  the daemon and is swapped in on the way out.
- **Lock 2 — even the worthless token couldn't leave.** Egress is default-deny;
  the connection to the attacker was refused / had no route.

An attacker must break **both**. Lock 1 makes theft pointless; Lock 2 makes
exfiltration impossible. Lead with this everywhere — it is stronger than any
line currently on the landing page.

## What we are attacking: a belief, not a company

The belief in the market is **isolation == containment**. The finding is that
the attack never had to escape anything:

- The container was never breached. The kernel was never touched.
- The agent used the network it was *always allowed to use*, and (in the naive
  setup) the key walked out the front door.

Containment is not isolation. A sandbox that isolates the process but hands it
your key and an open network has contained nothing that matters. That is the
awkward question every vendor's users start asking on their own — we never have
to ask it for them.

## Rules of engagement (do not break)

- **Never name a competitor as a target.** Not E2B, Daytona, OpenCode, dax,
  Cloudflare, Modal, Vercel, Fly, anyone. The victim in every demo is *our own
  key in our own Docker container*. Nobody gets a grievance.
- **Never claim we invented sandboxes.** In any asset, ever. Sandboxes,
  egress firewalls, and key vaults are old. Our claim is narrow and true: *no
  agent sandbox ships them on by default, self-hosted, with a spend cap.* The
  novelty is the absence in the market, not the mechanism.
- **Concede the mechanism up front.** The strongest pre-emption of "this is just
  an egress firewall + a key vault, we've had those for 30 years" is: *yes —
  and not one agent sandbox turns them on for you.* The argument is over before
  it starts.

## The honesty ledger (published, not hidden)

- The stolen key on camera is a **canary**: shaped like a real OpenRouter key,
  deliberately fake. Burning a live key on camera is stupid.
- Lock 2 (default-deny egress) is **kernel-enforced only on Linux with a
  privileged daemon** (it needs iptables). On macOS the container driver's
  enforcement is advisory — and the answer there is the microVM driver, where
  the guest has **no network interface at all** (`evidence/macos-vz/`). That
  turns our worst caveat into our best line.
- Lock 1 (key never in the sandbox) holds on **every** platform, always.

## Evidence map (each claim → a file a stranger can re-run)

| Claim | Evidence |
|---|---|
| Bare Docker leaks the key (malicious dependency) | `evidence/vector2-dependency/` (bare-docker leg: collector count 1) |
| hotcell blocks the same attack | `evidence/vector2-dependency/` (hotcell leg: token not key, count 0) |
| macOS microVM guest has no network interface | `evidence/macos-vz/` (`ip link` = lo only; exfil = "Network unreachable"; live LLM call still works over vsock) |
| The prompt-injection vector | `evidence/vector1-injection/` (what the model actually did — see report) |
