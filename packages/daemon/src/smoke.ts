/**
 * Phase 0 smoke test.
 *
 * Starts the daemon, creates a sandbox, runs a command, checks the output,
 * destroys the sandbox, and exits with the command's status.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { BackupRegistry } from "./backups.js";
import { loadConfig } from "./config.js";
import { ContainerDriver } from "./driver/container.js";
import { createApiServer } from "./api/server.js";
import { createProxyServer } from "./proxy/server.js";
import { SandboxStore } from "./store.js";

async function main(): Promise<number> {
  const config = loadConfig();
  // Use a throwaway backup dir so the smoke run leaves nothing behind.
  config.backupDir = await mkdtemp(join(tmpdir(), "sbx-smoke-backups-"));
  const driver = new ContainerDriver();
  const store = new SandboxStore();
  const backups = new BackupRegistry(config.backupDir);

  const server = createApiServer({ config, driver, store, backups });
  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  const endpoint = `http://${config.host}:${config.port}`;
  const proxy = createProxyServer({ config, driver, store });
  await new Promise<void>((resolve) =>
    proxy.listen(config.proxyPort, config.proxyHost, resolve),
  );
  const proxyEndpoint = `http://${config.proxyHost}:${config.proxyPort}`;
  console.error(`[smoke] daemon up at ${endpoint}`);

  try {
    // Create sandbox.
    const createRes = await fetch(`${endpoint}/sandboxes`, { method: "POST" });
    if (!createRes.ok) throw new Error(`create failed: ${createRes.status}`);
    const { id } = (await createRes.json()) as { id: string };
    console.error(`[smoke] created sandbox ${id}`);

    // Run command.
    const execRes = await fetch(`${endpoint}/sandboxes/${id}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "echo hello from smoke" }),
    });
    if (!execRes.ok || !execRes.body) throw new Error(`exec failed: ${execRes.status}`);

    let stdout = "";
    let exitCode = -1;
    for await (const event of parseSSE(execRes.body)) {
      if (event.type === "stdout") stdout += event.data;
      else if (event.type === "exit") exitCode = event.exitCode ?? 0;
    }

    console.log(stdout.trim());
    if (stdout.trim() !== "hello from smoke") {
      throw new Error(`unexpected output: ${stdout}`);
    }
    if (exitCode !== 0) {
      throw new Error(`non-zero exit: ${exitCode}`);
    }

    // File operations.
    const writeRes = await fetch(`${endpoint}/sandboxes/${id}/files/write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/workspace/smoke.txt", content: "file ops work" }),
    });
    if (!writeRes.ok) throw new Error(`write failed: ${writeRes.status}`);
    console.error("[smoke] wrote file");

    const readRes = await fetch(`${endpoint}/sandboxes/${id}/files/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/workspace/smoke.txt" }),
    });
    if (!readRes.ok) throw new Error(`read failed: ${readRes.status}`);
    const { content } = (await readRes.json()) as { content: string };
    if (content !== "file ops work") {
      throw new Error(`unexpected file content: ${content}`);
    }
    console.error("[smoke] read file");

    const mkdirRes = await fetch(`${endpoint}/sandboxes/${id}/files/mkdir`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/workspace/nested/dir", parents: true }),
    });
    if (!mkdirRes.ok) throw new Error(`mkdir failed: ${mkdirRes.status}`);
    console.error("[smoke] created directory");

    const listRes = await fetch(`${endpoint}/sandboxes/${id}/files/list`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/workspace" }),
    });
    if (!listRes.ok) throw new Error(`list failed: ${listRes.status}`);
    const { entries } = (await listRes.json()) as { entries: { name: string; isDirectory: boolean }[] };
    const names = entries.map((e) => e.name).sort();
    if (!names.includes("smoke.txt") || !names.includes("nested")) {
      throw new Error(`unexpected directory listing: ${names.join(", ")}`);
    }
    console.error("[smoke] listed files");

    // Background process + port readiness + preview proxy.
    const startRes = await fetch(`${endpoint}/sandboxes/${id}/processes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "python3 -m http.server 8000" }),
    });
    if (!startRes.ok) throw new Error(`startProcess failed: ${startRes.status}`);
    const proc = (await startRes.json()) as { procId: string };
    console.error(`[smoke] started process ${proc.procId}`);

    const waitRes = await fetch(`${endpoint}/sandboxes/${id}/wait-port`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port: 8000, timeoutMs: 15000 }),
    });
    const { ready } = (await waitRes.json()) as { ready: boolean };
    if (!ready) throw new Error("port 8000 never became ready");
    console.error("[smoke] port 8000 ready");

    const exposeRes = await fetch(`${endpoint}/sandboxes/${id}/expose`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port: 8000 }),
    });
    if (!exposeRes.ok) throw new Error(`expose failed: ${exposeRes.status}`);
    console.error("[smoke] exposed port 8000");

    // Reach the in-sandbox server through the preview proxy (path-based route).
    const previewRes = await fetch(`${proxyEndpoint}/_sbx/${id}/8000/`);
    const previewBody = await previewRes.text();
    if (!previewBody.includes("Directory listing")) {
      throw new Error(`preview proxy did not serve the sandbox: ${previewBody.slice(0, 80)}`);
    }
    console.error("[smoke] preview proxy served the sandbox");

    // Sandbox env vars apply to subsequent commands.
    const setEnvRes = await fetch(`${endpoint}/sandboxes/${id}/env`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ env: { SMOKE_VAR: "from-env" } }),
    });
    if (!setEnvRes.ok) throw new Error(`setEnv failed: ${setEnvRes.status}`);
    const envEcho = await execAndCapture(endpoint, id, "echo $SMOKE_VAR");
    if (envEcho !== "from-env") {
      throw new Error(`env var not applied: "${envEcho}"`);
    }
    console.error("[smoke] sandbox env var applied");

    // Sessions: cwd follows `cd` and session env overlays the sandbox env.
    const sessionRes = await fetch(`${endpoint}/sandboxes/${id}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ env: { SESS_VAR: "from-session" } }),
    });
    if (!sessionRes.ok) throw new Error(`createSession failed: ${sessionRes.status}`);
    const { sessionId } = (await sessionRes.json()) as { sessionId: string };

    await execAndCapture(endpoint, id, "cd /tmp", sessionId);
    const sessPwd = await execAndCapture(endpoint, id, "pwd", sessionId);
    if (sessPwd !== "/tmp") {
      throw new Error(`session cwd did not persist: "${sessPwd}"`);
    }
    const sessEcho = await execAndCapture(endpoint, id, "echo $SESS_VAR", sessionId);
    if (sessEcho !== "from-session") {
      throw new Error(`session env var not applied: "${sessEcho}"`);
    }
    console.error("[smoke] session cwd + env persisted");

    // Code interpreter: a stateful Python context (variables persist) plus a
    // one-off run.
    const ctxRes = await fetch(`${endpoint}/sandboxes/${id}/code-contexts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ language: "python" }),
    });
    if (!ctxRes.ok) throw new Error(`createCodeContext failed: ${ctxRes.status}`);
    const { contextId } = (await ctxRes.json()) as { contextId: string };
    console.error(`[smoke] created code context ${contextId}`);

    await runCode(endpoint, id, "x = 41", contextId);
    const exprResult = await runCode(endpoint, id, "x + 1", contextId);
    if (exprResult.results[0]?.text !== "42") {
      throw new Error(`stateful runCode wrong result: ${JSON.stringify(exprResult.results)}`);
    }
    const printResult = await runCode(endpoint, id, "print('hi from kernel')", contextId);
    if (printResult.stdout.trim() !== "hi from kernel") {
      throw new Error(`runCode stdout wrong: "${printResult.stdout}"`);
    }
    const errResult = await runCode(endpoint, id, "1/0", contextId);
    if (!errResult.error || !errResult.error.includes("ZeroDivisionError")) {
      throw new Error(`runCode did not capture error: ${JSON.stringify(errResult)}`);
    }
    console.error("[smoke] stateful python context works (vars persist, stdout, errors)");

    // One-off run with no explicit context.
    const oneOff = await runCode(endpoint, id, "print(6 * 7)");
    if (oneOff.stdout.trim() !== "42") {
      throw new Error(`one-off runCode wrong: "${oneOff.stdout}"`);
    }
    console.error("[smoke] one-off runCode works");

    const delCtxRes = await fetch(
      `${endpoint}/sandboxes/${id}/code-contexts/${contextId}`,
      { method: "DELETE" },
    );
    if (!delCtxRes.ok) throw new Error(`delete context failed: ${delCtxRes.status}`);
    console.error("[smoke] destroyed code context");

    // File watching: open the stream, create a file, expect a change event.
    const watchAbort = new AbortController();
    const watchRes = await fetch(
      `${endpoint}/sandboxes/${id}/watch?path=/workspace&interval=300`,
      { signal: watchAbort.signal },
    );
    if (!watchRes.ok || !watchRes.body) throw new Error(`watch failed: ${watchRes.status}`);
    const sawFile = (async () => {
      for await (const ev of parseSSE(watchRes.body!)) {
        if ((ev as unknown as { path?: string }).path?.endsWith("watched.txt")) {
          return true;
        }
      }
      return false;
    })();
    sawFile.catch(() => false); // avoid an unhandled rejection on abort

    // Let the watcher take its first snapshot, then create a file.
    await setTimeout(600);
    await fetch(`${endpoint}/sandboxes/${id}/files/write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/workspace/watched.txt", content: "watch me" }),
    });
    const detected = await Promise.race([
      sawFile,
      setTimeout(5000).then(() => false),
    ]);
    watchAbort.abort();
    if (!detected) throw new Error("watch did not report the new file");
    console.error("[smoke] watch reported the new file");

    // Persistence: a file in /workspace survives a stop/start (container is
    // recreated, the named volume is reattached).
    await fetch(`${endpoint}/sandboxes/${id}/files/write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/workspace/persist.txt", content: "survives restart" }),
    });
    const stopRes = await fetch(`${endpoint}/sandboxes/${id}/stop`, { method: "POST" });
    if (!stopRes.ok) throw new Error(`stop failed: ${stopRes.status}`);
    const stopped = (await stopRes.json()) as { status: string };
    if (stopped.status !== "stopped") throw new Error(`expected stopped, got ${stopped.status}`);
    console.error("[smoke] stopped sandbox");

    const startSbRes = await fetch(`${endpoint}/sandboxes/${id}/start`, { method: "POST" });
    if (!startSbRes.ok) throw new Error(`start failed: ${startSbRes.status}`);
    console.error("[smoke] started sandbox");

    const persistRead = await fetch(`${endpoint}/sandboxes/${id}/files/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/workspace/persist.txt" }),
    });
    if (!persistRead.ok) throw new Error(`persist read failed: ${persistRead.status}`);
    const { content: persisted } = (await persistRead.json()) as { content: string };
    if (persisted !== "survives restart") {
      throw new Error(`workspace did not persist across restart: "${persisted}"`);
    }
    console.error("[smoke] workspace persisted across stop/start");

    // Backup + restore: snapshot /workspace, mutate it, restore, confirm rollback.
    await fetch(`${endpoint}/sandboxes/${id}/files/write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/workspace/backup.txt", content: "v1" }),
    });
    const backupRes = await fetch(`${endpoint}/sandboxes/${id}/backups`, { method: "POST" });
    if (!backupRes.ok) throw new Error(`backup failed: ${backupRes.status}`);
    const { backupId } = (await backupRes.json()) as { backupId: string };
    console.error(`[smoke] created backup ${backupId}`);

    // Mutate after the backup: change a file and add a new one.
    await fetch(`${endpoint}/sandboxes/${id}/files/write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/workspace/backup.txt", content: "v2" }),
    });
    await fetch(`${endpoint}/sandboxes/${id}/files/write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/workspace/after-backup.txt", content: "transient" }),
    });

    const restoreRes = await fetch(`${endpoint}/sandboxes/${id}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ backupId }),
    });
    if (!restoreRes.ok) throw new Error(`restore failed: ${restoreRes.status}`);
    console.error("[smoke] restored backup");

    const rolledBack = await execAndCapture(endpoint, id, "cat /workspace/backup.txt");
    if (rolledBack !== "v1") {
      throw new Error(`restore did not roll back the file: "${rolledBack}"`);
    }
    // The file added after the backup must be gone (restore is a replacement).
    const gone = await execAndCapture(
      endpoint,
      id,
      "test -e /workspace/after-backup.txt && echo present || echo gone",
    );
    if (gone !== "gone") {
      throw new Error(`restore did not clear post-backup files: "${gone}"`);
    }
    console.error("[smoke] backup/restore rolled the workspace back");

    // Destroy sandbox.
    const deleteRes = await fetch(`${endpoint}/sandboxes/${id}`, { method: "DELETE" });
    if (!deleteRes.ok) throw new Error(`destroy failed: ${deleteRes.status}`);
    console.error(`[smoke] destroyed sandbox ${id}`);

    console.error("[smoke] passed");
    return 0;
  } catch (err) {
    console.error(`[smoke] failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    proxy.close();
    server.close();
    await rm(config.backupDir, { recursive: true, force: true });
    await setTimeout(100);
  }
}

/** Run a command (optionally in a session) and return trimmed stdout. */
async function execAndCapture(
  endpoint: string,
  id: string,
  command: string,
  sessionId?: string,
): Promise<string> {
  const res = await fetch(`${endpoint}/sandboxes/${id}/exec`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command, sessionId }),
  });
  if (!res.ok || !res.body) throw new Error(`exec failed: ${res.status}`);
  let out = "";
  for await (const event of parseSSE(res.body)) {
    if (event.type === "stdout") out += event.data;
  }
  return out.trim();
}

interface CodeResult {
  stdout: string;
  stderr: string;
  results: { type: string; text: string }[];
  error: string | null;
}

/** Run a code cell via the run-code endpoint, optionally in a context. */
async function runCode(
  endpoint: string,
  id: string,
  code: string,
  contextId?: string,
): Promise<CodeResult> {
  const res = await fetch(`${endpoint}/sandboxes/${id}/run-code`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, contextId }),
  });
  if (!res.ok) throw new Error(`run-code failed: ${res.status}`);
  return (await res.json()) as CodeResult;
}

type ExecEvent =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "exit"; exitCode: number };

async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ExecEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const json = line.slice(5).trim();
      if (json) yield JSON.parse(json) as ExecEvent;
    }
  }
}

main().then((code) => process.exit(code));
