import { HotcellClient } from "@hotcell/sdk";
import { formatError } from "./util.js";
import type { GlobalArgs } from "./cli.js";
import { parseEnvPairs } from "./env.js";

/**
 * sb session <create|ls|rm> <id> [...]
 *   create <id> [--cwd <dir>] [--env KEY=VAL,...] [--id <sid>]
 *   ls     <id>
 *   rm     <id> <sessionId>
 */
export async function sessionCommand(
  positional: string[],
  globals: GlobalArgs,
  flags: Record<string, string | boolean>,
): Promise<number> {
  const [sub, id, arg] = positional;
  const client = new HotcellClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });
  try {
    switch (sub) {
      case "create": {
        if (!id) return usage();
        let env: Record<string, string> | undefined;
        if (typeof flags.env === "string") env = parseEnvPairs(flags.env.split(","));
        const sandbox = await client.getSandbox(id);
        const session = await sandbox.createSession({
          id: typeof flags.id === "string" ? flags.id : undefined,
          cwd: typeof flags.cwd === "string" ? flags.cwd : undefined,
          env,
        });
        console.log(session.sessionId);
        return 0;
      }
      case "ls": {
        if (!id) return usage();
        const sandbox = await client.getSandbox(id);
        const sessions = await sandbox.listSessions();
        if (sessions.length === 0) {
          console.log("No sessions.");
          return 0;
        }
        console.log(`${padRight("SESSIONID", 12)} CWD`);
        for (const s of sessions) console.log(`${padRight(s.sessionId, 12)} ${s.cwd}`);
        return 0;
      }
      case "rm": {
        if (!id || !arg) return usage();
        await client.request("DELETE", `/sandboxes/${id}/sessions/${arg}`);
        console.log(`Removed session ${arg}.`);
        return 0;
      }
      default:
        return usage();
    }
  } catch (err) {
    console.error(`Failed: ${formatError(err)}`);
    return 1;
  }
}

function usage(): number {
  console.error(
    "Usage:\n" +
      "  sb session create <id> [--cwd <dir>] [--env KEY=VAL,...] [--id <sid>]\n" +
      "  sb session ls <id>\n" +
      "  sb session rm <id> <sessionId>",
  );
  return 1;
}

function padRight(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}
