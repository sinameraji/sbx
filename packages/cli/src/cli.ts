import { runCommand } from "./run.js";
import { listCommand } from "./list.js";
import { removeCommand } from "./remove.js";
import { filesCommand } from "./files.js";
import { startCommand, psCommand, killCommand } from "./proc.js";
import { logsCommand } from "./logs.js";
import { waitPortCommand, exposeCommand } from "./ports.js";
import { execCommand } from "./exec.js";
import { envCommand } from "./env.js";
import { sessionCommand } from "./session.js";

export interface GlobalArgs {
  endpoint?: string;
}

export async function cli(args: string[]): Promise<number> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printHelp();
    return 0;
  }

  const [command, ...rest] = args;
  const { flags, positional } = parseFlags(rest);
  const globals: GlobalArgs = {
    endpoint: flags.endpoint as string | undefined,
  };

  switch (command) {
    case "run":
      return runCommand(positional, globals, flags);
    case "exec":
      return execCommand(positional, globals, flags);
    case "env":
      return envCommand(positional, globals);
    case "session":
      return sessionCommand(positional, globals, flags);
    case "ls":
    case "list":
      return listCommand(globals);
    case "rm":
    case "remove":
      return removeCommand(positional, globals);
    case "files":
      return filesCommand(positional, globals, flags);
    case "start":
      return startCommand(positional, globals, flags);
    case "ps":
      return psCommand(positional, globals);
    case "kill":
      return killCommand(positional, globals, flags);
    case "logs":
      return logsCommand(positional, globals, flags);
    case "wait-port":
      return waitPortCommand(positional, globals, flags);
    case "expose":
      return exposeCommand(positional, globals, flags);
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      return 1;
  }
}

function printHelp(): void {
  console.log(`sb — CLI for sbx self-hosted sandboxes

Usage: sb <command> [options]

Commands:
  sb run "<command>" [--image <image>] [--keep] [--endpoint <url>]
    Create a sandbox, run a command, stream output, then destroy it.

  sb exec <id> "<command>" [--session <sid>] [--cwd <dir>] [--env KEY=VAL,...]
    Run a command in an existing sandbox (optionally within a session).

  sb env <id> [KEY=VALUE ...]
    Set sandbox environment variables, or print them when none are given.

  sb session create <id> [--cwd <dir>] [--env KEY=VAL,...] [--id <sid>]
  sb session ls <id>
  sb session rm <id> <sessionId>
    Manage persistent sessions (working directory + env) inside a sandbox.

  sb ls [--endpoint <url>]
    List sandboxes managed by the daemon.

  sb rm <id> [--endpoint <url>]
    Destroy a sandbox.

  sb files <subcommand> [args] [--endpoint <url>]
    Manage files inside a sandbox. Run \`sb files\` for subcommand help.

  sb start <id> "<command>" [--cwd <dir>]
    Launch a long-running background process inside a sandbox.

  sb ps <id>
    List background processes in a sandbox.

  sb kill <id> <procId> [--signal <SIG>]
    Signal a background process (default SIGTERM).

  sb logs <id> <procId> [--follow]
    Stream a background process's logs.

  sb wait-port <id> <port> [--timeout <ms>]
    Block until a TCP port is listening inside the sandbox.

  sb expose <id> <port> [--token <token>]
    Expose a port and print its preview URL.

Global options:
  --endpoint <url>   Daemon URL (default: http://127.0.0.1:4750 or SBX_ENDPOINT)
  -h, --help         Show this help`);
}

export interface ParsedArgs {
  flags: Record<string, string | boolean>;
  positional: string[];
}

export function parseFlags(args: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const value = eq === -1 ? args[i + 1] : arg.slice(eq + 1);
      if (eq === -1 && value !== undefined && !value.startsWith("-")) {
        flags[key] = value;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (arg.startsWith("-")) {
      const key = arg.slice(1);
      const value = args[i + 1];
      if (value !== undefined && !value.startsWith("-")) {
        flags[key] = value;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { flags, positional };
}
