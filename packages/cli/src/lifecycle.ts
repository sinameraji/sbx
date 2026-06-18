import { SbxClient } from "@sbx/sdk";
import { formatError } from "./util.js";
import type { GlobalArgs } from "./cli.js";

export async function stopCommand(
  positional: string[],
  globals: GlobalArgs,
): Promise<number> {
  const id = positional[0];
  if (!id) {
    console.error("Usage: sb stop <id>");
    return 1;
  }

  const client = new SbxClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });
  try {
    const sandbox = await client.getSandbox(id);
    await sandbox.stop();
    console.log(`Stopped sandbox ${id} (workspace preserved).`);
    return 0;
  } catch (err) {
    console.error(`Failed to stop sandbox: ${formatError(err)}`);
    return 1;
  }
}

export async function startSandboxCommand(
  positional: string[],
  globals: GlobalArgs,
): Promise<number> {
  const id = positional[0];
  if (!id) {
    console.error("Usage: sb start <id>");
    return 1;
  }

  const client = new SbxClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });
  try {
    const sandbox = await client.getSandbox(id);
    await sandbox.start();
    console.log(`Started sandbox ${id}.`);
    return 0;
  } catch (err) {
    console.error(`Failed to start sandbox: ${formatError(err)}`);
    return 1;
  }
}
