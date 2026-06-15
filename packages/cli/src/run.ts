import { SbxClient } from "@sbx/sdk";
import type { GlobalArgs } from "./cli.js";
import { parseEnvPairs } from "./env.js";

export async function runCommand(
  positional: string[],
  globals: GlobalArgs,
  flags: Record<string, string | boolean>,
): Promise<number> {
  const command = positional[0];
  if (!command) {
    console.error('Usage: sb run "<command>" [--image <image>] [--keep] [--env KEY=VAL,...]');
    return 1;
  }

  const client = new SbxClient({ endpoint: globals.endpoint });
  const image = typeof flags.image === "string" ? flags.image : undefined;
  const keep = flags.keep === true;
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
    sandbox = await client.getSandbox(
      undefined,
      image || env ? { image, env } : undefined,
    );
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

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
