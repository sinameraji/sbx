#!/usr/bin/env node
//
// Run a headless coding agent (OpenCode by default) inside a throwaway hotcell
// sandbox, with a clean, minimal UI: a single spinner with a live token/$ ticker,
// then the agent's answer, then a one-line summary. The sandbox is created, the
// repo is cloned in, the agent runs via OpenRouter through the hotcell egress gateway
// (your real key never enters the sandbox), and the sandbox is destroyed.
//
// Prereqs (see examples/README.md):
//   SBX_PROVIDER_KEY_OPENROUTER=sk-or-... node packages/daemon/dist/index.js
//   docker build -t sbx/base:latest images/base
//
// Usage:
//   examples/agent.mjs <repo-url> "<task>" [openrouter/model] [--keep] [--verbose]
//
import { SbxClient } from "../packages/sdk/dist/index.js";

// ---- args ----------------------------------------------------------------
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const pos = argv.filter((a) => !a.startsWith("--"));
const KEEP = flags.has("--keep");
const VERBOSE = flags.has("--verbose");
const NO_EGRESS = flags.has("--no-egress");
const REPO = pos[0];
const TASK = pos[1];
const MODEL = pos[2] || "openrouter/moonshotai/kimi-k2.7-code";
// Escape hatch: run any command as the "agent" (BYO harness / tests). When set,
// the OpenCode install/config is skipped — your command brings its own tool.
const AGENT_CMD = process.env.HOTCELL_AGENT_CMD;

if (!TASK || (!REPO && !AGENT_CMD)) {
  console.error('usage: agent.mjs <repo-url> "<task>" [openrouter/model] [--keep] [--verbose]');
  process.exit(2);
}

const repoName = REPO ? REPO.replace(/\.git$/, "").split("/").pop() : "sandbox";
const dir = REPO ? `/workspace/${repoName}` : "/workspace";
const modelShort = MODEL.split("/").pop();

// ---- tiny terminal UI ----------------------------------------------------
const useSpinner = process.stderr.isTTY && !process.env.NO_COLOR;
const dim = (s) => (useSpinner ? `\x1b[2m${s}\x1b[0m` : s);
const FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏".split("");
const state = { phase: "preparing sandbox", sub: "", tokens: 0, cost: 0 };
let frame = 0;
let spinTimer = null;

function label() {
  const meter =
    state.cost > 0
      ? ` · ${fmtTokens(state.tokens)} tokens · $${state.cost.toFixed(2)}`
      : state.tokens > 0
        ? ` · ${fmtTokens(state.tokens)} tokens`
        : "";
  return `${repoName} · ${state.phase}${state.sub ? " · " + state.sub : ""}${meter}`;
}
function render() {
  process.stderr.write("\r\x1b[2K" + dim(FRAMES[frame++ % FRAMES.length]) + " " + label());
}
function startSpin() {
  if (useSpinner) spinTimer = setInterval(render, 90);
  else process.stderr.write(`… ${state.phase}\n`);
}
function clearSpin() {
  if (spinTimer) clearInterval(spinTimer), (spinTimer = null);
  if (useSpinner) process.stderr.write("\r\x1b[2K");
}
function setPhase(p) {
  state.phase = p;
  state.sub = "";
  if (!useSpinner) process.stderr.write(`… ${p}\n`);
}
const fmtTokens = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));

// ---- agent-output filter (grounded in real OpenCode output) --------------
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const SUPPRESS = [/^>\s/, /^✗\s/, /^✱\s/, /^Error:\s*Tool execution aborted/i];
const VERBS = {
  read: "reading files", glob: "reading files", grep: "searching",
  list: "reading files", ls: "reading files", edit: "editing files",
  write: "editing files", patch: "editing files", apply: "editing files",
  bash: "running commands", shell: "running commands", run: "running commands",
  task: "planning", todowrite: "planning", webfetch: "fetching",
};
const answer = [];
function classify(raw) {
  const line = stripAnsi(raw).replace(/\s+$/, "");
  if (SUPPRESS.some((re) => re.test(line))) return;
  const tool = line.match(/^→\s+(\w+)/);
  if (tool) {
    state.sub = VERBS[tool[1].toLowerCase()] ?? "working";
    return;
  }
  answer.push(line);
}

// ---- daemon helpers ------------------------------------------------------
const client = new SbxClient({ endpoint: process.env.SBX_ENDPOINT, apiKey: process.env.SBX_API_KEY });
async function usageSnapshot(id) {
  // ?live=0 skips the ~1s docker stats call — just usage + cost (the egress meter).
  const r = await fetch(`${client.endpoint}/sandboxes/${id}/metrics?live=0`, {
    headers: client.authHeaders(),
  });
  return r.ok ? r.json() : null;
}
const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

// Setup: install OpenCode and point its OpenRouter provider at the egress gateway.
const OPENCODE_SETUP =
  `npm i -g opencode-ai >/dev/null 2>&1 && mkdir -p ~/.config/opencode && ` +
  `printf '{"provider":{"openrouter":{"options":{"baseURL":"%s/v1","apiKey":"%s"}}}}' ` +
  `"$OPENROUTER_BASE_URL" "$OPENROUTER_API_KEY" > ~/.config/opencode/opencode.json`;

// ---- run -----------------------------------------------------------------
const t0 = Date.now();
let sandbox;
startSpin();
try {
  sandbox = await client.getSandbox(undefined, {
    image: process.env.SBX_IMAGE ?? "sbx/base:latest",
    egress: !NO_EGRESS,
    repo: REPO,
    setup: AGENT_CMD ? undefined : [OPENCODE_SETUP],
  });
} catch (err) {
  clearSpin();
  console.error(`✗ couldn't prepare the sandbox: ${msg(err)}`);
  process.exit(1);
}

setPhase("agent working");
const command =
  AGENT_CMD ??
  `opencode run --dir ${sq(dir)} -m ${sq(MODEL)} --dangerously-skip-permissions ${sq(TASK)}`;

let buf = "";
let exitCode = 0;
const meter = setInterval(async () => {
  const m = await usageSnapshot(sandbox.id).catch(() => null);
  if (m?.usage) {
    state.tokens = (m.usage.providerTokensIn || 0) + (m.usage.providerTokensOut || 0);
    state.cost = m.cost?.total ?? 0;
  }
}, 1500);

try {
  for await (const ev of sandbox.execStream(command)) {
    if (ev.type === "exit") {
      exitCode = ev.exitCode;
      continue;
    }
    if (VERBOSE) {
      (ev.type === "stdout" ? process.stdout : process.stderr).write(ev.data);
      continue;
    }
    buf += ev.data;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      classify(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  if (buf) classify(buf);
} finally {
  clearInterval(meter);
}

// Final usage + (for edit tasks) what changed.
const finalUsage = await usageSnapshot(sandbox.id).catch(() => null);
let diffStat = "";
if (REPO) {
  const d = await sandbox
    .exec(`git -C ${sq(dir)} --no-pager diff --stat 2>/dev/null | tail -1`)
    .catch(() => null);
  diffStat = (d?.stdout || "").trim();
}

clearSpin();

// ---- output --------------------------------------------------------------
const text = answer.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
if (VERBOSE) {
  // raw stream already printed
} else if (text) {
  process.stdout.write(text + "\n");
} else if (exitCode !== 0) {
  console.error(`✗ the agent run failed (exit ${exitCode}). Re-run with --verbose to see why.`);
}

const secs = Math.round((Date.now() - t0) / 1000);
const tokens = finalUsage?.usage
  ? (finalUsage.usage.providerTokensIn || 0) + (finalUsage.usage.providerTokensOut || 0)
  : state.tokens;
const cost = finalUsage?.cost?.total ?? state.cost;
const meterTxt = tokens > 0 ? ` · ${fmtTokens(tokens)} tokens · $${cost.toFixed(2)}` : "";
const ok = exitCode === 0;
console.error(
  dim(`${ok ? "✓" : "✗"} ${repoName} · ${ok ? "done" : "failed"} in ${secs}s${meterTxt}`) +
    (diffStat ? dim(` · ${diffStat}`) : ""),
);

// ---- teardown ------------------------------------------------------------
if (KEEP) {
  console.error(dim(`  kept ${sandbox.id} — inspect: sb terminal ${sandbox.id}  ·  remove: sb rm ${sandbox.id}`));
} else if (ok) {
  await sandbox.destroy().catch(() => {});
} else {
  console.error(dim(`  kept ${sandbox.id} for inspection — remove with: sb rm ${sandbox.id}`));
}
process.exit(ok ? 0 : 1);

function msg(e) {
  return e instanceof Error ? e.message : String(e);
}
