import { runCommand } from "./run.js";
import { listCommand } from "./list.js";
import { removeCommand } from "./remove.js";

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
    case "ls":
    case "list":
      return listCommand(globals);
    case "rm":
    case "remove":
      return removeCommand(positional, globals);
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

  sb ls [--endpoint <url>]
    List sandboxes managed by the daemon.

  sb rm <id> [--endpoint <url>]
    Destroy a sandbox.

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
