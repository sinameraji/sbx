# Red-team video

`hotcell-redteam.mp4` — 36s, no narration, two panes. `poster.png` = the verdict frame.

**What it shows (verbatim results from the real local runs):**
- LEFT (bare Docker): the real provider key is in the env; a dependency's
  postinstall exfiltrates it; the attacker's collector flips to `count: 1` with
  the canary. 🔑 KEY LEAKED.
- RIGHT (hotcell microVM): the env holds a `hc-…` token, not the key; the same
  attack hits `Network unreachable` — `ip link` shows only `lo`, no network
  card; collector stays `count: 0`. 🔒 keys leaked: 0.

**Honesty note:** results (the captured canary, count 1 vs 0, the token, the
`Network unreachable` failure, `ip link` = lo only) are verbatim from the real
runs captured in `../../evidence/`. Command forms are lightly shortened for
on-screen readability (e.g. hostnames shown as `attacker.example`/`evil`); the
exact reproducible commands are in `../../evidence/README.md`. The stolen key is
a canary — shaped like a real OpenRouter key, deliberately fake.

Rebuild: the two pane player scripts are `left.sh` / `right.sh`
(`asciinema rec … -c "bash left.sh"` → `agg` → `ffmpeg` hstack + PIL title/endcard).
