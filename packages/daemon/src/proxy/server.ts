import { createServer, type Server, type Socket } from "node:net";
import { CapacityError, type Capacity } from "../capacity.js";
import type { Config } from "../config.js";
import type { Driver } from "../driver/types.js";
import { resumeSandbox } from "../lifecycle.js";
import type { RouteTarget, SandboxStore } from "../store.js";
import { safeEqual } from "../util.js";

interface Deps {
  config: Config;
  driver: Driver;
  store: SandboxStore;
  capacity?: Capacity;
}

/**
 * Preview-URL reverse proxy.
 *
 * A connection-level (L4) splice: we read just the first request's header block
 * to learn the route, then pipe raw bytes between the client socket and a byte
 * bridge into the sandbox. Because the bridge is a hijacked `docker exec`, this
 * works even where container IPs are unreachable from the host (macOS Docker
 * Desktop). Splicing at L4 means HTTP keep-alive, WebSocket upgrades, binary
 * uploads and chunked responses all pass through untouched.
 *
 * Routing (resolved once per connection from the first request):
 *   - subdomain:   Host: <id>-<port>.localhost[:proxyPort]
 *   - path (curl): GET /_hotcell/<id>/<port>/...  (prefix rewritten on the first
 *     request line; absolute-path assets won't resolve, so subdomain is primary)
 */
export function createProxyServer(deps: Deps): Server {
  return createServer((socket) => {
    handleConnection(socket, deps).catch(() => {
      socket.destroy();
    });
  });
}

const MAX_HEADER_BYTES = 64 * 1024;

async function handleConnection(socket: Socket, deps: Deps): Promise<void> {
  let buffer = Buffer.alloc(0);

  const onData = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      if (buffer.length > MAX_HEADER_BYTES) {
        respond(socket, 431, "Request Header Fields Too Large");
      }
      return;
    }
    socket.removeListener("data", onData);
    socket.pause();

    const headerText = buffer.subarray(0, headerEnd).toString("utf8");
    const resolved = resolveRoute(headerText, deps.store);
    if (!resolved) {
      return respond(socket, 404, "No hotcell preview route for this host");
    }
    if (resolved.target.token && !hasToken(headerText, resolved.target.token)) {
      return respond(socket, 403, "Missing or invalid preview token");
    }

    // Apply any first-line rewrite (path-based routing strips the prefix).
    const forwardBuffer =
      resolved.rewrite && headerEnd >= 0
        ? rewriteFirstLine(buffer, resolved.rewrite.from, resolved.rewrite.to)
        : buffer;

    void bridgeAndSplice(socket, forwardBuffer, resolved.target, deps);
  };

  socket.on("data", onData);
  socket.on("error", () => socket.destroy());
}

async function bridgeAndSplice(
  socket: Socket,
  initial: Buffer,
  target: RouteTarget,
  { driver, store, capacity }: Deps,
): Promise<void> {
  // Inbound preview traffic transparently wakes a paused sandbox — with a
  // memory-snapshot pause the serving process comes back alive, which is what
  // lets the idle reaper hibernate port-exposing sandboxes on snapshot-capable
  // drivers (see lifecycle.reapIdle). A `stopped` sandbox is user intent and
  // stays down.
  const record = store.get(target.sandboxId);
  if (record?.status === "stopped") {
    return respond(socket, 502, "Sandbox is stopped; start it first");
  }
  if (record?.status === "creating" || record?.status === "error") {
    return respond(socket, 502, "Sandbox is not ready");
  }
  if (record?.status === "paused") {
    try {
      await resumeSandbox(driver, store, record, capacity);
    } catch (err) {
      // An admission refusal is back-pressure (host budget), not a broken hop.
      if (err instanceof CapacityError) return respond(socket, 503, err.reason);
      return respond(socket, 502, "Failed to resume the paused sandbox");
    }
  }
  // Proxied traffic counts as activity so the idle reaper won't pause a sandbox
  // that's actively serving requests.
  store.touch(target.sandboxId);
  let bridge;
  try {
    bridge = await driver.openTcpBridge(target.sandboxId, target.port, "127.0.0.1");
  } catch {
    return respond(socket, 502, "Failed to reach sandbox port");
  }

  const { stream } = bridge;
  stream.write(initial);
  socket.pipe(stream);
  stream.pipe(socket);
  socket.resume();

  // Meter egress: bytes flowing from the sandbox out to the client. Accumulate
  // locally and flush once on close to avoid a DB write per chunk.
  let egress = 0;
  stream.on("data", (chunk: Buffer) => {
    egress += chunk.length;
  });

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    store.addEgress(target.sandboxId, egress);
    bridge.close();
    socket.destroy();
  };
  socket.on("error", close);
  socket.on("close", close);
  stream.on("error", close);
  stream.on("close", close);
}

interface ResolvedRoute {
  target: RouteTarget;
  rewrite?: { from: string; to: string };
}

function resolveRoute(
  headerText: string,
  store: SandboxStore,
): ResolvedRoute | undefined {
  const lines = headerText.split("\r\n");
  const requestLine = lines[0] ?? "";
  const target = requestLine.split(" ")[1] ?? "/";

  // 1) Subdomain routing via the Host header: <id>-<port>.localhost
  const hostLine = lines.find((l) => /^host:/i.test(l));
  if (hostLine) {
    const host = hostLine.slice(hostLine.indexOf(":") + 1).trim();
    const hostname = host.split(":")[0];
    const label = hostname.split(".")[0]; // leftmost label
    const route = store.resolveRoute(label);
    if (route) return { target: route };
  }

  // 2) Path-based fallback: /_hotcell/<id>/<port>/... (legacy /_sbx/ accepted).
  const pathMatch = target.match(/^\/(_hotcell|_sbx)\/([^/]+)\/(\d+)(\/.*)?$/);
  if (pathMatch) {
    const exposeId = `${pathMatch[2]}-${pathMatch[3]}`;
    const route = store.resolveRoute(exposeId);
    if (route) {
      const prefix = `/${pathMatch[1]}/${pathMatch[2]}/${pathMatch[3]}`;
      return { target: route, rewrite: { from: prefix, to: "" } };
    }
  }

  return undefined;
}

/** Strip the `/_hotcell/<id>/<port>` prefix from the first request line's target. */
function rewriteFirstLine(buffer: Buffer, from: string, _to: string): Buffer {
  const lineEnd = buffer.indexOf("\r\n");
  if (lineEnd === -1) return buffer;
  // The request line is ASCII; latin1 round-trips bytes safely.
  const firstLine = buffer.subarray(0, lineEnd).toString("latin1");
  const parts = firstLine.split(" ");
  if (parts.length < 3) return buffer;
  const [method, target, ...rest] = parts;
  const stripped = target.startsWith(from) ? target.slice(from.length) : target;
  const newTarget = stripped.length === 0 ? "/" : stripped;
  const newLine = `${method} ${newTarget} ${rest.join(" ")}`;
  return Buffer.concat([
    Buffer.from(newLine, "latin1"),
    buffer.subarray(lineEnd),
  ]);
}

/**
 * Check the per-port preview token, supplied as a `?token=` query param or an
 * `Authorization: Bearer <token>` header. Extracts the actual value and compares
 * it exactly in constant time (the old lowercased-substring match was both
 * case-insensitive and loose).
 */
function hasToken(headerText: string, token: string): boolean {
  const lines = headerText.split("\r\n");

  // 1) token= query param on the request line.
  const target = (lines[0] ?? "").split(" ")[1] ?? "";
  const q = target.indexOf("?");
  if (q !== -1) {
    const provided = new URLSearchParams(target.slice(q + 1)).get("token");
    if (provided && safeEqual(provided, token)) return true;
  }

  // 2) Authorization: Bearer <token>.
  const authLine = lines.find((l) => /^authorization:/i.test(l));
  if (authLine) {
    const m = /^bearer\s+(.+)$/i.exec(authLine.slice(authLine.indexOf(":") + 1).trim());
    if (m && safeEqual(m[1], token)) return true;
  }

  return false;
}

function respond(socket: Socket, status: number, message: string): void {
  const body = `${message}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${statusText(status)}\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      `Connection: close\r\n\r\n` +
      body,
  );
}

function statusText(status: number): string {
  switch (status) {
    case 403:
      return "Forbidden";
    case 404:
      return "Not Found";
    case 431:
      return "Request Header Fields Too Large";
    case 502:
      return "Bad Gateway";
    case 503:
      return "Service Unavailable";
    default:
      return "Error";
  }
}
