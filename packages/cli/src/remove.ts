import { SbxClient } from "@sbx/sdk";
import type { GlobalArgs } from "./cli.js";

export async function removeCommand(
  positional: string[],
  globals: GlobalArgs,
): Promise<number> {
  const id = positional[0];
  if (!id) {
    console.error("Usage: sb rm <id>");
    return 1;
  }

  const client = new SbxClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });

  try {
    const sandbox = await client.getSandbox(id);
    await sandbox.destroy();
    console.log(`Destroyed sandbox ${id}.`);
    return 0;
  } catch (err) {
    console.error(`Failed to remove sandbox: ${formatError(err)}`);
    return 1;
  }
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
