#!/usr/bin/env bash
#
# Run a coding task with OpenCode inside a throwaway sbx sandbox — clean output:
# a spinner with a live token/$ ticker, then the agent's answer, then a summary.
# OpenRouter is reached through the sbx egress gateway, so your real key stays on
# the daemon and never enters the sandbox.
#
# Prereqs:
#   1. SBX_PROVIDER_KEY_OPENROUTER=sk-or-... node packages/daemon/dist/index.js
#   2. docker build -t sbx/base:latest images/base
#
# Usage:
#   examples/opencode.sh <repo-url> "<task>" [openrouter/model] [--keep] [--verbose]
#
exec node "$(cd "$(dirname "$0")" && pwd)/agent.mjs" "$@"
