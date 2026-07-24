/**
 * Dependency-free check for the `hotcell start` failure-surfacing logic. Run:
 * `npm run check:startup`.
 *
 * Guards the UX contract that a failed `hotcell start` shows the daemon's OWN
 * actionable reason (Docker not running, VZ helper not built, …) instead of a
 * generic "failed to become ready" timeout. The daemon writes that reason to its
 * log before exiting; `explainStartupFailure` extracts it back out, and it must
 * handle BOTH log formats (`pretty` by default, `json` under HOTCELL_LOG_FORMAT)
 * and correctly un-escape a message that itself contains quotes (the VZ helper
 * path). Also guards that `formatError` only appends the "start it" hint for a
 * daemon-unreachable error, so everyday commands (`hotcell ls`) gain the hint
 * without changing every other error.
 *
 * Runs entirely in-process — no pty, no daemon, no Docker.
 */

import assert from "node:assert/strict";
import { explainStartupFailure } from "./engine.js";
import { formatError } from "./util.js";

let checks = 0;
const ok = (msg: string) => {
  checks++;
  console.log(`  ✓ ${msg}`);
};

// ANSI tags exactly as the daemon logger emits them (logger.ts PRETTY_TAG).
const ERR = "\x1b[31mERR\x1b[0m";
const WRN = "\x1b[33mWRN\x1b[0m";
const INF = "\x1b[32mINF\x1b[0m";

/** Mirror the daemon logger's field rendering (formatVal): quote if whitespace. */
function fmtVal(v: string): string {
  return /\s/.test(v) ? JSON.stringify(v) : v;
}

/** A `pretty`-format log line, as the daemon writes it to its log. */
function pretty(tag: string, msg: string, fields: Record<string, string> = {}): string {
  const extra = Object.entries(fields)
    .map(([k, v]) => `${k}=${fmtVal(v)}`)
    .join(" ");
  return `12:00:00.123 ${tag} ${msg}${extra ? " " + extra : ""}`;
}

/** A `json`-format log line. */
function json(level: string, msg: string, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts: "2026-07-25T12:00:00.123Z", level, msg, ...fields });
}

// The real driver-preflight messages the daemon produces (see the driver ping()s).
const DOCKER_MSG =
  "You need to start Docker first — launch Docker Desktop (or colima, or Apple 'container'), " +
  "then run 'hotcell start' again. (underlying: connect ENOENT /var/run/docker.sock)";
// NB: this one embeds double quotes around the helper path — the escaping torture test.
const VZ_MSG =
  'The Apple VZ helper (hotcell-vz) isn\'t built yet — it\'s missing at "/opt/hotcell-vz". ' +
  "Run 'npm run build:vz' to build it, then run 'hotcell start' again. (underlying: spawn /opt/hotcell-vz ENOENT)";

const CONTAINER_HDR = `couldn't start the "container" driver`;
const VZ_HDR = `couldn't start the "applevz" driver`;

function checkExplain(): void {
  // pretty format, Docker down.
  assert.deepEqual(
    explainStartupFailure(pretty(ERR, CONTAINER_HDR, { error: DOCKER_MSG })),
    [DOCKER_MSG],
    "pretty Docker-down → actionable line",
  );
  ok("extracts the Docker reason from a pretty log line");

  // json format, Docker down.
  assert.deepEqual(
    explainStartupFailure(json("error", CONTAINER_HDR, { error: DOCKER_MSG })),
    [DOCKER_MSG],
    "json Docker-down → actionable line",
  );
  ok("extracts the Docker reason from a json log line");

  // pretty format, VZ helper missing — message contains embedded quotes.
  assert.deepEqual(
    explainStartupFailure(pretty(ERR, VZ_HDR, { error: VZ_MSG })),
    [VZ_MSG],
    "pretty applevz-missing → un-escaped actionable line",
  );
  ok("un-escapes an embedded-quote VZ message from a pretty line");

  // json format, VZ helper missing.
  assert.deepEqual(
    explainStartupFailure(json("error", VZ_HDR, { error: VZ_MSG })),
    [VZ_MSG],
    "json applevz-missing → actionable line",
  );
  ok("extracts the VZ reason from a json log line");

  // Only error/warn lines survive; info is dropped; the error field wins over msg.
  const mixed = [
    pretty(INF, "daemon booting", { pid: "123" }),
    pretty(ERR, CONTAINER_HDR, { error: DOCKER_MSG }),
  ].join("\n");
  assert.deepEqual(explainStartupFailure(mixed), [DOCKER_MSG], "info filtered, error kept");
  ok("drops info lines and keeps the error reason");

  // A warn line is surfaced too.
  assert.deepEqual(
    explainStartupFailure(pretty(WRN, "low on memory")),
    ["low on memory"],
    "warn surfaced",
  );
  ok("surfaces warn lines");

  // A message with no `error=` field falls back to the message text.
  assert.deepEqual(
    explainStartupFailure(pretty(ERR, "port 4750 is already in use")),
    ["port 4750 is already in use"],
    "msg-only fallback",
  );
  ok("falls back to the message when there is no error field");

  // Duplicate reasons are de-duplicated.
  const dup = [
    pretty(ERR, CONTAINER_HDR, { error: DOCKER_MSG }),
    pretty(ERR, CONTAINER_HDR, { error: DOCKER_MSG }),
  ].join("\n");
  assert.deepEqual(explainStartupFailure(dup), [DOCKER_MSG], "deduped");
  ok("de-duplicates repeated reasons");

  // Nothing usable → empty (caller falls back to the log path).
  assert.deepEqual(explainStartupFailure(""), [], "empty slice");
  assert.deepEqual(explainStartupFailure("random\nnon-log\ntext"), [], "non-log text");
  ok("returns [] when there is nothing actionable to show");
}

function checkFormatError(): void {
  const unreachable = new Error("The hotcell daemon isn't running (couldn't reach it at http://127.0.0.1:4750).");
  (unreachable as { code?: string }).code = "DAEMON_UNREACHABLE";
  const out = formatError(unreachable);
  assert.ok(out.includes("start it: hotcell start"), "unreachable → adds the start hint");
  assert.ok(out.startsWith(unreachable.message), "unreachable → keeps the original message");
  ok("appends 'start it: hotcell start' for an unreachable daemon");

  const plain = new Error("sandbox provisioning failed: boom");
  assert.equal(formatError(plain), "sandbox provisioning failed: boom", "plain error unchanged");
  ok("leaves unrelated errors untouched (no spurious hint)");
}

function main(): void {
  checkExplain();
  checkFormatError();
  console.log(`\nstartup-check: ${checks} checks passed`);
}

try {
  main();
  process.exit(0);
} catch (err) {
  console.error("startup-check FAILED:", err);
  process.exit(1);
}
