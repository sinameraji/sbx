import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Config } from "../config.js";
import { log } from "../logger.js";
import type { SandboxStore } from "../store.js";
import { startSpan } from "../tracing.js";
import { BodyTooLargeError, readBodyCapped, sendJson, sendText } from "../util.js";

/**
 * Egress credential proxy — an LLM gateway, not a TLS-MITM forward proxy.
 *
 * Sandboxes call `http://<egress>/<provider>/<path>` with a per-sandbox **egress
 * token** in place of a real key (e.g. `OPENAI_BASE_URL=http://egress/openai`,
 * `OPENAI_API_KEY=<egress-token>`). The gateway resolves the token to a sandbox,
 * injects the **real provider key** (held on the daemon host, never inside the
 * sandbox), forwards to the provider, and meters the call (bytes + parsed
 * prompt/completion tokens). This gives "reach any LLM provider without baking in
 * keys" + per-sandbox cost/observability, with no CA/cert install (which a
 * transparent HTTPS forward proxy would require).
 */

export interface ResolvedProvider {
  /** Upstream base URL, e.g. `https://api.openai.com`. */
  baseUrl: string;
  /** Header the provider authenticates with (e.g. `authorization`, `x-api-key`). */
  authHeader: string;
  /** Render the auth header value from the real key (e.g. `Bearer ${k}`). */
  format: (key: string) => string;
  /** The real provider key, injected on every forwarded call. */
  apiKey: string;
}

/** Built-in providers: base URL + auth header shape. Keyed by lower-case name. */
const PROVIDER_DEFAULTS: Record<string, Omit<ResolvedProvider, "apiKey">> = {
  openai: {
    baseUrl: "https://api.openai.com",
    authHeader: "authorization",
    format: (k) => `Bearer ${k}`,
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com",
    authHeader: "x-api-key",
    format: (k) => k,
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api",
    authHeader: "authorization",
    format: (k) => `Bearer ${k}`,
  },
};

/** Build the provider registry from configured keys (only keyed providers exist). */
export function buildProviders(config: Config): Record<string, ResolvedProvider> {
  const providers: Record<string, ResolvedProvider> = {};
  for (const [name, apiKey] of Object.entries(config.providerKeys)) {
    const def = PROVIDER_DEFAULTS[name];
    if (def && apiKey) providers[name] = { ...def, apiKey };
  }
  return providers;
}

interface Deps {
  config: Config;
  store: SandboxStore;
  providers: Record<string, ResolvedProvider>;
}

export function createEgressProxy(deps: Deps): Server {
  return createServer((req, res) => {
    handle(req, res, deps).catch((err) => {
      sendText(res, 500, `egress proxy error: ${String(err?.message ?? err)}`);
    });
  });
}

const HOP_REQUEST = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "x-sbx-egress",
  "authorization",
]);
const HOP_RESPONSE = new Set([
  "content-encoding",
  "transfer-encoding",
  "content-length",
  "connection",
]);
const USAGE_PARSE_CAP = 256 * 1024;

async function handle(req: IncomingMessage, res: ServerResponse, deps: Deps): Promise<void> {
  const { store, providers } = deps;
  const url = new URL(req.url ?? "/", "http://egress.local");

  if (url.pathname === "/healthz") {
    return sendJson(res, 200, { ok: true, providers: Object.keys(providers) });
  }

  const match = url.pathname.match(/^\/([^/]+)\/(.*)$/);
  if (!match) {
    return sendText(res, 404, "route: /<provider>/<path>");
  }
  const [, providerName, rest] = match;

  const token = extractToken(req);
  if (!token) return sendText(res, 401, "missing egress token");
  const sandboxId = store.resolveEgressToken(token);
  if (!sandboxId) return sendText(res, 403, "invalid egress token");

  const provider = providers[providerName];
  if (!provider) return sendText(res, 404, `unknown provider: ${providerName}`);

  store.touch(sandboxId);
  const span = startSpan("egress.provider_call", {
    "sandbox.id": sandboxId,
    "egress.provider": providerName,
  });

  const upstreamUrl = provider.baseUrl.replace(/\/$/, "") + "/" + rest + (url.search || "");
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_REQUEST.has(k.toLowerCase()) || v == null) continue;
    headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  headers.set(provider.authHeader, provider.format(provider.apiKey));

  const method = req.method ?? "GET";
  let reqBody: Buffer | undefined;
  try {
    reqBody =
      method === "GET" || method === "HEAD"
        ? undefined
        : await readBodyCapped(req, deps.config.maxBodyBytes);
  } catch (err) {
    if (err instanceof BodyTooLargeError) return sendText(res, 413, "request body too large");
    throw err;
  }
  let bytes = reqBody?.length ?? 0;

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, { method, headers, body: reqBody });
  } catch (err) {
    span.setStatus("error").end();
    return sendText(res, 502, `upstream fetch failed: ${String(err)}`);
  }

  const respHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    if (!HOP_RESPONSE.has(key.toLowerCase())) respHeaders[key] = value;
  });
  res.writeHead(upstream.status, respHeaders);

  // Stream the response through to the sandbox (so token-by-token streaming still
  // works) while keeping a rolling TAIL copy to parse usage from — token counts
  // and the OpenRouter `usage.cost` live in the final chunk (the last SSE frame
  // for streaming, the end of the body for a JSON response), so the tail, not the
  // head, is what we need.
  const tail: Buffer[] = [];
  let tailBytes = 0;
  if (upstream.body) {
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      res.write(buf);
      bytes += buf.length;
      tail.push(buf);
      tailBytes += buf.length;
      while (tail.length > 1 && tailBytes - (tail[0]?.length ?? 0) >= USAGE_PARSE_CAP) {
        const dropped = tail.shift();
        tailBytes -= dropped?.length ?? 0;
      }
    }
  }
  res.end();

  const { tokensIn, tokensOut, cost } = parseUsage(Buffer.concat(tail));
  store.addProviderUsage(sandboxId, { bytes, tokensIn, tokensOut, cost });
  span
    .setAttribute("http.status_code", upstream.status)
    .setAttribute("egress.tokens_in", tokensIn)
    .setAttribute("egress.tokens_out", tokensOut)
    .setAttribute("egress.cost", cost);
  if (upstream.status >= 500) span.setStatus("error");
  span.end();
  log.info("egress call", {
    sandbox: sandboxId,
    provider: providerName,
    status: upstream.status,
    bytes,
    tokensIn,
    tokensOut,
    cost,
    traceId: span.traceId,
  });
}

/** Pull the egress token from `X-Sbx-Egress` or a Bearer Authorization header. */
function extractToken(req: IncomingMessage): string | undefined {
  const direct = req.headers["x-sbx-egress"];
  if (typeof direct === "string" && direct) return direct;
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);
  return undefined;
}

interface ParsedUsage {
  tokensIn: number;
  tokensOut: number;
  /** Provider-reported cost in USD (OpenRouter `usage.cost`); 0 if not reported. */
  cost: number;
}

/**
 * Best-effort usage accounting from the provider's response. Reads the `usage`
 * object — token counts (OpenAI `prompt_tokens`/`completion_tokens` or Anthropic
 * `input_tokens`/`output_tokens`) and the **authoritative USD cost** OpenRouter
 * reports as `usage.cost` — from a JSON body or the last SSE `data:` frame.
 */
function parseUsage(buf: Buffer): ParsedUsage {
  const text = buf.toString("utf8");
  const fromObj = (o: any): ParsedUsage | null => {
    const u = o?.usage;
    if (!u) return null;
    const inn = u.prompt_tokens ?? u.input_tokens;
    const out = u.completion_tokens ?? u.output_tokens;
    const cost = u.cost; // OpenRouter: real USD cost, inline in every response
    if (inn == null && out == null && cost == null) return null;
    return { tokensIn: Number(inn || 0), tokensOut: Number(out || 0), cost: Number(cost || 0) };
  };
  try {
    const whole = fromObj(JSON.parse(text));
    if (whole) return whole;
  } catch {
    // not a single JSON object; fall through to SSE scan
  }
  let best: ParsedUsage | null = null;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const r = fromObj(JSON.parse(payload));
      if (r) best = r;
    } catch {
      // skip non-JSON frames
    }
  }
  return best ?? { tokensIn: 0, tokensOut: 0, cost: 0 };
}

