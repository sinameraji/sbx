// Provider test for @sbx/mastra — drives SbxSandbox against a live sbx daemon
// (no LLM/Mastra runtime needed; types-only dependency on @mastra/core).
// Run from the repo root: `npm run smoke:mastra`.
import { spawn } from "node:child_process";
import { SbxSandbox } from "./dist/index.js";

const PORT = 4760;
const endpoint = `http://127.0.0.1:${PORT}`;
const env = {
  ...process.env,
  SBX_PORT: String(PORT),
  SBX_PROXY_PORT: "4761",
  SBX_EGRESS_PORT: "4762",
  SBX_DB: ":memory:",
  SBX_LOG_LEVEL: "error",
};

const log = (m) => console.error("[mastra-test] " + m);

async function waitHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(endpoint + "/healthz");
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("daemon did not become healthy");
}

const daemon = spawn("node", ["packages/daemon/dist/index.js"], { env, stdio: "inherit" });
let code = 0;
try {
  await waitHealth();
  log("daemon up");

  const sb = new SbxSandbox({ endpoint });
  await sb.start();
  if (!sb.id || sb.status !== "running") throw new Error(`bad start: ${sb.id} ${sb.status}`);
  log(`started sandbox ${sb.id}`);

  const echo = await sb.executeCommand("echo", ["hello-mastra"]);
  if (!echo.success || !echo.stdout.includes("hello-mastra")) {
    throw new Error("executeCommand(args) failed: " + JSON.stringify(echo));
  }
  log("executeCommand with shell-quoted args works");

  const pwd = await sb.executeCommand("pwd");
  if (pwd.stdout.trim() !== "/workspace") throw new Error("cwd != /workspace: " + pwd.stdout);
  log("default working directory is /workspace");

  await sb.executeCommand("sh -c 'echo content > /workspace/m.txt'");
  const cat = await sb.executeCommand("cat /workspace/m.txt");
  if (cat.stdout.trim() !== "content") throw new Error("file round-trip failed");
  log("file round-trip via executeCommand works");

  const fail = await sb.executeCommand("sh -c 'exit 3'");
  if (fail.success || fail.exitCode !== 3) throw new Error("non-zero exit not reported: " + JSON.stringify(fail));
  log("non-zero exit code reported");

  let streamed = "";
  await sb.executeCommand("echo streamed", [], { onStdout: (d) => (streamed += d) });
  if (!streamed.includes("streamed")) throw new Error("onStdout callback not invoked");
  log("onStdout streaming callback works");

  const info = await sb.getInfo();
  if (info.provider !== "sbx" || info.id !== sb.id) throw new Error("getInfo wrong: " + JSON.stringify(info));
  log(`getInfo works (status=${info.status})`);

  await sb.destroy();
  if (sb.status !== "destroyed") throw new Error("destroy did not set status");
  log("destroy works");

  log("passed");
} catch (e) {
  log("failed: " + (e?.stack || e));
  code = 1;
} finally {
  daemon.kill("SIGTERM");
}
process.exit(code);
