// A Mastra coding agent that runs inside a self-hosted sbx sandbox.
//
//   1) start the sbx daemon:   node packages/daemon/dist/index.js
//   2) (optional, richer image) docker build -t sbx/base:latest images/base
//   3) cd examples/mastra-agent && npm install
//   4) OPENAI_API_KEY=sk-... REPO=https://github.com/you/app \
//        node agent.mjs "Add a /health route and run the tests"
//
// The agent's LLM reasoning runs here (host-side, with your OPENAI_API_KEY);
// the SANDBOX is the agent's execution environment — every shell command the
// agent runs happens in an isolated sbx sandbox with the repo cloned into
// /workspace. Watch it live in the dashboard (http://127.0.0.1:4750) and see the
// per-agent cost with `sb stats <id>`.
import { Agent, Workspace } from "@mastra/core";
import { SbxSandbox } from "@sbx/mastra";

const sandbox = new SbxSandbox({
  image: process.env.SBX_IMAGE ?? "sbx/base:latest", // has git + node + python
  repo: process.env.REPO, // cloned into /workspace at create
  memoryMb: 2048,
  cpus: 2,
  // egress: true,  // enable if the agent should shell out to an LLM *inside* the sandbox
});

const agent = new Agent({
  name: "coder",
  instructions:
    "You are a coding agent working in a Linux sandbox. The repository is in " +
    "/workspace. Use the execute-command tool to inspect files, make edits, and " +
    "run tests. Explain what you changed.",
  model: process.env.MODEL ?? "openai/gpt-4o-mini", // host-side; needs OPENAI_API_KEY
  workspace: new Workspace({ sandbox }),
});

const task = process.argv[2] ?? "List the files in the repo and summarize what it does.";

try {
  const res = await agent.generate(task);
  console.log("\n=== agent result ===\n" + (res.text ?? JSON.stringify(res, null, 2)));
  console.log(`\nsandbox ${sandbox.id} — inspect with: sb stats ${sandbox.id}`);
} finally {
  await sandbox.destroy();
}
