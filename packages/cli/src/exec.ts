import { SbxClient } from "@sbx/sdk";
import { formatError } from "./util.js";
import type { GlobalArgs } from "./cli.js";
import { parseEnvPairs } from "./env.js";

/** sb exec <id> "<command>" [--session <sid>] [--cwd <dir>] [--env KEY=VAL,...] */
export async function execCommand(
  positional: string[],
  globals: GlobalArgs,
  flags: Record<string, string | boolean>,
): Promise<number> {
  const [id, command] = positional;
  if (!id || !command) {
    console.error(
      'Usage: sb exec <id> "<command>" [--session <sid>] [--cwd <dir>] [--env KEY=VAL,...]',
    );
    return 1;
  }
  const client = new SbxClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });
  let env: Record<string, string> | undefined;
  if (typeof flags.env === "string") {
    try {
      env = parseEnvPairs(flags.env.split(","));
    } catch (err) {
      console.error(formatError(err));
      return 1;
    }
  }

  let exitCode = 0;
  try {
    const sandbox = await client.getSandbox(id);
    for await (const event of sandbox.execStream(command, {
      sessionId: typeof flags.session === "string" ? flags.session : undefined,
      cwd: typeof flags.cwd === "string" ? flags.cwd : undefined,
      env,
    })) {
      if (event.type === "stdout") process.stdout.write(event.data);
      else if (event.type === "stderr") process.stderr.write(event.data);
      else if (event.type === "exit") exitCode = event.exitCode;
    }
  } catch (err) {
    console.error(`\n[sb] exec failed: ${formatError(err)}`);
    return 1;
  }
  return exitCode;
}
