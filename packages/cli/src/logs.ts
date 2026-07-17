import { HotcellClient } from "@hotcell/sdk";
import { formatError } from "./util.js";
import type { GlobalArgs } from "./cli.js";

/** hotcell logs <id> <procId> [--follow] */
export async function logsCommand(
  positional: string[],
  globals: GlobalArgs,
  flags: Record<string, string | boolean>,
): Promise<number> {
  const [id, procId] = positional;
  if (!id || !procId) {
    console.error("Usage: hotcell logs <id> <procId> [--follow]");
    return 1;
  }
  const client = new HotcellClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });
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
