# Red-team video (v2)

`hotcell-redteam.mp4` — 51s, 1920x1080, no narration. `poster.png` = the airgap-killer frame.

## Three acts
1. **The attack** (two panes, same laptop). Both run the *byte-identical*
   `sh ./install.sh` (a dependency postinstall) - the only variable is which sandbox.
   LEFT (bare Docker / Docker Desktop / macOS): the real key is in the env; the
   attacker's collector flips to `count: 1` with the canary and a real source IP.
   RIGHT (hotcell microVM / Apple VZ / macOS): the env holds a `hc-...` token; the
   same attack hits `Network unreachable`; `count: 0`.
2. **"...but isn't that just an airgap?"** The hotcell microVM has `ip link` = `lo`
   only - no network card - yet a real Kimi K2.5 completion **returns over vsock,
   cost $0.00064**. Zero network interface, agent still works. *That is containment,
   not an airgap.* This is the shot that kills the `docker run --network none` comment.
3. **End card** - "There was nothing to steal - and it couldn't leave anyway."

## What changed from v1 (all four review notes)
- Added the "agent still works" act - proves containment, not just a firewall.
- Byte-identical attack - both panes run the same install.sh, one variable changed.
- Platform labels + "same laptop" - Docker Desktop vs Apple VZ, both on one Mac.
- Real artifacts - real attacker IP 34.27.205.78, real captured JSON with a real
  source IP (133.106.74.178), real timestamps. No evil/attacker.example placeholders.

## Honesty
Results are verbatim from the real runs (canary captured count 1 vs 0; the token;
Network unreachable; ip link = lo only; the live completion + cost). Terminals are
authored playbacks of those real results, timed for watchability; the stolen key is
a canary (fake). Exact reproducible commands: ../../evidence/. Rebuild scripts:
left.sh / right.sh / agent.sh + install.sh (asciinema -> agg -> ffmpeg + PIL cards).

## Premium version (10/10)
For motion-grade polish, record the same real script in Ghostty/Warp with Screen
Studio (auto chrome + zoom). This pipeline caps at "clean, framed terminal"; the
scripts here are the shooting script.
