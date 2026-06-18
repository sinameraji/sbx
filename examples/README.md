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

## 2. CLI harnesses — OpenCode / Codex / Claude Code / pi.dev

Any headless coding-agent CLI runs in an sbx sandbox via the same three flags: **`--repo`** (clone the code), **`--setup`** (install the CLI), **`--egress`** (inject the provider base-URL + key so the harness reaches an LLM with no key baked into the sandbox). Set the daemon's provider key first, e.g. `SBX_PROVIDER_KEY_OPENAI` / `SBX_PROVIDER_KEY_ANTHROPIC`.

```bash
alias sb="node packages/cli/dist/index.js"

# OpenCode
ID=$(sb create --image sbx/base:latest --egress \
      --repo https://github.com/you/app \
      --setup "npm i -g opencode-ai")
sb exec $ID "cd /workspace/app && opencode run 'add a /health route'"
sb stats $ID         # per-agent cost (LLM calls metered by the egress gateway)

# Codex CLI       --setup "npm i -g @openai/codex"     then  codex exec '<task>'
# Claude Code     --setup "npm i -g @anthropic-ai/claude-code"  then  claude -p '<task>'
# pi.dev          --setup "<install pi>"                then  pi '<task>'
```

The egress gateway injects, per provider configured on the daemon:
`OPENAI_BASE_URL`/`OPENAI_API_KEY`, `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`, `OPENROUTER_BASE_URL`/`OPENROUTER_API_KEY` — all pointing at `http://host.docker.internal:4752/<provider>` with a per-sandbox token. Any OpenAI/Anthropic-compatible harness picks these up automatically.

> The exact headless invocation differs per tool and version — treat the lines above as recipes and check each CLI's `--help`. What sbx provides is constant: the repo, the isolated environment, the LLM access, and the cost/observability.

## What you get that raw Docker doesn't
- LLM reachable from the sandbox **without keys inside it** (egress gateway), with **per-agent token + $ metering**.
- **Repo cloned in** + **git** at create; persistent `/workspace`; idle auto-pause.
- **Hard CPU/mem/PID caps** so 100 parallel agents can't starve each other.
- **Preview URLs**, a **live terminal**, and a **dashboard** to watch agents run.
