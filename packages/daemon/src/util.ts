import { timingSafeEqual } from "node:crypto";
import type { ServerResponse } from "node:http";

/** Normalize any thrown value to a message string. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Single-quote a value for safe interpolation into a shell command. */
export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

/** Thrown when a request body exceeds the configured cap (→ HTTP 413). */
export class BodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "BodyTooLargeError";
  }
}

/**
 * Read a request body fully into a Buffer, aborting with `BodyTooLargeError`
 * once it would exceed `maxBytes`. Shared by the REST API and egress gateway so
 * neither can be made to buffer unbounded memory from one request.
 */
export async function readBodyCapped(
  req: { [Symbol.asyncIterator](): AsyncIterator<unknown> },
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > maxBytes) throw new BodyTooLargeError();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Constant-time string equality for secrets (API keys, preview tokens). Avoids
 * the early-exit timing leak of `===`. The length comparison is intentional and
 * standard — `timingSafeEqual` requires equal-length buffers.
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Send a JSON response with the correct Content-Length. */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Send a `text/plain` response (one trailing newline) with Content-Length. */
export function sendText(res: ServerResponse, status: number, message: string): void {
  const body = message + "\n";
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}
