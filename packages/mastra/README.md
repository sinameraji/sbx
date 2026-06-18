# @sbx/mastra

A [**Mastra**](https://mastra.ai) `Workspace` **sandbox provider** backed by self-hosted [**sbx**](https://github.com/sinameraji/sbx). Drop it in where you'd use Mastra's `E2BSandbox` / `ModalSandbox` to run a Mastra agent's commands inside an sbx sandbox **on your own hardware** — with the LLM egress gateway, per-agent cost/observability, resource caps, and a git repo cloned in.

```bash
npm install @sbx/mastra @mastra/core
```

```ts
import { Agent, Workspace } from "@mastra/core";
import { SbxSandbox } from "@sbx/mastra";

const agent = new Agent({
  name: "coder",
  instructions: "You are a coding agent. Use the workspace to edit and test code.",
  model: "openai/gpt-5",
  workspace: new Workspace({
    sandbox: new SbxSandbox({
      repo: "https://github.com/me/app",   // cloned into /workspace at create
      egress: true,                         // LLM reachable without keys in the sandbox
      memoryMb: 2048,                        // hard resource caps
    }),
  }),
});

await agent.generate("Add a /health route and run the tests.");
```

## Why

`SbxSandbox` implements Mastra's `WorkspaceSandbox` interface (`start`/`stop`/`destroy`/`getInfo`, `executeCommand`, `getInstructions`), mapping each onto the [`@sbx/sdk`](https://github.com/sinameraji/sbx) primitives. Your Mastra agent runs on infrastructure you control instead of a managed cloud.

- `@mastra/core` is a **peer dependency** and is imported **types-only** — this package has **no runtime dependency** on `@mastra/core`.

## Options

```ts
new SbxSandbox({
  endpoint,    // sbx daemon (default SBX_ENDPOINT / http://127.0.0.1:4750)
  apiKey,      // for an auth-enabled daemon (default SBX_API_KEY)
  image,       // sandbox image (use one with git/node, e.g. sbx/base:latest)
  egress,      // wire the LLM egress gateway
  repo, repoRef, setup,           // clone a repo / run provisioning at create
  memoryMb, cpus, pidsLimit,      // hard resource caps
  sandboxId,   // attach to an existing sandbox instead of creating one
})
```

> **Security note:** `@mastra/*` had an npm supply-chain incident on 2026-06-17 (since remediated). Install a `@mastra/core` version published after the remediation and verify your lockfile has no `easy-day-js` dependency.

## License

Apache-2.0
