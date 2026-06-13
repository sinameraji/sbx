import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Config } from "../config.js";
import type { Driver } from "../driver/types.js";
import { SandboxStore } from "../store.js";
import type { ExecEvent, SandboxRecord } from "../types.js";

interface Deps {
  config: Config;
  driver: Driver;
  store: SandboxStore;
}

/**
 * Phase 0 REST surface:
 *   GET    /healthz
 *   POST   /sandboxes                 -> create
 *   GET    /sandboxes                 -> list
 *   GET    /sandboxes/:id             -> get
 *   DELETE /sandboxes/:id             -> destroy
 *   POST   /sandboxes/:id/exec        -> run command, stream output as SSE
 */
export function createApiServer({ config, driver, store }: Deps) {
  return createServer((req, res) => {
    handle(req, res, { config, driver, store }).catch((err) => {
      sendJson(res, 500, { error: String(err?.message ?? err) });
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  { config, driver, store }: Deps,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/healthz") {
    try {
      await driver.ping();
      return sendJson(res, 200, { ok: true, driver: driver.name });
    } catch (err) {
      return sendJson(res, 503, { ok: false, error: String(err) });
    }
  }

  if (method === "POST" && path === "/sandboxes") {
    const body = await readJson(req);
    return createSandbox(res, { config, driver, store }, body);
  }

  if (method === "GET" && path === "/sandboxes") {
    return sendJson(res, 200, { sandboxes: store.list() });
  }

  const execMatch = path.match(/^\/sandboxes\/([^/]+)\/exec$/);
  if (method === "POST" && execMatch) {
    const body = await readJson(req);
    return execInSandbox(res, { driver, store }, execMatch[1], body);
  }

  const idMatch = path.match(/^\/sandboxes\/([^/]+)$/);
  if (idMatch) {
    const id = idMatch[1];
    if (method === "GET") {
      const record = store.get(id);
      if (!record) return sendJson(res, 404, { error: "not found" });
      return sendJson(res, 200, record);
    }
    if (method === "DELETE") {
      const record = store.get(id);
      if (!record) return sendJson(res, 404, { error: "not found" });
      await driver.destroy(id);
      store.remove(id);
      return sendJson(res, 200, { id, destroyed: true });
    }
  }

  sendJson(res, 404, { error: `no route for ${method} ${path}` });
}

async function createSandbox(
  res: ServerResponse,
  { config, driver, store }: Deps,
  body: Record<string, unknown>,
): Promise<void> {
  const id = SandboxStore.newId();
  const image = typeof body.image === "string" ? body.image : config.defaultImage;
  const env = (body.env as Record<string, string>) ?? undefined;
  const labels = (body.labels as Record<string, string>) ?? {};

  await driver.create({ id, image, env, labels });

  const record: SandboxRecord = {
    id,
    image,
    status: "running",
    createdAt: new Date().toISOString(),
    labels,
  };
  store.add(record);
  sendJson(res, 201, record);
}

async function execInSandbox(
  res: ServerResponse,
  { driver, store }: Pick<Deps, "driver" | "store">,
  id: string,
  body: Record<string, unknown>,
): Promise<void> {
  const record = store.get(id);
  if (!record) return sendJson(res, 404, { error: "not found" });

  const command = body.command;
  if (typeof command !== "string" || command.length === 0) {
    return sendJson(res, 400, { error: "command is required" });
  }
  const opts = {
    cwd: typeof body.cwd === "string" ? body.cwd : undefined,
    env: (body.env as Record<string, string>) ?? undefined,
  };

  // Stream output as Server-Sent Events.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const write = (event: ExecEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    await driver.exec(id, command, opts, write);
  } catch (err) {
    write({ type: "stderr", data: String(err) });
    write({ type: "exit", exitCode: 1 });
  } finally {
    res.end();
  }
}

// --- helpers ---------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}
