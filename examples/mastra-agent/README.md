# Mastra coding agent on sbx

A [Mastra](https://mastra.ai) agent whose execution environment is a self-hosted [sbx](../../README.md) sandbox, via [`@sbx/mastra`](../../packages/mastra).

```bash
# 1. start the sbx daemon (from the repo root)
node packages/daemon/dist/index.js

# 2. (recommended) build the richer image so the sandbox has git + node
docker build -t sbx/base:latest images/base

# 3. install + run
cd examples/mastra-agent
npm install
OPENAI_API_KEY=sk-... REPO=https://github.com/you/app \
  node agent.mjs "Add a /health route and run the tests"
```

- The agent's **LLM reasoning runs host-side** (your `OPENAI_API_KEY`); every **shell command runs in the sbx sandbox** with the repo cloned into `/workspace`.
- Watch it live at <http://127.0.0.1:4750>; see per-agent cost with `sb stats <id>`.
- Set `MODEL` to change the model; add `egress: true` to the `SbxSandbox` options if the agent should call an LLM *inside* the sandbox.

> **Security:** install a `@mastra/core` version published **after** the 2026-06-17 supply-chain remediation, and verify your lockfile has no `easy-day-js` dependency.
