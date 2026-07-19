import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { openSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { HotcellClient } from "@hotcell/sdk";
import type { GlobalArgs } from "./cli.js";
import { HOME, configExists, writeConfigFile } from "./configfile.js";

/**
 * The "engine" (long-running daemon) lifecycle: `hotcell start | stop | status`.
 *
 * `start` runs the daemon detached in the background, streams its logs to a file,
 * and returns the terminal — no more blocking foreground process. It waits until
 * the daemon is actually accepting requests before reporting success (so an agent
 * can safely `hotcell start && hotcell create`), and is idempotent (a second
 * `start` just reports the running one). `--foreground` keeps the old behavior for
 * debugging. Sandbox-level start/stop are dispatched separately (arity in cli.ts).
 */

const PIDFILE = join(HOME, "daemon.pid");
const LOGFILE = join(HOME, "daemon.log");

const tty = () => process.stdout.isTTY && !process.env.NO_COLOR;
const green = (s: string) => (tty() ? `\x1b[38;5;114m${s}\x1b[0m` : s);
const red = (s: string) => (tty() ? `\x1b[38;5;203m${s}\x1b[0m` : s);
const dim = (s: string) => (tty() ? `\x1b[38;5;244m${s}\x1b[0m` : s);

function daemonEntry(): string {
  return createRequire(import.meta.url).resolve("@hotcell/daemon");
}

export async function isUp(endpoint: string): Promise<boolean> {
  try {
    const r = await fetch(`${endpoint}/healthz`, { signal: AbortSignal.timeout(1000) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function startEngine(
  globals: GlobalArgs,
  flags: Record<string, string | boolean>,
): Promise<number> {
  const client = new HotcellClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });
  const endpoint = client.endpoint;

  if (await isUp(endpoint)) {
    console.log(`${green("● hotcell already running")}   ${dim("·")}   ${endpoint}`);
    return 0; // idempotent
  }

  // Very first start, human at the terminal: surface the daemon-level defaults
  // once before they silently apply (they're start-time decisions). Only the
  // advertised keys act: Enter accepts + persists, `c` opens the full wizard,
  // Esc/q aborts without writing. `--defaults` skips the prompt. Non-TTY
  // (agents/scripts) never sees this and never writes config.
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  if (!flags.defaults && !flags.foreground && !flags.fg && !configExists() && interactive) {
    console.log(
      `first start — defaults: ${dim("local-only · egress open · containers · hotcell-base image")}`,
    );
    console.log(dim(`  ⏎ start with these   ·   c configure (hotcell setup)   ·   q abort`));
    const { readKey } = await import("./prompts.js");
    for (;;) {
      const k = await readKey();
      if (k === "\r" || k === "\n") break; // accept defaults
      if (k === "c" || k === "C") {
        const { setupCommand } = await import("./setup.js");
        return setupCommand(globals, flags);
      }
      if (k === "q" || k === "Q" || k === "\x1b") {
        console.log(dim("aborted — nothing written, nothing started"));
        return 1;
      }
      // any other key: ignore, keep waiting for an advertised one
    }
    writeConfigFile({}); // defaults, by explicit choice — never asks again
  }
  // --defaults persists the choice only for a human (TTY): for agents it's a
  // pure no-op flag, so a headless run can never suppress the first-run wizard.
  if (flags.defaults === true && !configExists() && interactive) writeConfigFile({});

  // Foreground (debug): run the daemon in this process and block, as `hotcelld` does.
  if (flags.foreground || flags.fg) {
    await import(daemonEntry());
    return new Promise<number>(() => {}); // the daemon owns the process lifetime
  }

  mkdirSync(HOME, { recursive: true });
  const out = openSync(LOGFILE, "a");
  const child = spawn(process.execPath, ["--no-warnings", daemonEntry()], {
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });
  writeFileSync(PIDFILE, String(child.pid ?? ""));
  child.unref();

  for (let i = 0; i < 30; i++) {
    if (await isUp(endpoint)) {
      console.log(`${green("● hotcell started")}   ${dim("·")}   ${endpoint}   ${dim("·")}   ${dim(`logs: ${LOGFILE}`)}`);
      console.log(dim(`  stop it: hotcell stop`));
      return 0;
    }
    await sleep(500);
  }
  console.error(red(`hotcell failed to become ready in 15s — check ${LOGFILE}`));
  return 1;
}

export async function stopEngine(globals: GlobalArgs): Promise<number> {
  const client = new HotcellClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });
  let stopped = false;

  if (existsSync(PIDFILE)) {
    const pid = Number(readFileSync(PIDFILE, "utf8").trim());
    if (pid > 0) {
      try {
        process.kill(pid, "SIGTERM");
        stopped = true;
      } catch {
        /* already gone */
      }
    }
    rmSync(PIDFILE, { force: true });
  }

  if (stopped) {
    // Wait until it is actually DOWN (up to ~15s — draining sandbox ops can take
    // a while) and say so honestly: a caller that restarts (setup) must not race
    // a dying daemon into startEngine's "already running" check.
    for (let i = 0; i < 50 && (await isUp(client.endpoint)); i++) await sleep(300);
    if (await isUp(client.endpoint)) {
      console.error(red(`hotcell is still shutting down — try again in a moment`));
      return 1;
    }
    console.log(`${green("● hotcell stopped")}`);
    return 0;
  }
  // No pidfile. If something IS answering, it's a daemon we didn't start — say
  // so instead of claiming "stopped" while it keeps running with old config.
  if (await isUp(client.endpoint)) {
    console.error(
      red(`a daemon is running at ${client.endpoint} but wasn't started by \`hotcell start\` — stop that process yourself`),
    );
    return 1;
  }
  console.log(dim("○ hotcell was not running"));
  return 0; // idempotent
}

export async function engineStatus(globals: GlobalArgs): Promise<number> {
  const client = new HotcellClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });
  if (!(await isUp(client.endpoint))) {
    console.log(`${dim("○ not running")}   ${dim("— start it: hotcell start")}`);
    return 1;
  }
  try {
    const [info, cap] = await Promise.all([client.info(), client.capacity().catch(() => null)]);
    console.log(`${green("● running")}   ${dim("·")}   ${client.endpoint}   ${dim("·")}   driver ${info.driver}`);
    if (cap && (cap.enforced || cap.memory.budgetMb > 0)) {
      const gb = (mb: number) => (mb / 1024).toFixed(1);
      const low = cap.memory.availableMb < cap.memory.budgetMb * 0.1;
      const mem = `mem ${gb(cap.memory.committedMb)}/${gb(cap.memory.budgetMb)} GB`;
      console.log(`  ${cap.running} sandboxes   ${dim("·")}   ${low ? red(mem) : mem}   ${dim("·")}   ~${cap.fits} more fit`);
    }
    return 0;
  } catch {
    console.log(green("● running") + `   ${dim("·")}   ${client.endpoint}`);
    return 0;
  }
}
