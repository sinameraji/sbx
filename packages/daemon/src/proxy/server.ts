import { createServer, type Server, type Socket } from "node:net";
import type { Config } from "../config.js";
import type { Driver } from "../driver/types.js";
import type { RouteTarget, SandboxStore } from "../store.js";

interface Deps {
  config: Config;
  driver: Driver;
  store: SandboxStore;
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
 *   - path (curl): GET /_sbx/<id>/<port>/...  (prefix rewritten on the first
 *     request line; absolute-path assets won't resolve, so subdomain is primary)
 */
export function createProxyServer({ config, driver, store }: Deps): Server {
  return createServer((socket) => {
    handleConnection(socket, { config, driver, store }).catch(() => {
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
      return respond(socket, 404, "No sbx preview route for this host");
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
  { driver, store }: Deps,
): Promise<void> {
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

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
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

  // 2) Path-based fallback: /_sbx/<id>/<port>/...
  const pathMatch = target.match(/^\/_sbx\/([^/]+)\/(\d+)(\/.*)?$/);
  if (pathMatch) {
    const exposeId = `${pathMatch[1]}-${pathMatch[2]}`;
    const route = store.resolveRoute(exposeId);
    if (route) {
      const prefix = `/_sbx/${pathMatch[1]}/${pathMatch[2]}`;
      return { target: route, rewrite: { from: prefix, to: "" } };
    }
  }

  return undefined;
}

/** Strip the `/_sbx/<id>/<port>` prefix from the first request line's target. */
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

function hasToken(headerText: string, token: string): boolean {
  const lower = headerText.toLowerCase();
  return (
    lower.includes(`token=${token.toLowerCase()}`) ||
    lower.includes(`authorization: bearer ${token.toLowerCase()}`)
  );
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
    default:
      return "Error";
  }
}
