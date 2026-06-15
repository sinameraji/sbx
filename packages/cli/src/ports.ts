import { SbxClient } from "@sbx/sdk";
import type { GlobalArgs } from "./cli.js";

/** sb wait-port <id> <port> [--timeout <ms>] */
export async function waitPortCommand(
  positional: string[],
  globals: GlobalArgs,
  flags: Record<string, string | boolean>,
): Promise<number> {
  const [id, portArg] = positional;
  const port = Number(portArg);
  if (!id || !Number.isInteger(port) || port <= 0) {
    console.error("Usage: sb wait-port <id> <port> [--timeout <ms>]");
    return 1;
  }
  const client = new SbxClient({ endpoint: globals.endpoint });
  try {
    const sandbox = await client.getSandbox(id);
    const ready = await sandbox.waitForPort(port, {
      timeoutMs: typeof flags.timeout === "string" ? Number(flags.timeout) : undefined,
    });
    if (ready) {
      console.log(`Port ${port} is ready.`);
      return 0;
    }
    console.error(`Timed out waiting for port ${port}.`);
    return 1;
  } catch (err) {
    console.error(`Failed: ${formatError(err)}`);
    return 1;
  }
}

/** sb expose <id> <port> [--token <token>] */
export async function exposeCommand(
  positional: string[],
  globals: GlobalArgs,
  flags: Record<string, string | boolean>,
): Promise<number> {
  const [id, portArg] = positional;
  const port = Number(portArg);
  if (!id || !Number.isInteger(port) || port <= 0) {
    console.error("Usage: sb expose <id> <port> [--token <token>]");
    return 1;
  }
  const client = new SbxClient({ endpoint: globals.endpoint });
  try {
    const sandbox = await client.getSandbox(id);
    const exposed = await sandbox.exposePort(port, {
      token: typeof flags.token === "string" ? flags.token : undefined,
    });
    console.log(exposed.url);
    return 0;
  } catch (err) {
    console.error(`Failed: ${formatError(err)}`);
    return 1;
  }
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
