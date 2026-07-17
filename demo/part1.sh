#!/usr/bin/env bash
# Demo part 1: install → boot → key-isolation proof → agent builds an app →
# preview URL serves it. Requires: Docker running, ~/.hotcell/provider.env with
# HOTCELL_PROVIDER_KEY_OPENROUTER, `npm` on PATH.
set -uo pipefail
source "$(dirname "$0")/lib.sh"
rm -f "$DEMO_STATE"

say "hotcell — sandboxes for AI agents, on your own hardware"
say "everything below is real: real daemon, real microVMs, real model"
blank

say "1/ install: one package = CLI + daemon"
run "npm install -g hotcell 2>&1 | tail -1"
run "hotcell --help | head -3"
blank

say "2/ boot the daemon. provider keys live HERE — never inside a sandbox"
run "set -a; source ~/.hotcell/provider.env; set +a   # OPENROUTER key, daemon-side only"
run "hotcelld > /tmp/hotcelld.log 2>&1 & sleep 2; curl -s localhost:4750/healthz"
blank

say "3/ create a sandbox wired to the LLM gateway — capped at \$1 of spend, ever"
run "SB=\$(hotcell create --image node:22-slim --egress --egress-spend-cap 1); echo \$SB"
say "the sandbox thinks it has an OpenRouter key. look closer:"
run "hotcell exec \$SB 'printenv OPENROUTER_API_KEY'"
say "that's a revocable token — the gateway swaps it for the real key in flight."
say "leak it, and it's worthless. the real key never entered the sandbox."
blank

say "4/ put an agent to work inside: OpenCode + Kimi K2.5, fully headless"
run "hotcell exec \$SB 'npm i -g opencode-ai 2>&1 | tail -1 && mkdir -p ~/.config/opencode && printf \"{\\\"provider\\\":{\\\"openrouter\\\":{\\\"options\\\":{\\\"baseURL\\\":\\\"%s/v1\\\",\\\"apiKey\\\":\\\"%s\\\"}}}}\" \"\$OPENROUTER_BASE_URL\" \"\$OPENROUTER_API_KEY\" > ~/.config/opencode/opencode.json'"
run "hotcell exec \$SB 'cd /workspace && HOME=/root opencode run -m openrouter/moonshotai/kimi-k2.5 --dangerously-skip-permissions \"Create index.html: a dark single-page hotcell status dashboard — headline, 4 metric cards (sandboxes, tokens, spend, uptime) with animated CSS bars, vanilla HTML/CSS/JS only. Also create server.js: a zero-dependency node http server that serves index.html on port 8000.\" 2>&1 | tail -5'"
run "hotcell files ls \$SB /workspace"
blank

say "5/ serve it and get a shareable preview URL"
run "hotcell start \$SB 'cd /workspace && node server.js'"
run "hotcell wait-port \$SB 8000"
run "hotcell expose \$SB 8000 | tee /tmp/expose-out.txt"
run "PREVIEW=\$(grep -o 'http://[^ ]*' /tmp/expose-out.txt | head -1); curl -s \$PREVIEW | grep -o '<title>.*</title>'"

echo "SB=$SB" > "$DEMO_STATE"
echo "PREVIEW=$PREVIEW" >> "$DEMO_STATE"
say "opening it in a browser…"
