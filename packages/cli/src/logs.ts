import { SbxClient } from "@sbx/sdk";
import type { GlobalArgs } from "./cli.js";

/** sb logs <id> <procId> [--follow] */
export async function logsCommand(
  positional: string[],
  globals: GlobalArgs,
  flags: Record<string, string | boolean>,
): Promise<number> {
  const [id, procId] = positional;
  if (!id || !procId) {
    console.error("Usage: sb logs <id> <procId> [--follow]");
    return 1;
  }
  const client = new SbxClient({ endpoint: globals.endpoint });
  try {
    const sandbox = await client.getSandbox(id);
    for await (const chunk of sandbox.streamLogs(procId, {
      follow: flags.follow === true,
    })) {
      process.stdout.write(chunk);
    }
    return 0;
  } catch (err) {
    console.error(`Failed: ${formatError(err)}`);
    return 1;
  }
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
