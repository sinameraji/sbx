import { SbxClient } from "@sbx/sdk";
import type { GlobalArgs } from "./cli.js";
import { parseEnvPairs } from "./env.js";

/** sb start <id> "<command>" [--cwd <dir>] [--env KEY=VAL,...] */
export async function startCommand(
  positional: string[],
  globals: GlobalArgs,
  flags: Record<string, string | boolean>,
): Promise<number> {
  const [id, command] = positional;
  if (!id || !command) {
    console.error('Usage: sb start <id> "<command>" [--cwd <dir>] [--env KEY=VAL,...]');
    return 1;
  }
  const client = new SbxClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });
  try {
    let env: Record<string, string> | undefined;
    if (typeof flags.env === "string") env = parseEnvPairs(flags.env.split(","));
    const sandbox = await client.getSandbox(id);
    const proc = await sandbox.startProcess(command, {
      cwd: typeof flags.cwd === "string" ? flags.cwd : undefined,
      env,
    });
    console.log(`Started ${proc.procId} (pid ${proc.pid}).`);
    return 0;
  } catch (err) {
    console.error(`Failed: ${formatError(err)}`);
    return 1;
  }
}

/** sb ps <id> */
export async function psCommand(
  positional: string[],
  globals: GlobalArgs,
): Promise<number> {
  const [id] = positional;
  if (!id) {
    console.error("Usage: sb ps <id>");
    return 1;
  }
  const client = new SbxClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });
  try {
    const sandbox = await client.getSandbox(id);
    const procs = await sandbox.listProcesses();
    if (procs.length === 0) {
      console.log("No processes.");
      return 0;
    }
    console.log(
      `${padRight("PROCID", 10)} ${padRight("PID", 8)} ${padRight("STATUS", 8)} COMMAND`,
    );
    for (const p of procs) {
      console.log(
        `${padRight(p.procId, 10)} ${padRight(String(p.pid), 8)} ${padRight(p.status, 8)} ${p.command}`,
      );
    }
    return 0;
  } catch (err) {
    console.error(`Failed: ${formatError(err)}`);
    return 1;
  }
}

/** sb kill <id> <procId> [--signal <SIG>] */
export async function killCommand(
  positional: string[],
  globals: GlobalArgs,
  flags: Record<string, string | boolean>,
): Promise<number> {
  const [id, procId] = positional;
  if (!id || !procId) {
    console.error("Usage: sb kill <id> <procId> [--signal <SIG>]");
    return 1;
  }
  const client = new SbxClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });
  try {
    const sandbox = await client.getSandbox(id);
    await sandbox.killProcess(
      procId,
      typeof flags.signal === "string" ? flags.signal : undefined,
    );
    console.log(`Killed ${procId}.`);
    return 0;
  } catch (err) {
    console.error(`Failed: ${formatError(err)}`);
    return 1;
  }
}

function padRight(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
