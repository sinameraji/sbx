import { HotcellClient } from "@hotcell/sdk";
import { formatError } from "./util.js";
import type { GlobalArgs } from "./cli.js";

/**
 * hotcell rm <id...> | --all — destroy one, several, or every sandbox.
 * Multi-id pairs with `create -n N` (spin up five cells, tear down five cells);
 * failures don't stop the rest, and the exit code reflects any failure.
 */
export async function removeCommand(
  positional: string[],
  globals: GlobalArgs,
  flags: Record<string, string | boolean> = {},
): Promise<number> {
  const client = new HotcellClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });

  let ids = positional;
  if (flags.all === true) {
    try {
      ids = (await client.list()).map((s) => s.id);
    } catch (err) {
      console.error(`Failed to list sandboxes: ${formatError(err)}`);
      return 1;
    }
    if (ids.length === 0) {
      console.log("no sandboxes to remove.");
      return 0;
    }
  }
  if (ids.length === 0) {
    console.error("Usage: hotcell rm <id...>   |   hotcell rm --all");
    return 1;
  }

  let failed = 0;
  for (const id of ids) {
    try {
      const sandbox = await client.getSandbox(id);
      await sandbox.destroy();
      console.log(`Destroyed sandbox ${id}.`);
    } catch (err) {
      failed++;
      console.error(`Failed to remove ${id}: ${formatError(err)}`);
    }
  }
  return failed ? 1 : 0;
}
