import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { type BackupInfo, BackupRegistry } from "../backups.js";
import { previewUrl, type Config } from "../config.js";
import type { Driver, TerminalSession } from "../driver/types.js";
import { kernelFor, type KernelLanguage } from "../kernels.js";
import { resumeSandbox } from "../lifecycle.js";
import { computeCost } from "../cost.js";
import { log } from "../logger.js";
import type { MetricsHistory } from "../metrics.js";
import { recentSpans, startSpan } from "../tracing.js";
import { buildProviders } from "../proxy/egress.js";
import { emptyUsage, SandboxStore } from "../store.js";
import { acceptWebSocket } from "./ws.js";
import { DASHBOARD_HTML } from "../web/dashboard.js";
import type {
  CodeContextInfo,
  CodeResult,
  ExecEvent,
  ExposedPort,
  ProcessInfo,
  SandboxRecord,
  SessionInfo,
} from "../types.js";

interface Deps {
  config: Config;
  driver: Driver;
  store: SandboxStore;
  backups: BackupRegistry;
  history?: MetricsHistory;
}

/**
 * Phase 0/1 REST surface:
 *   GET    /healthz
 *   POST   /sandboxes                      -> create
 *   GET    /sandboxes                      -> list
 *   GET    /sandboxes/:id                  -> get
 *   DELETE /sandboxes/:id                  -> destroy (removes volume too)
 *   GET    /sandboxes/:id/metrics          -> live stats + cumulative usage + cost
 *   POST   /sandboxes/:id/stop             -> stop (remove container, keep volume)
 *   POST   /sandboxes/:id/start            -> start (recreate container, reattach volume)
 *   POST   /sandboxes/:id/backups          -> back up /workspace, returns BackupInfo
 *   GET    /sandboxes/:id/backups          -> list this sandbox's backups
 *   POST   /sandboxes/:id/restore          -> restore /workspace from {backupId}
 *   GET    /backups                        -> list all backups
 *   DELETE /backups/:backupId              -> delete a backup
 *   POST   /sandboxes/:id/code-contexts        -> create a code-interpreter context
 *   GET    /sandboxes/:id/code-contexts        -> list code contexts
 *   DELETE /sandboxes/:id/code-contexts/:ctxId -> destroy a code context
 *   POST   /sandboxes/:id/run-code             -> run code, returns CodeResult
 *   POST   /sandboxes/:id/exec             -> run command, stream output as SSE
 *   POST   /sandboxes/:id/files/write      -> write file
 *   POST   /sandboxes/:id/files/read       -> read file
 *   POST   /sandboxes/:id/files/mkdir      -> create directory
 *   POST   /sandboxes/:id/files/list       -> list directory
 *   GET    /sandboxes/:id/watch            -> stream file-change events (SSE)
 *   GET    /sandboxes/:id/terminal         -> interactive PTY shell (WebSocket upgrade)
 *   GET    /sandboxes/:id/metrics/history  -> recent live-metrics samples (sparklines)
 *   POST   /sandboxes/:id/egress-tokens         -> mint an egress (LLM gateway) token
 *   GET    /sandboxes/:id/egress-tokens         -> list egress tokens + provider URLs
 *   DELETE /sandboxes/:id/egress-tokens/:token  -> revoke an egress token
 *   GET    /traces                         -> recent finished trace spans
 *   POST   /sandboxes/:id/processes              -> start background process
 *   GET    /sandboxes/:id/processes              -> list processes
 *   DELETE /sandboxes/:id/processes/:procId      -> signal/kill process
 *   GET    /sandboxes/:id/processes/:procId/logs -> stream logs (SSE)
 *   POST   /sandboxes/:id/wait-port              -> wait for a TCP port
 *   POST   /sandboxes/:id/expose                 -> expose a port (preview URL)
 *   GET    /sandboxes/:id/expose                 -> list exposed ports
 *   DELETE /sandboxes/:id/expose/:port           -> unexpose a port
 *   GET    /sandboxes/:id/env                     -> get sandbox env vars
 *   POST   /sandboxes/:id/env                     -> merge sandbox env vars
 *   POST   /sandboxes/:id/sessions               -> create a session
 *   GET    /sandboxes/:id/sessions               -> list sessions
 *   DELETE /sandboxes/:id/sessions/:sid          -> delete a session
 *   POST   /sandboxes/:id/sessions/:sid/env      -> merge session env vars
 */
export function createApiServer(deps: Deps) {
  const server = createServer((req, res) => {
    const method = req.method ?? "GET";
    const rawPath = (req.url ?? "/").split("?")[0];
    // One server span per request — the create→exec→destroy trace the plan asks
    // for falls out naturally (route is normalized so ids don't explode names).
    const span = startSpan(`${method} ${normalizeRoute(rawPath)}`, {
      "http.method": method,
      "http.target": rawPath,
    });
    const startedMs = Date.now();
    res.on("finish", () => {
      span.setAttribute("http.status_code", res.statusCode);
      if (res.statusCode >= 500) span.setStatus("error");
      span.end();
      const line = {
        method,
        path: rawPath,
        status: res.statusCode,
        durMs: Date.now() - startedMs,
        traceId: span.traceId,
      };
      if (res.statusCode >= 500) log.error("request", line);
      else log.info("request", line);
    });
    handle(req, res, deps).catch((err) => {
      span.setStatus("error").setAttribute("error", String(err?.message ?? err));
      sendJson(res, 500, { error: String(err?.message ?? err) });
    });
  });
  // Live terminal: a WebSocket upgrade bridged to an in-sandbox PTY.
  server.on("upgrade", (req, socket, head) => {
    handleTerminalUpgrade(req, socket as Duplex, head, deps).catch(() => socket.destroy());
  });
  return server;
}

/** Pull a Bearer token from the Authorization header, if present. */
function bearerFromHeader(req: IncomingMessage): string | undefined {
  const header = req.headers["authorization"];
  return typeof header === "string" && header.startsWith("Bearer ")
    ? header.slice(7)
    : undefined;
}

/**
 * Handle a WebSocket upgrade for `GET /sandboxes/:id/terminal`: authenticate,
 * resolve (and auto-resume) the sandbox, open a PTY, and splice bytes both ways.
 * Inbound binary frames are stdin; inbound text frames are control JSON (resize).
 * Browsers can't set headers on a WebSocket, so the API key may arrive as `?key=`.
 */
async function handleTerminalUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  deps: Deps,
): Promise<void> {
  const { config, driver, store } = deps;
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const match = url.pathname.match(/^\/sandboxes\/([^/]+)\/terminal$/);
  if (!match) {
    socket.destroy();
    return;
  }
  if (config.apiKey) {
    const provided = url.searchParams.get("key") ?? bearerFromHeader(req);
    if (provided !== config.apiKey) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
  }
  const id = match[1];
  const record = store.get(id);
  if (!record) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  if (record.status === "stopped") {
    socket.write("HTTP/1.1 409 Conflict\r\n\r\n");
    socket.destroy();
    return;
  }
  if (record.status === "paused") await resumeSandbox(driver, store, record);
  else store.touch(id);

  const ws = acceptWebSocket(req, socket, head);
  if (!ws) return;

  const cols = Number(url.searchParams.get("cols")) || 80;
  const rows = Number(url.searchParams.get("rows")) || 24;
  const span = startSpan("WS /sandboxes/:id/terminal", { "sandbox.id": id });

  let term: TerminalSession;
  try {
    term = await driver.openTerminal(id, { cols, rows, env: record.env });
  } catch (err) {
    ws.send(`\r\n[sbx] failed to open terminal: ${errMessage(err)}\r\n`);
    ws.close();
    span.setStatus("error").end();
    return;
  }
  log.info("terminal opened", { sandbox: id, traceId: span.traceId });

  term.stream.on("data", (chunk: Buffer) => ws.send(chunk));
  term.stream.on("end", () => ws.close());
  term.stream.on("error", () => ws.close());

  ws.onMessage((data, isBinary) => {
    if (isBinary) {
      term.stream.write(data);
      store.touch(id);
      return;
    }
    try {
      const msg = JSON.parse(data.toString("utf8"));
      if (msg && msg.type === "resize") {
        term.resize(Number(msg.cols) || cols, Number(msg.rows) || rows);
      }
    } catch {
      // Non-JSON text frames are ignored; keystrokes arrive as binary frames.
    }
  });

  ws.onClose(() => {
    term.close();
    span.end();
    log.info("terminal closed", { sandbox: id });
  });
}

/**
 * Build the egress-gateway client config for a token: per-provider base URLs the
 * sandbox points its SDK at, plus suggested env vars. The token is used in place
 * of each provider's real API key (the daemon swaps it for the real one).
 */
function egressConfig(config: Config) {
  const base = `http://${config.egressAdvertiseHost}:${config.egressPort}`;
  const names = Object.keys(buildProviders(config));
  const ENV_HINT: Record<string, { baseUrlEnv: string; keyEnv: string }> = {
    openai: { baseUrlEnv: "OPENAI_BASE_URL", keyEnv: "OPENAI_API_KEY" },
    anthropic: { baseUrlEnv: "ANTHROPIC_BASE_URL", keyEnv: "ANTHROPIC_API_KEY" },
    openrouter: { baseUrlEnv: "OPENROUTER_BASE_URL", keyEnv: "OPENROUTER_API_KEY" },
  };
  const providers = names.map((name) => ({
    name,
    baseUrl: `${base}/${name}`,
    ...ENV_HINT[name],
  }));
  return { providers };
}

/**
 * Env vars that point a sandbox's LLM SDKs at the egress gateway, with `token`
 * standing in for each provider's real key. Injected at create time when a
 * sandbox opts into egress, so the gateway is drop-in (no in-sandbox config).
 */
function egressEnv(config: Config, token: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const p of egressConfig(config).providers) {
    if (p.baseUrlEnv) env[p.baseUrlEnv] = p.baseUrl;
    if (p.keyEnv) env[p.keyEnv] = token;
  }
  return env;
}

/** Collapse high-cardinality id segments so span/route names stay bounded. */
function normalizeRoute(path: string): string {
  return path
    .replace(/^\/sandboxes\/[^/]+/, "/sandboxes/:id")
    .replace(/\/(processes|sessions|code-contexts|expose|backups)\/[^/]+/, "/$1/:sub");
}

/**
 * Enforce the API key when one is configured. `/healthz` and the dashboard HTML
 * stay open (probes + first paint, so the dashboard can prompt for the key).
 * Accepts `Authorization: Bearer <key>` or `X-API-Key: <key>`.
 */
function isAuthorized(req: IncomingMessage, config: Config, path: string): boolean {
  if (!config.apiKey) return true;
  // Open: health probes, the dashboard shell, and /info (non-sensitive — it only
  // reports driver/image/cost-rates and whether auth is on, so the dashboard can
  // decide to prompt for a key before making authenticated calls).
  if (path === "/healthz" || path === "/" || path === "/dashboard" || path === "/info") {
    return true;
  }
  const header = req.headers["authorization"];
  const bearer =
    typeof header === "string" && header.startsWith("Bearer ")
      ? header.slice(7)
      : undefined;
  const apiKeyHeader = req.headers["x-api-key"];
  const provided =
    bearer ?? (typeof apiKeyHeader === "string" ? apiKeyHeader : undefined);
  return provided === config.apiKey;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: Deps,
): Promise<void> {
  const { config, driver, store, backups } = deps;
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (!isAuthorized(req, config, path)) {
    res.setHeader("WWW-Authenticate", "Bearer");
    return sendJson(res, 401, { error: "missing or invalid API key" });
  }

  if (method === "GET" && path === "/healthz") {
    try {
      await driver.ping();
      return sendJson(res, 200, { ok: true, driver: driver.name });
    } catch (err) {
      return sendJson(res, 503, { ok: false, error: String(err) });
    }
  }

  // Daemon info for the dashboard (cost rates, proxy port, driver, image).
  if (method === "GET" && path === "/info") {
    return sendJson(res, 200, {
      driver: driver.name,
      defaultImage: config.defaultImage,
      proxyPort: config.proxyPort,
      costCpuPerHour: config.costCpuPerHour,
      costMemGbPerHour: config.costMemGbPerHour,
      costEgressPerGb: config.costEgressPerGb,
      defaultSleepAfterMs: config.defaultSleepAfterMs,
      auth: config.apiKey.length > 0,
      otlp: config.otlpEndpoint.length > 0,
      egressPort: config.egressPort,
      egressProviders: Object.keys(buildProviders(config)),
    });
  }

  const egressTokenIdMatch = path.match(
    /^\/sandboxes\/([^/]+)\/egress-tokens\/([^/]+)$/,
  );
  if (method === "DELETE" && egressTokenIdMatch) {
    if (!store.get(egressTokenIdMatch[1])) return sendJson(res, 404, { error: "not found" });
    const removed = store.removeEgressToken(egressTokenIdMatch[2]);
    if (!removed) return sendJson(res, 404, { error: "token not found" });
    return sendJson(res, 200, { token: egressTokenIdMatch[2], revoked: true });
  }

  const egressTokensMatch = path.match(/^\/sandboxes\/([^/]+)\/egress-tokens$/);
  if (egressTokensMatch) {
    const id = egressTokensMatch[1];
    if (!store.get(id)) return sendJson(res, 404, { error: "not found" });
    if (method === "POST") {
      const token = SandboxStore.newEgressToken();
      store.addEgressToken(token, id);
      return sendJson(res, 201, { token, providers: egressConfig(config).providers });
    }
    if (method === "GET") {
      return sendJson(res, 200, {
        tokens: store.listEgressTokens(id),
        providers: egressConfig(config).providers,
      });
    }
  }

  // Recent finished spans, for debugging and the trace view. Newest first.
  if (method === "GET" && path === "/traces") {
    const limit = Number(url.searchParams.get("limit") ?? "100") || 100;
    return sendJson(res, 200, { spans: recentSpans().slice(0, limit) });
  }

  // Embedded single-page dashboard (no build step, zero dependencies).
  if (method === "GET" && (path === "/" || path === "/dashboard")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return void res.end(DASHBOARD_HTML);
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

  const watchMatch = path.match(/^\/sandboxes\/([^/]+)\/watch$/);
  if (method === "GET" && watchMatch) {
    const watchPath = url.searchParams.get("path") ?? "/workspace";
    const intervalMs = Number(url.searchParams.get("interval") ?? "") || undefined;
    return watchFiles(req, res, { driver, store }, watchMatch[1], watchPath, intervalMs);
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
      return exposePort(res, { config, driver, store }, exposeMatch[1], body);
    }
    if (method === "GET") {
      const record = store.get(exposeMatch[1]);
      if (!record) return sendJson(res, 404, { error: "not found" });
      return sendJson(res, 200, { exposed: store.listExposed(exposeMatch[1]) });
    }
  }

  const sessionEnvMatch = path.match(
    /^\/sandboxes\/([^/]+)\/sessions\/([^/]+)\/env$/,
  );
  if (method === "POST" && sessionEnvMatch) {
    const body = await readJson(req);
    return setSessionEnv(
      res,
      { store },
      sessionEnvMatch[1],
      sessionEnvMatch[2],
      body,
    );
  }

  const sessionIdMatch = path.match(/^\/sandboxes\/([^/]+)\/sessions\/([^/]+)$/);
  if (method === "DELETE" && sessionIdMatch) {
    return deleteSession(res, { store }, sessionIdMatch[1], sessionIdMatch[2]);
  }

  const sessionsMatch = path.match(/^\/sandboxes\/([^/]+)\/sessions$/);
  if (sessionsMatch) {
    if (method === "POST") {
      const body = await readJson(req);
      return createSession(res, { store }, sessionsMatch[1], body);
    }
    if (method === "GET") {
      if (!store.get(sessionsMatch[1])) {
        return sendJson(res, 404, { error: "not found" });
      }
      return sendJson(res, 200, {
        sessions: store.listSessions(sessionsMatch[1]),
      });
    }
  }

  const envMatch = path.match(/^\/sandboxes\/([^/]+)\/env$/);
  if (envMatch) {
    const record = store.get(envMatch[1]);
    if (!record) return sendJson(res, 404, { error: "not found" });
    if (method === "GET") {
      return sendJson(res, 200, { env: record.env });
    }
    if (method === "POST") {
      const body = await readJson(req);
      const env = (body.env as Record<string, string>) ?? {};
      record.env = { ...record.env, ...env };
      store.add(record); // write-through the env change
      return sendJson(res, 200, { env: record.env });
    }
  }

  if (method === "GET" && path === "/backups") {
    return sendJson(res, 200, { backups: await backups.list() });
  }

  const backupIdMatch = path.match(/^\/backups\/([^/]+)$/);
  if (method === "DELETE" && backupIdMatch) {
    const removed = await backups.remove(backupIdMatch[1]);
    if (!removed) return sendJson(res, 404, { error: "backup not found" });
    return sendJson(res, 200, { backupId: backupIdMatch[1], deleted: true });
  }

  const backupsMatch = path.match(/^\/sandboxes\/([^/]+)\/backups$/);
  if (backupsMatch) {
    if (method === "POST") {
      return createBackup(res, deps, backupsMatch[1]);
    }
    if (method === "GET") {
      if (!store.get(backupsMatch[1])) {
        return sendJson(res, 404, { error: "not found" });
      }
      const all = await backups.list();
      return sendJson(res, 200, {
        backups: all.filter((b) => b.sandboxId === backupsMatch[1]),
      });
    }
  }

  const restoreMatch = path.match(/^\/sandboxes\/([^/]+)\/restore$/);
  if (method === "POST" && restoreMatch) {
    const body = await readJson(req);
    return restoreBackup(res, deps, restoreMatch[1], body);
  }

  const ctxIdMatch = path.match(/^\/sandboxes\/([^/]+)\/code-contexts\/([^/]+)$/);
  if (method === "DELETE" && ctxIdMatch) {
    return deleteCodeContext(res, { driver, store }, ctxIdMatch[1], ctxIdMatch[2]);
  }

  const ctxMatch = path.match(/^\/sandboxes\/([^/]+)\/code-contexts$/);
  if (ctxMatch) {
    if (method === "POST") {
      const body = await readJson(req);
      return createCodeContext(res, { driver, store }, ctxMatch[1], body);
    }
    if (method === "GET") {
      if (!store.get(ctxMatch[1])) return sendJson(res, 404, { error: "not found" });
      return sendJson(res, 200, {
        contexts: store.listContexts(ctxMatch[1]).map(publicContext),
      });
    }
  }

  const runCodeMatch = path.match(/^\/sandboxes\/([^/]+)\/run-code$/);
  if (method === "POST" && runCodeMatch) {
    const body = await readJson(req);
    return runCode(res, { driver, store }, runCodeMatch[1], body);
  }

  const historyMatch = path.match(/^\/sandboxes\/([^/]+)\/metrics\/history$/);
  if (method === "GET" && historyMatch) {
    if (!store.get(historyMatch[1])) return sendJson(res, 404, { error: "not found" });
    return sendJson(res, 200, { samples: deps.history?.get(historyMatch[1]) ?? [] });
  }

  const metricsMatch = path.match(/^\/sandboxes\/([^/]+)\/metrics$/);
  if (method === "GET" && metricsMatch) {
    const live = url.searchParams.get("live") !== "0";
    return getMetrics(res, { config, driver, store }, metricsMatch[1], live);
  }

  const stopMatch = path.match(/^\/sandboxes\/([^/]+)\/stop$/);
  if (method === "POST" && stopMatch) {
    return stopSandbox(res, { driver, store }, stopMatch[1]);
  }

  const startMatch = path.match(/^\/sandboxes\/([^/]+)\/start$/);
  if (method === "POST" && startMatch) {
    return startSandbox(res, { driver, store }, startMatch[1]);
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
      deps.history?.clear(id);
      return sendJson(res, 200, { id, destroyed: true });
    }
  }

  sendJson(res, 404, { error: `no route for ${method} ${path}` });
}

async function createSandbox(
  res: ServerResponse,
  { config, driver, store }: Pick<Deps, "config" | "driver" | "store">,
  body: Record<string, unknown>,
): Promise<void> {
  const id = SandboxStore.newId();
  const image = typeof body.image === "string" ? body.image : config.defaultImage;
  const labels = (body.labels as Record<string, string>) ?? {};
  const persist = body.persist !== false;
  const sleepAfterMs =
    typeof body.sleepAfter === "number" ? body.sleepAfter : config.defaultSleepAfterMs;

  // Opt-in egress wiring: mint a token and inject the provider base-URL + key env
  // vars so any LLM SDK in the sandbox routes through the gateway with no config.
  let egressToken: string | undefined;
  let env = (body.env as Record<string, string>) ?? {};
  if (body.egress === true) {
    egressToken = SandboxStore.newEgressToken();
    env = { ...env, ...egressEnv(config, egressToken) };
  }

  await driver.create({ id, image, env, labels, persist });

  const now = new Date().toISOString();
  const record: SandboxRecord = {
    id,
    image,
    status: "running",
    createdAt: now,
    labels,
    env,
    persist,
    lastActivityAt: now,
    sleepAfterMs,
    usage: emptyUsage(),
  };
  store.add(record);
  if (egressToken) store.addEgressToken(egressToken, id);
  sendJson(res, 201, record);
}

async function stopSandbox(
  res: ServerResponse,
  { driver, store }: Pick<Deps, "driver" | "store">,
  id: string,
): Promise<void> {
  const record = store.get(id);
  if (!record) return sendJson(res, 404, { error: "not found" });
  if (record.status === "stopped") return sendJson(res, 200, record);
  await driver.stop(id);
  // Processes and exposed ports die with the container; sessions persist.
  store.clearRuntimeState(id);
  record.status = "stopped";
  store.add(record); // write-through the status change
  sendJson(res, 200, record);
}

async function startSandbox(
  res: ServerResponse,
  { driver, store }: Pick<Deps, "driver" | "store">,
  id: string,
): Promise<void> {
  const record = store.get(id);
  if (!record) return sendJson(res, 404, { error: "not found" });
  if (record.status === "running") return sendJson(res, 200, record);
  await resumeSandbox(driver, store, record);
  sendJson(res, 200, record);
}

/**
 * Resolve a sandbox that must be live to do work. Records the activity (so the
 * idle reaper sees recent use), transparently resumes a `paused` sandbox, and
 * rejects a manually `stopped` one (409 — the user must `start` it). Sends the
 * error response itself and returns null on failure.
 */
async function ensureLive(
  res: ServerResponse,
  driver: Driver,
  store: SandboxStore,
  id: string,
): Promise<SandboxRecord | null> {
  const record = store.get(id);
  if (!record) {
    sendJson(res, 404, { error: "not found" });
    return null;
  }
  if (record.status === "stopped") {
    sendJson(res, 409, { error: "sandbox is stopped; start it first" });
    return null;
  }
  if (record.status === "paused") {
    await resumeSandbox(driver, store, record);
  } else {
    store.touch(id);
  }
  return record;
}

/**
 * Resource metrics + cost for a sandbox. A live snapshot is included only when
 * the sandbox is running (a paused/stopped sandbox has no container); the
 * accumulated usage and cost are always returned. Reading metrics is a passive
 * query — it does not count as activity nor auto-resume a paused sandbox.
 */
async function getMetrics(
  res: ServerResponse,
  { config, driver, store }: Pick<Deps, "config" | "driver" | "store">,
  id: string,
  includeLive = true,
): Promise<void> {
  const record = store.get(id);
  if (!record) return sendJson(res, 404, { error: "not found" });
  let live = null;
  if (includeLive && record.status === "running") {
    try {
      live = await driver.stats(id);
    } catch {
      // Container may have just gone away; report accumulated usage only.
    }
  }
  return sendJson(res, 200, {
    status: record.status,
    live,
    usage: record.usage,
    cost: computeCost(record.usage, config),
  });
}

async function createBackup(
  res: ServerResponse,
  { driver, store, backups }: Deps,
  id: string,
): Promise<void> {
  const record = await ensureLive(res, driver, store, id);
  if (!record) return;
  const backupId = SandboxStore.newBackupId();
  await backups.ensureDir();
  const { bytes } = await driver.createBackup(id, backups.tarPath(backupId));
  const info: BackupInfo = {
    backupId,
    sandboxId: id,
    createdAt: new Date().toISOString(),
    bytes,
  };
  await backups.save(info);
  sendJson(res, 201, info);
}

async function restoreBackup(
  res: ServerResponse,
  { driver, store, backups }: Deps,
  id: string,
  body: Record<string, unknown>,
): Promise<void> {
  if (!store.get(id)) return sendJson(res, 404, { error: "not found" });
  const backupId = body.backupId;
  if (typeof backupId !== "string") {
    return sendJson(res, 400, { error: "backupId is required" });
  }
  const info = await backups.get(backupId);
  if (!info) return sendJson(res, 404, { error: "backup not found" });
  if (!(await ensureLive(res, driver, store, id))) return;
  await driver.restoreBackup(id, backups.tarPath(backupId));
  sendJson(res, 200, { id, restored: backupId });
}

// --- code interpreter ------------------------------------------------------

/** Run a command, accumulating its streams; never throws on non-zero exit. */
async function execCapture(
  driver: Driver,
  id: string,
  command: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  await driver.exec(id, command, {}, (e) => {
    if (e.type === "stdout") stdout += e.data;
    else if (e.type === "stderr") stderr += e.data;
    else exitCode = e.exitCode;
  });
  return { stdout, stderr, exitCode };
}

function parseLanguage(value: unknown): KernelLanguage | undefined {
  return value === "python" || value === "javascript" ? value : undefined;
}

/** Provision a kernel: make the context dir + fifos, write it, start it. */
async function startKernel(
  driver: Driver,
  store: SandboxStore,
  id: string,
  language: KernelLanguage,
): Promise<CodeContextInfo> {
  const contextId = SandboxStore.newContextId();
  const dir = `/workspace/.sbx/ctx-${contextId}`;
  const setup = await execCapture(
    driver,
    id,
    `mkdir -p ${dir} && mkfifo ${dir}/in.fifo ${dir}/out.fifo`,
  );
  if (setup.exitCode !== 0) {
    throw new Error(`failed to set up code context: ${setup.stderr.trim()}`);
  }
  const kernel = kernelFor(language);
  await driver.writeFile(id, { path: `${dir}/${kernel.filename}`, content: kernel.source });
  const procId = SandboxStore.newProcId();
  const { pid } = await driver.startProcess(id, procId, kernel.command(dir), {});
  const ctx: CodeContextInfo = {
    contextId,
    language,
    dir,
    procId,
    pid,
    seq: 0,
    createdAt: new Date().toISOString(),
  };
  store.addContext(id, ctx);
  return ctx;
}

/** Kill a context's kernel and remove its directory. */
async function teardownKernel(
  driver: Driver,
  id: string,
  ctx: CodeContextInfo,
): Promise<void> {
  try {
    await driver.killProcess(id, ctx.pid, "KILL");
  } catch {
    // Kernel may already be gone; the rm below still cleans up.
  }
  await execCapture(driver, id, `rm -rf ${ctx.dir}`);
}

async function createCodeContext(
  res: ServerResponse,
  { driver, store }: Pick<Deps, "driver" | "store">,
  id: string,
  body: Record<string, unknown>,
): Promise<void> {
  if (!(await ensureLive(res, driver, store, id))) return;
  const language = parseLanguage(body.language ?? "python");
  if (!language) {
    return sendJson(res, 400, { error: "language must be 'python' or 'javascript'" });
  }
  const ctx = await startKernel(driver, store, id, language);
  sendJson(res, 201, publicContext(ctx));
}

async function deleteCodeContext(
  res: ServerResponse,
  { driver, store }: Pick<Deps, "driver" | "store">,
  id: string,
  contextId: string,
): Promise<void> {
  const ctx = store.getContext(id, contextId);
  if (!ctx) return sendJson(res, 404, { error: "context not found" });
  await teardownKernel(driver, id, ctx);
  store.removeContext(id, contextId);
  sendJson(res, 200, { contextId, destroyed: true });
}

async function runCode(
  res: ServerResponse,
  { driver, store }: Pick<Deps, "driver" | "store">,
  id: string,
  body: Record<string, unknown>,
): Promise<void> {
  if (!(await ensureLive(res, driver, store, id))) return;
  const code = body.code;
  if (typeof code !== "string") {
    return sendJson(res, 400, { error: "code is required" });
  }
  const timeoutMs = typeof body.timeoutMs === "number" ? body.timeoutMs : 30_000;

  // Resolve the context: an explicit one (persistent), or a throwaway kernel
  // for a one-off run.
  let ctx: CodeContextInfo;
  let ephemeral = false;
  if (typeof body.contextId === "string") {
    const found = store.getContext(id, body.contextId);
    if (!found) return sendJson(res, 404, { error: "context not found" });
    ctx = found;
  } else {
    const language = parseLanguage(body.language ?? "python");
    if (!language) {
      return sendJson(res, 400, { error: "language must be 'python' or 'javascript'" });
    }
    ctx = await startKernel(driver, store, id, language);
    ephemeral = true;
  }

  try {
    const result = await runCell(driver, id, ctx, code, timeoutMs);
    if (!ephemeral) store.addContext(id, ctx); // write-through the bumped seq
    sendJson(res, 200, result);
  } finally {
    if (ephemeral) {
      await teardownKernel(driver, id, ctx);
      store.removeContext(id, ctx.contextId);
    }
  }
}

/** Drive one cell through the kernel's fifo handshake and read its result. */
async function runCell(
  driver: Driver,
  id: string,
  ctx: CodeContextInfo,
  code: string,
  timeoutMs: number,
): Promise<CodeResult> {
  const seq = ++ctx.seq;
  await driver.writeFile(id, { path: `${ctx.dir}/cell-${seq}.code`, content: code });
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  // Push the seq to the kernel and block until it signals completion. If the
  // kernel is wedged or the cell runs too long, `timeout` aborts the handshake.
  const handshake = await execCapture(
    driver,
    id,
    `timeout ${seconds} sh -c 'printf "%s" "${seq}" > ${ctx.dir}/in.fifo && read _ < ${ctx.dir}/out.fifo'`,
  );
  if (handshake.exitCode === 124 || handshake.exitCode === 137) {
    return {
      stdout: "",
      stderr: "",
      results: [],
      error: `code execution timed out after ${seconds}s`,
    };
  }
  const raw = await driver.readFile(id, { path: `${ctx.dir}/cell-${seq}.result.json` });
  return JSON.parse(raw) as CodeResult;
}

function publicContext(ctx: CodeContextInfo) {
  return {
    contextId: ctx.contextId,
    language: ctx.language,
    createdAt: ctx.createdAt,
  };
}

async function execInSandbox(
  res: ServerResponse,
  { driver, store }: Pick<Deps, "driver" | "store">,
  id: string,
  body: Record<string, unknown>,
): Promise<void> {
  const record = await ensureLive(res, driver, store, id);
  if (!record) return;

  const command = body.command;
  if (typeof command !== "string" || command.length === 0) {
    return sendJson(res, 400, { error: "command is required" });
  }

  // Resolve an optional session: it contributes a working directory and an env
  // overlay, and its cwd follows `cd` across commands. Env precedence (lowest
  // to highest): sandbox -> session -> request.
  const requestEnv = (body.env as Record<string, string>) ?? {};
  const requestCwd = typeof body.cwd === "string" ? body.cwd : undefined;
  let session: SessionInfo | undefined;
  if (typeof body.sessionId === "string") {
    session = store.getSession(id, body.sessionId);
    if (!session) return sendJson(res, 404, { error: "session not found" });
  }

  const env = { ...record.env, ...(session?.env ?? {}), ...requestEnv };
  const cwd = requestCwd ?? session?.cwd;

  // For a session, capture the working directory the command leaves behind so a
  // later `cd` persists. We append a `pwd` write that runs in the same shell as
  // the user command (newline-delimited so a trailing comment can't swallow it).
  let runCommand = command;
  const cwdFile = session ? `/tmp/sbx-sess-${session.sessionId}.cwd` : null;
  if (cwdFile) {
    runCommand =
      `{\n${command}\n}\n__sbx_rc=$?\n` +
      `pwd > ${cwdFile} 2>/dev/null\nexit $__sbx_rc`;
  }

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
    await driver.exec(id, runCommand, { cwd, env }, write);
    if (session && cwdFile) {
      try {
        const next = (await driver.readFile(id, { path: cwdFile })).trim();
        if (next && next !== session.cwd) {
          session.cwd = next;
          store.addSession(id, session); // write-through the cwd change
        }
      } catch {
        // Best-effort cwd capture; keep the previous cwd on failure.
      }
    }
  } catch (err) {
    write({ type: "stderr", data: String(err) });
    write({ type: "exit", exitCode: 1 });
  } finally {
    res.end();
  }
}

async function watchFiles(
  req: IncomingMessage,
  res: ServerResponse,
  { driver, store }: Pick<Deps, "driver" | "store">,
  id: string,
  watchPath: string,
  intervalMs: number | undefined,
): Promise<void> {
  if (!(await ensureLive(res, driver, store, id))) return;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  // Flush headers immediately with an SSE comment so clients (e.g. fetch) get
  // the response before the first change event — which may be far in the future.
  res.write(": watching\n\n");

  // Stop the watcher when the client disconnects.
  const controller = new AbortController();
  req.on("close", () => controller.abort());

  try {
    await driver.watchFiles(
      id,
      watchPath,
      { intervalMs, signal: controller.signal },
      (event) => res.write(`data: ${JSON.stringify(event)}\n\n`),
    );
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: "error", error: String(err) })}\n\n`);
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
  if (!(await ensureLive(res, driver, store, id))) return;

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
  const record = await ensureLive(res, driver, store, id);
  if (!record) return;

  const command = body.command;
  if (typeof command !== "string" || command.length === 0) {
    return sendJson(res, 400, { error: "command is required" });
  }
  const procId = SandboxStore.newProcId();
  const opts = {
    cwd: typeof body.cwd === "string" ? body.cwd : undefined,
    env: { ...record.env, ...((body.env as Record<string, string>) ?? {}) },
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
          store.addProcess(id, p); // write-through the exited status
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
    store.addProcess(id, proc); // write-through the exited status
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
  if (!(await ensureLive(res, driver, store, id))) return;
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

async function exposePort(
  res: ServerResponse,
  { config, driver, store }: Pick<Deps, "config" | "driver" | "store">,
  id: string,
  body: Record<string, unknown>,
): Promise<void> {
  if (!(await ensureLive(res, driver, store, id))) return;
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

function createSession(
  res: ServerResponse,
  { store }: Pick<Deps, "store">,
  id: string,
  body: Record<string, unknown>,
): void {
  if (!store.get(id)) return sendJson(res, 404, { error: "not found" });
  const sessionId =
    typeof body.id === "string" && body.id.length > 0
      ? body.id
      : SandboxStore.newSessionId();
  if (store.getSession(id, sessionId)) {
    return sendJson(res, 409, { error: "session already exists" });
  }
  const session: SessionInfo = {
    sessionId,
    cwd: typeof body.cwd === "string" ? body.cwd : "/workspace",
    env: (body.env as Record<string, string>) ?? {},
    createdAt: new Date().toISOString(),
  };
  store.addSession(id, session);
  return sendJson(res, 201, session);
}

function setSessionEnv(
  res: ServerResponse,
  { store }: Pick<Deps, "store">,
  id: string,
  sessionId: string,
  body: Record<string, unknown>,
): void {
  if (!store.get(id)) return sendJson(res, 404, { error: "not found" });
  const session = store.getSession(id, sessionId);
  if (!session) return sendJson(res, 404, { error: "session not found" });
  const env = (body.env as Record<string, string>) ?? {};
  session.env = { ...session.env, ...env };
  store.addSession(id, session); // write-through the env change
  return sendJson(res, 200, session);
}

function deleteSession(
  res: ServerResponse,
  { store }: Pick<Deps, "store">,
  id: string,
  sessionId: string,
): void {
  if (!store.get(id)) return sendJson(res, 404, { error: "not found" });
  const removed = store.removeSession(id, sessionId);
  if (!removed) return sendJson(res, 404, { error: "session not found" });
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
