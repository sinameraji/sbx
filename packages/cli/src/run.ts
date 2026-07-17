import { HotcellClient } from "@hotcell/sdk";
import { formatError, parseLimitFlags } from "./util.js";
import type { GlobalArgs } from "./cli.js";
import { parseEnvPairs } from "./env.js";

export async function runCommand(
  positional: string[],
  globals: GlobalArgs,
  flags: Record<string, string | boolean>,
): Promise<number> {
  const command = positional[0];
  if (!command) {
    console.error(
      'Usage: sb run "<command>" [--image <image>] [--keep] [--env KEY=VAL,...] [--sleep-after <ms>]',
    );
    return 1;
  }

  const client = new HotcellClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });
  const image = typeof flags.image === "string" ? flags.image : undefined;
  const keep = flags.keep === true;
  const egress = flags.egress === true;
  const egressSpendCapUsd =
    typeof flags["egress-spend-cap"] === "string" ? Number(flags["egress-spend-cap"]) : undefined;
  const sleepAfter =
    typeof flags["sleep-after"] === "string"
      ? Number(flags["sleep-after"])
      : undefined;
  const { memoryMb, cpus, pidsLimit } = parseLimitFlags(flags);
  const setup = typeof flags.setup === "string" ? [flags.setup] : undefined;
  const repo = typeof flags.repo === "string" ? flags.repo : undefined;
  const repoRef = typeof flags.ref === "string" ? flags.ref : undefined;
  let env: Record<string, string> | undefined;
  if (typeof flags.env === "string") {
    try {
      env = parseEnvPairs(flags.env.split(","));
    } catch (err) {
      console.error(formatError(err));
      return 1;
    }
  }

  let sandbox;
  try {
    const hasLimits = memoryMb !== undefined || cpus !== undefined || pidsLimit !== undefined;
    const opts =
      image || env || sleepAfter !== undefined || egress || hasLimits || setup || repo ||
      egressSpendCapUsd !== undefined
        ? { image, env, sleepAfter, egress, egressSpendCapUsd, setup, repo, repoRef, memoryMb, cpus, pidsLimit }
        : undefined;
    sandbox = await client.getSandbox(undefined, opts);
  } catch (err) {
    console.error(`Failed to create sandbox: ${formatError(err)}`);
    return 1;
  }

  let exitCode = 0;
  try {
    console.error(`[sb] sandbox ${sandbox.id} created`);
    for await (const event of sandbox.execStream(command)) {
      if (event.type === "stdout") {
        process.stdout.write(event.data);
      } else if (event.type === "stderr") {
        process.stderr.write(event.data);
      } else if (event.type === "exit") {
        exitCode = event.exitCode;
      }
    }
  } catch (err) {
    console.error(`\n[sb] exec failed: ${formatError(err)}`);
    exitCode = 1;
  } finally {
    if (!keep) {
      try {
        await sandbox.destroy();
        console.error(`[sb] sandbox ${sandbox.id} destroyed`);
      } catch (err) {
        console.error(`[sb] failed to destroy sandbox: ${formatError(err)}`);
      }
    } else {
      console.error(`[sb] sandbox ${sandbox.id} kept alive`);
    }
  }

  return exitCode;
}
