#!/usr/bin/env bash
# Records the full demo: two asciinema casts around a Playwright browser clip,
# rendered and stitched into demo/out/hotcell-demo.mp4 (+ .gif of part 1).
#
# Prereqs: asciinema, agg, ffmpeg, a playwright install (PLAYWRIGHT_DIR),
# Docker running, ~/.hotcell/provider.env with the OpenRouter key.
set -euo pipefail
cd "$(dirname "$0")"
OUT="out"; rm -rf "$OUT"; mkdir -p "$OUT"
export DEMO_STATE=/tmp/hotcell-demo-state.env

echo "[record] part 1 (install → build → preview)…"
asciinema rec --cols 110 --rows 30 --overwrite -c "bash part1.sh" "$OUT/part1.cast"

echo "[record] browser beat (playwright)…"
source "$DEMO_STATE"
WEBM=$(node browser.js "$P