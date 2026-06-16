import type { LogFormat, LogLevel } from "./config.js";

/**
 * Tiny dependency-free structured logger. Emits either one JSON object per line
 * (machine-friendly, the Phase 2 "structured logs" deliverable) or a coloured
 * human line for local dev. A single process-wide logger is configured at
 * startup via `configureLogger`; modules import `log` and use it directly so we
 * don't thread a logger through every call site.
 */

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Derive a logger that stamps `fields` onto every line (e.g. a request id). */
  child(fields: LogFields): Logger;
}

class JsonLogger implements Logger {
  constructor(
    private readonly level: LogLevel,
    private readonly format: LogFormat,
    private readonly base: LogFields = {},
  ) {}

  child(fields: LogFields): Logger {
    return new JsonLogger(this.level, this.format, { ...this.base, ...fields });
  }

  debug(msg: string, fields?: LogFields): void {
    this.emit("debug", msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.emit("info", msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.emit("warn", msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.emit("error", msg, fields);
  }

  private emit(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.level]) return;
    const merged = { ...this.base, ...fields };
    // Logs go to stderr so they never intermix with a command's piped stdout.
    if (this.format === "json") {
      process.stderr.write(
        JSON.stringify({ ts: new Date().toISOString(), level, msg, ...merged }) + "\n",
      );
      return;
    }
    const ts = new Date().toISOString().slice(11, 23);
    const tag = PRETTY_TAG[level];
    const extra = Object.entries(merged)
      .map(([k, v]) => `${k}=${formatVal(v)}`)
      .join(" ");
    process.stderr.write(`${ts} ${tag} ${msg}${extra ? " " + extra : ""}\n`);
  }
}

const PRETTY_TAG: Record<LogLevel, string> = {
  debug: "\x1b[90mDBG\x1b[0m",
  info: "\x1b[32mINF\x1b[0m",
  warn: "\x1b[33mWRN\x1b[0m",
  error: "\x1b[31mERR\x1b[0m",
};

function formatVal(v: unknown): string {
  if (typeof v === "string") return /\s/.test(v) ? JSON.stringify(v) : v;
  return JSON.stringify(v);
}

/** Process-wide logger. Replaced by `configureLogger`; defaults are quiet-ish. */
export let log: Logger = new JsonLogger("info", "pretty");

export function configureLogger(opts: { level: LogLevel; format: LogFormat }): Logger {
  log = new JsonLogger(opts.level, opts.format);
  return log;
}
