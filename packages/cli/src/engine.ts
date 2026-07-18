import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { openSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { HotcellClient } from "@hotcell/sdk";
import type { GlobalArgs } from "./cli.js";

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

const HOME = process.env.HOTCELL_HOME || join(homedir(), ".hotcell");
const PIDFILE = join(HOME, "daemon.pid");
const LOGFILE = join(HOME, "daemon.log");

const tty = () => process.stdout.isTTY && !process.env.NO_COLOR;
const green = (s: string) => (tty() ? `\x1b[38;5;114m${s}\x1b[0m` : s);
const red = (s: string) => (tty() ? `\x1b[38;5;203m${s}\x1b[0m` : s);
const dim = (s: string) => (tty() ? `\x1b[38;5;244m${s}\x1b[0m` : s);

function daemonEntry(): string {
  return createRequire(import.meta.url).resolve("@hotcell/daemon");
}

async function isUp(endpoint: string): Promise<boolean> {
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
    // give it a moment to release the port
    for (let i = 0; i < 10 && (await isUp(client.endpoint)); i++) await sleep(300);
    console.log(`${green("● hotcell stopped")}`);
    return 0;
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
