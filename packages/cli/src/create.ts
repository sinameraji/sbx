import { SbxClient } from "@sbx/sdk";
import type { GlobalArgs } from "./cli.js";
import { parseEnvPairs } from "./env.js";
import { parseLimitFlags } from "./util.js";

/**
 * sb create [--image I] [--env K=V,…] [--sleep-after MS] [--egress] [--label K=V,…]
 *           [--setup "cmd"]
 *
 * Provision a standalone, persistent sandbox and print its id (unlike `sb run`,
 * which runs a command and destroys the sandbox). With `--egress`, also prints the
 * provider env exports the gateway wired in.
 */
export async function createCommand(
  positional: string[],
  globals: GlobalArgs,
  flags: Record<string, string | boolean>,
): Promise<number> {
  const client = new SbxClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });

  const image = typeof flags.image === "string" ? flags.image : undefined;
  const egress = flags.egress === true;
  const sleepAfter =
    typeof flags["sleep-after"] === "string" ? Number(flags["sleep-after"]) : undefined;
  const { memoryMb, cpus, pidsLimit } = parseLimitFlags(flags);
  const setup = typeof flags.setup === "string" ? [flags.setup] : undefined;

  let env: Record<string, string> | undefined;
  let labels: Record<string, string> | undefined;
  try {
    if (typeof flags.env === "string") env = parseEnvPairs(flags.env.split(","));
    if (typeof flags.label === "string") labels = parseEnvPairs(flags.label.split(","));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  try {
    const sandbox = await client.getSandbox(undefined, {
      image,
      env,
      labels,
      sleepAfter,
      egress,
      setup,
      memoryMb,
      cpus,
      pidsLimit,
    });
    console.log(sandbox.id);
    if (egress) {
      const { providers } = await sandbox.listEgressTokens();
      for (const p of providers) {
        if (p.baseUrlEnv) console.error(`  ${p.baseUrlEnv}=${p.baseUrl}`);
      }
    }
    return 0;
  } catch (err) {
    console.error(`Failed to create sandbox: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
