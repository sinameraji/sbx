#!/usr/bin/env bash
#
# Run a coding task with OpenCode inside a throwaway sbx sandbox — the sandbox is
# created, the repo is cloned in, OpenCode runs headless via OpenRouter, and the
# sandbox is destroyed when done. OpenRouter is reached through the sbx egress
# gateway, so your real key stays on the daemon and never enters the sandbox.
#
# Prereqs:
#   1. Daemon running with your OpenRouter key on the host:
#        SBX_PROVIDER_KEY_OPENROUTER=sk-or-... node packages/daemon/dist/index.js
#   2. A base image with node + git:
#        docker build -t sbx/base:latest images/base
#
# Usage:
#   examples/opencode.sh <repo-url> "<task>" [openrouter/model]
#
# Example:
#   examples/opencode.sh https://github.com/me/app "add a /health route and run the tests"
set -euo pipefail

REPO="${1:?usage: opencode.sh <repo-url> \"<task>\" [openrouter/model]}"
TASK="${2:?usage: opencode.sh <repo-url> \"<task>\" [openrouter/model]}"
MODEL="${3:-openrouter/anthropic/claude-3.5-sonnet}"
DIR="/workspace/$(basename "$REPO" .git)"
SB="${SBX_CLI:-node $(cd "$(dirname "$0")/.." && pwd)/packages/cli/dist/index.js}"

# Setup runs in the sandbox (which already has $OPENROUTER_BASE_URL / $OPENROUTER_API_KEY
# injected by --egress): install OpenCode and point its OpenRouter provider at the
# egress gateway. Single-quoted so the $VARS resolve in the sandbox, not here.
SETUP='npm i -g opencode-ai >/dev/null 2>&1 \
  && mkdir -p ~/.config/opencode \
  && printf "{\"provider\":{\"openrouter\":{\"options\":{\"baseURL\":\"%s/v1\",\"apiKey\":\"%s\"}}}}" \
       "$OPENROUTER_BASE_URL" "$OPENROUTER_API_KEY" > ~/.config/opencode/opencode.json'

exec $SB run --image sbx/base:latest --egress --repo "$REPO" --setup "$SETUP" \
  "opencode run --dir '$DIR' -m '$MODEL' --dangerously-skip-permissions '$TASK'"
