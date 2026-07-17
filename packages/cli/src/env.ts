import { HotcellClient } from "@hotcell/sdk";
import { formatError } from "./util.js";
import type { GlobalArgs } from "./cli.js";

/** hotcell env <id> [KEY=VALUE ...] — set sandbox env vars, or print them if none given. */
export async function envCommand(
  positional: string[],
  globals: GlobalArgs,
): Promise<number> {
  const [id, ...pairs] = positional;
  if (!id) {
    console.error("Usage: hotcell env <id> [KEY=VALUE ...]");
    return 1;
  }
  const client = new HotcellClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });
  try {
    const sandbox = await client.getSandbox(id);
    const env =
      pairs.length > 0
        ? await sandbox.setEnvVars(parseEnvPairs(pairs))
        : await sandbox.getEnvVars();
    const keys = Object.keys(env).sort();
    if (keys.length === 0) {
      console.log("No environment variables set.");
      return 0;
    }
    for (const key of keys) console.log(`${key}=${env[key]}`);
    return 0;
  } catch (err) {
    console.error(`Failed: ${formatError(err)}`);
    return 1;
  }
}

/** Parse `KEY=VALUE` tokens into a record. Throws on a malformed token. */
export function parseEnvPairs(pairs: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Error(`invalid env var "${pair}" (expected KEY=VALUE)`);
    env[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return env;
}
