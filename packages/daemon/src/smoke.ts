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
import { SandboxStore } from "./store.js";

async function main(): Promise<number> {
  const config = loadConfig();
  const driver = new ContainerDriver();
  const store = new SandboxStore();

  const server = createApiServer({ config, driver, store });
  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  const endpoint = `http://${config.host}:${config.port}`;
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
