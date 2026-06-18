# Running AI agents on sbx

sbx is built to *run agents*, not just containers: each sandbox can come up with a **repo cloned in** (`--repo`), **LLM access wired without keys inside** (`--egress`), **hard resource caps**, and **per-agent cost/observability**. Two ways to use it:

## 1. Mastra (first-class) — [`@sbx/mastra`](../packages/mastra)

A Mastra `Workspace` sandbox provider backed by sbx. Drop `SbxSandbox` in where you'd use Mastra's `E2BSandbox`/`ModalSandbox`, and your agent runs on your own hardware:

```ts
import { Agent, Workspace } from "@mastra/core";
import { SbxSandbox } from "@sbx/mastra";

const agent = new Agent({
  name: "coder",
  model: "openai/gpt-5",
  workspace: new Workspace({
    sandbox: new SbxSandbox({ repo: "https://github.com/me/app", memoryMb: 2048 }),
  }),
});
await agent.generate("Add a /health route and run the tests.");
```

See [`mastra-agent/`](./mastra-agent) for a runnable example.

## 2. OpenCode (one command, via OpenRouter)

Launch a sandbox, clone a repo, run a headless [OpenCode](https://opencode.ai) task through [OpenRouter](https://openrouter.ai), and destroy the sandbox when done — your real key never enters the sandbox (it's swapped in by the egress gateway):

```bash
# 1. start the daemon with your OpenRouter key (the key lives only here):
SBX_PROVIDER_KEY_OPENROUTER=sk-or-... node packages/daemon/dist/index.js
# 2. build the base image once (gives the sandbox node + git):
docker build -t sbx/base:latest images/base
# 3. one command — create → clone → run OpenCode → destroy:
examples/opencode.sh https://github.com/you/app "add a /health route and run the tests"
```

What that runs under the hood is a single `sb run` (create → exec → auto-destroy):

```bash
sb run --image sbx/base:latest --egress --repo https://github.com/you/app \
  --setup 'npm i -g opencode-ai && mkdir -p ~/.config/opencode && printf "{\"provider\":{\"openrouter\":{\"options\":{\"baseURL\":\"%s/v1\",\"apiKey\":\"%s\"}}}}" "$OPENROUTER_BASE_URL" "$OPENROUTER_API_KEY" > ~/.config/opencode/opencode.json' \
  "opencode run --dir /workspace/app -m openrouter/moonshotai/kimi-k2.7-code --dangerously-skip-permissions 'add a /health route and run the tests'"
```

The egress gateway injects `OPENROUTER_BASE_URL` (→ `http://host.docker.internal:4752/openrouter`) and `OPENROUTER_API_KEY` (a per-sandbox token) into the sandbox; the OpenCode config points OpenRouter at that base URL. The daemon swaps the token for your real key, forwards to OpenRouter, and meters tokens + $ per sandbox (`sb stats`).

> Verified: `opencode-ai` installs and runs headless in the sandbox, and the egress key-injection/forwarding is covered by `npm run smoke`. The actual model call needs *your* OpenRouter key, so run it yourself with step 1 above.

### Other harnesses (same shape)

Swap the `--setup` install + run command — same `--repo`/`--egress` flow:

| Harness | install (`--setup`) | run command |
|---|---|---|
| **Codex CLI** | `npm i -g @openai/codex` | `codex exec '<task>'` |
| **Claude Code** | `npm i -g @anthropic-ai/claude-code` | `claude -p '<task>'` |
| **pi.dev** | (per its install) | `pi '<task>'` |

The egress gateway also injects `OPENAI_*` / `ANTHROPIC_*` when those provider keys are set on the daemon. Exact headless flags differ per tool — check each CLI's `--help`.

## What you get that raw Docker doesn't
- LLM reachable from the sandbox **without keys inside it** (egress gateway), with **per-agent token + $ metering**.
- **Repo cloned in** + **git** at create; persistent `/workspace`; idle auto-pause.
- **Hard CPU/mem/PID caps** so 100 parallel agents can't starve each other.
- **Preview URLs**, a **live terminal**, and a **dashboard** to watch agents run.
