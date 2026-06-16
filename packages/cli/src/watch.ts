import { SbxClient } from "@sbx/sdk";
import type { GlobalArgs } from "./cli.js";

export async function watchCommand(
  positional: string[],
  globals: GlobalArgs,
  flags: Record<string, string | boolean>,
): Promise<number> {
  const id = positional[0];
  if (!id) {
    console.error("Usage: sb watch <id> [path] [--interval <ms>]");
    return 1;
  }
  const path = positional[1] ?? "/workspace";
  const intervalMs =
    typeof flags.interval === "string" ? Number(flags.interval) : undefined;

  const client = new SbxClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });
  try {
    const sandbox = await client.getSandbox(id);
    console.error(`[sb] watching ${path} in ${id} (Ctrl-C to stop)`);
    for await (const event of sandbox.watch(path, { intervalMs })) {
      console.log(`${event.type}\t${event.path}`);
    }
    return 0;
  } catch (err) {
    console.error(`Failed to watch: ${formatError(err)}`);
    return 1;
  }
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
