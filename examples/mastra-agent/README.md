# Mastra coding agent on hotcell

A [Mastra](https://mastra.ai) agent whose execution environment is a self-hosted [hotcell](../../README.md) sandbox, via [`@hotcell/mastra`](../../packages/mastra).

```bash
# 1. start the hotcell daemon (from the repo root)
node packages/daemon/dist/index.js

# 2. (recommended) build the richer image so the sandbox has git + node
docker build -t hotcell/base:latest images/base

# 3. install + run
cd examples/mastra-agent
npm install
OPENAI_API_KEY=sk-... REPO=https://github.com/you/app \
  node agent.mjs "Add a /health route and run the tests"
```

- The agent's **LLM reasoning runs host-side** (your `OPENAI_API_KEY`); every **shell command runs in the hotcell sandbox** with the repo cloned into `/workspace`.
- Watch it live at <http://127.0.0.1:4750>; see per-agent cost with `hotcell stats <id>`.
- Set `MODEL` to change the model; add `egress: true` to the `HotcellSandbox` options if the agent should call an LLM *inside* the sandbox.

> **Security:** install a `@mastra/core` version published **after** the 2026-06-17 supply-chain remediation, and verify your lockfile has no `easy-day-js` dependency.
