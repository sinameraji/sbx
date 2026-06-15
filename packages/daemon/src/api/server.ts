import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { previewUrl, type Config } from "../config.js";
import type { Driver } from "../driver/types.js";
import { SandboxStore } from "../store.js";
import type {
  ExecEvent,
  ExposedPort,
  ProcessInfo,
  SandboxRecord,
} from "../types.js";

interface Deps {
  config: Config;
  driver: Driver;
  store: SandboxStore;
}

/**
 * Phase 0/1 REST surface:
 *   GET    /healthz
 *   POST   /sandboxes                      -> create
 *   GET    /sandboxes                      -> list
 *   GET    /sandboxes/:id                  -> get
 *   DELETE /sandboxes/:id                  -> destroy
 *   POST   /sandboxes/:id/exec             -> run command, stream output as SSE
 *   POST   /sandboxes/:id/files/write      -> write file
 *   POST   /sandboxes/:id/files/read       -> read file
 *   POST   /sandboxes/:id/files/mkdir      -> create directory
 *   POST   /sandboxes/:id/files/list       -> list directory
 *   POST   /sandboxes/:id/processes              -> start background process
 *   GET    /sandboxes/:id/processes              -> list processes
 *   DELETE /sandboxes/:id/processes/:procId      -> signal/kill process
 *   GET    /sandboxes/:id/processes/:procId/logs -> stream logs (SSE)
 *   POST   /sandboxes/:id/wait-port              -> wait for a TCP port
 *   POST   /sandboxes/:id/expose                 -> expose a port (preview URL)
 *   GET    /sandboxes/:id/expose                 -> list exposed ports
 *   DELETE /sandboxes/:id/expose/:port           -> unexpose a port
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

  const fileActionMatch = path.match(/^\/sandboxes\/([^/]+)\/files\/(write|read|mkdir|list)$/);
  if (method === "POST" && fileActionMatch) {
    const body = await readJson(req);
    return handleFileAction(
      res,
      { driver, store },
      fileActionMatch[1],
      fileActionMatch[2] as "write" | "read" | "mkdir" | "list",
      body,
    );
  }

  const procLogsMatch = path.match(
    /^\/sandboxes\/([^/]+)\/processes\/([^/]+)\/logs$/,
  );
  if (method === "GET" && procLogsMatch) {
    return streamLogs(
      req,
      res,
      { driver, store },
      procLogsMatch[1],
      procLogsMatch[2],
      url.searchParams.get("follow") !== "0" &&
        url.searchParams.has("follow"),
    );
  }

  const procIdMatch = path.match(/^\/sandboxes\/([^/]+)\/processes\/([^/]+)$/);
  if (method === "DELETE" && procIdMatch) {
    const body = await readJson(req);
    return killProcess(res, { driver, store }, procIdMatch[1], procIdMatch[2], body);
  }

  const procMatch = path.match(/^\/sandboxes\/([^/]+)\/processes$/);
  if (procMatch) {
    if (method === "POST") {
      const body = await readJson(req);
      return startProcess(res, { driver, store }, procMatch[1], body);
    }
    if (method === "GET") {
      return listProcesses(res, { driver, store }, procMatch[1]);
    }
  }

  const waitPortMatch = path.match(/^\/sandboxes\/([^/]+)\/wait-port$/);
  if (method === "POST" && waitPortMatch) {
    const body = await readJson(req);
    return waitForPort(res, { driver, store }, waitPortMatch[1], body);
  }

  const exposePortMatch = path.match(/^\/sandboxes\/([^/]+)\/expose\/(\d+)$/);
  if (method === "DELETE" && exposePortMatch) {
    return unexposePort(
      res,
      { store },
      exposePortMatch[1],
      Number(exposePortMatch[2]),
    );
  }

  const exposeMatch = path.match(/^\/sandboxes\/([^/]+)\/expose$/);
  if (exposeMatch) {
    if (method === "POST") {
      const body = await readJson(req);
      return exposePort(res, { config, store }, exposeMatch[1], body);
    }
    if (method === "GET") {
      const record = store.get(exposeMatch[1]);
      if (!record) return sendJson(res, 404, { error: "not found" });
      return sendJson(res, 200, { exposed: store.listExposed(exposeMatch[1]) });
    }
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
      store.clearSandbox(id);
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

async function handleFileAction(
  res: ServerResponse,
  { driver, store }: Pick<Deps, "driver" | "store">,
  id: string,
  action: "write" | "read" | "mkdir" | "list",
  body: Record<string, unknown>,
): Promise<void> {
  const record = store.get(id);
  if (!record) return sendJson(res, 404, { error: "not found" });

  const path = typeof body.path === "string" ? body.path : "";
  if (!path) return sendJson(res, 400, { error: "path is required" });

  try {
    switch (action) {
      case "write": {
        if (typeof body.content !== "string") {
          return sendJson(res, 400, { error: "content is required" });
        }
        await driver.writeFile(id, {
          path,
          content: body.content,
          mode: typeof body.mode === "string" ? body.mode : undefined,
        });
        return sendJson(res, 200, { ok: true });
      }
      case "read": {
        const content = await driver.readFile(id, { path });
        return sendJson(res, 200, { content });
      }
      case "mkdir": {
        await driver.mkdir(id, { path, parents: body.parents === true });
        return sendJson(res, 200, { ok: true });
      }
      case "list": {
        const entries = await driver.listFiles(id, { path });
        return sendJson(res, 200, { entries });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return sendJson(res, 500, { error: message });
  }
}

async function startProcess(
  res: ServerResponse,
  { driver, store }: Pick<Deps, "driver" | "store">,
  id: string,
  body: Record<string, unknown>,
): Promise<void> {
  if (!store.get(id)) return sendJson(res, 404, { error: "not found" });

  const command = body.command;
  if (typeof command !== "string" || command.length === 0) {
    return sendJson(res, 400, { error: "command is required" });
  }
  const procId = SandboxStore.newProcId();
  const opts = {
    cwd: typeof body.cwd === "string" ? body.cwd : undefined,
    env: (body.env as Record<string, string>) ?? undefined,
  };

  try {
    const { pid, logPath } = await driver.startProcess(id, procId, command, opts);
    const proc: ProcessInfo = {
      procId,
      pid,
      command,
      status: "running",
      exitCode: null,
      startedAt: new Date().toISOString(),
      logPath,
    };
    store.addProcess(id, proc);
    return sendJson(res, 201, proc);
  } catch (err) {
    return sendJson(res, 500, { error: errMessage(err) });
  }
}

async function listProcesses(
  res: ServerResponse,
  { driver, store }: Pick<Deps, "driver" | "store">,
  id: string,
): Promise<void> {
  if (!store.get(id)) return sendJson(res, 404, { error: "not found" });

  const procs = store.listProcesses(id);
  if (procs.length > 0) {
    try {
      const liveness = await driver.listProcesses(
        id,
        procs.map((p) => ({ procId: p.procId, pid: p.pid })),
      );
      const running = new Map(liveness.map((l) => [l.procId, l.running]));
      for (const p of procs) {
        if (p.status === "running" && running.get(p.procId) === false) {
          p.status = "exited";
        }
      }
    } catch {
      // Liveness refresh is best-effort; fall back to last-known status.
    }
  }
  return sendJson(res, 200, { processes: store.listProcesses(id) });
}

async function killProcess(
  res: ServerResponse,
  { driver, store }: Pick<Deps, "driver" | "store">,
  id: string,
  procId: string,
  body: Record<string, unknown>,
): Promise<void> {
  if (!store.get(id)) return sendJson(res, 404, { error: "not found" });
  const proc = store.getProcess(id, procId);
  if (!proc) return sendJson(res, 404, { error: "process not found" });

  const signal = typeof body.signal === "string" ? body.signal : undefined;
  try {
    await driver.killProcess(id, proc.pid, signal);
    proc.status = "exited";
    return sendJson(res, 200, { ok: true });
  } catch (err) {
    return sendJson(res, 500, { error: errMessage(err) });
  }
}

async function streamLogs(
  req: IncomingMessage,
  res: ServerResponse,
  { driver, store }: Pick<Deps, "driver" | "store">,
  id: string,
  procId: string,
  follow: boolean,
): Promise<void> {
  if (!store.get(id)) return sendJson(res, 404, { error: "not found" });
  const proc = store.getProcess(id, procId);
  if (!proc) return sendJson(res, 404, { error: "process not found" });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const controller = new AbortController();
  req.on("close", () => controller.abort());

  try {
    await driver.streamProcessLogs(
      id,
      proc.logPath,
      { follow, signal: controller.signal },
      (data) => res.write(`data: ${JSON.stringify({ type: "log", data })}\n\n`),
    );
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: "log", data: errMessage(err) })}\n\n`);
  } finally {
    res.write(`data: ${JSON.stringify({ type: "end" })}\n\n`);
    res.end();
  }
}

async function waitForPort(
  res: ServerResponse,
  { driver, store }: Pick<Deps, "driver" | "store">,
  id: string,
  body: Record<string, unknown>,
): Promise<void> {
  if (!store.get(id)) return sendJson(res, 404, { error: "not found" });
  const port = Number(body.port);
  if (!Number.isInteger(port) || port <= 0) {
    return sendJson(res, 400, { error: "port is required" });
  }
  try {
    const ready = await driver.waitForPort(id, port, {
      timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
      intervalMs: typeof body.intervalMs === "number" ? body.intervalMs : undefined,
      host: typeof body.host === "string" ? body.host : undefined,
    });
    return sendJson(res, 200, { ready });
  } catch (err) {
    return sendJson(res, 500, { error: errMessage(err) });
  }
}

function exposePort(
  res: ServerResponse,
  { config, store }: Pick<Deps, "config" | "store">,
  id: string,
  body: Record<string, unknown>,
): void {
  if (!store.get(id)) return sendJson(res, 404, { error: "not found" });
  const port = Number(body.port);
  if (!Number.isInteger(port) || port <= 0) {
    return sendJson(res, 400, { error: "port is required" });
  }
  const exposed: ExposedPort = {
    port,
    exposeId: `${id}-${port}`,
    token: typeof body.token === "string" ? body.token : null,
    createdAt: new Date().toISOString(),
    url: previewUrl(config, id, port),
  };
  store.addExposed(id, exposed);
  return sendJson(res, 201, exposed);
}

function unexposePort(
  res: ServerResponse,
  { store }: Pick<Deps, "store">,
  id: string,
  port: number,
): void {
  if (!store.get(id)) return sendJson(res, 404, { error: "not found" });
  const removed = store.removeExposed(id, port);
  if (!removed) return sendJson(res, 404, { error: "port not exposed" });
  return sendJson(res, 200, { ok: true });
}

// --- helpers ---------------------------------------------------------------

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
