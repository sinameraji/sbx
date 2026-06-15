/**
 * Phase 0 smoke test.
 *
 * Starts the daemon, creates a sandbox, runs a command, checks the output,
 * destroys the sandbox, and exits with the command's status.
 */

import { setTimeout } from "node:timers/promises";
import { loadConfig } from "./config.js";
import { ContainerDriver } from "./driver/container.js";
import { createApiServer } from "./api/server.js";
import { createProxyServer } from "./proxy/server.js";
import { SandboxStore } from "./store.js";

async function main(): Promise<number> {
  const config = loadConfig();
  const driver = new ContainerDriver();
  const store = new SandboxStore();

  const server = createApiServer({ config, driver, store });
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
    await setTimeout(100);
  }
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
