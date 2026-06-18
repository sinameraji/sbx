import { runCommand } from "./run.js";
import { createCommand } from "./create.js";
import { listCommand } from "./list.js";
import { removeCommand } from "./remove.js";
import { filesCommand } from "./files.js";
import { startCommand, psCommand, killCommand } from "./proc.js";
import { stopCommand, startSandboxCommand } from "./lifecycle.js";
import { backupCommand, restoreCommand, backupsCommand } from "./backup.js";
import { runCodeCommand } from "./code.js";
import { watchCommand } from "./watch.js";
import { logsCommand } from "./logs.js";
import { waitPortCommand, exposeCommand } from "./ports.js";
import { execCommand } from "./exec.js";
import { envCommand } from "./env.js";
import { sessionCommand } from "./session.js";
import { statsCommand } from "./stats.js";
import { infoCommand } from "./info.js";
import { egressCommand } from "./egress.js";
import { terminalCommand } from "./terminal.js";

export interface GlobalArgs {
  endpoint?: string;
  /** API key for an auth-enabled daemon. Falls back to SBX_API_KEY. */
  apiKey?: string;
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
    apiKey: (flags["api-key"] as string | undefined) ?? process.env.SBX_API_KEY,
  };

  switch (command) {
    case "run":
      return runCommand(positional, globals, flags);
    case "create":
      return createCommand(positional, globals, flags);
    case "exec":
      return execCommand(positional, globals, flags);
    case "env":
      return envCommand(positional, globals);
    case "session":
      return sessionCommand(positional, globals, flags);
    case "ls":
    case "list":
      return listCommand(globals);
    case "stats":
      return statsCommand(positional, globals);
    case "info":
      return infoCommand(positional, globals);
    case "egress":
      return egressCommand(positional, globals, flags);
    case "terminal":
      return terminalCommand(positional, globals);
    case "rm":
    case "remove":
      return removeCommand(positional, globals);
    case "files":
      return filesCommand(positional, globals, flags);
    case "start":
      // Overload: `sb start <id> "<cmd>"` launches a process; `sb start <id>`
      // (no command) resumes a stopped sandbox.
      return positional.length >= 2
        ? startCommand(positional, globals, flags)
        : startSandboxCommand(positional, globals);
    case "stop":
      return stopCommand(positional, globals);
    case "backup":
      return backupCommand(positional, globals);
    case "restore":
      return restoreCommand(positional, globals);
    case "backups":
      return backupsCommand(positional, globals);
    case "run-code":
      return runCodeCommand(positional, globals, flags);
    case "watch":
      return watchCommand(positional, globals, flags);
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
  sb run "<command>" [--image <image>] [--keep] [--sleep-after <ms>] [--egress]
         [--repo <git-url>] [--ref <branch>] [--setup "cmd"]
         [--memory <MB>] [--cpus <n>] [--pids <n>] [--endpoint <url>]
    Create a sandbox, run a command, stream output, then destroy it.
    --egress wires the sandbox to the LLM gateway (provider keys injected by the daemon).
    --memory/--cpus/--pids set hard resource caps (override the daemon defaults).

  sb create [--image I] [--env K=V,…] [--sleep-after MS] [--egress] [--label K=V,…]
            [--repo <git-url>] [--ref <branch>] [--setup "cmd"]
            [--memory <MB>] [--cpus <n>] [--pids <n>]
    Provision a standalone persistent sandbox and print its id.
    --repo clones a git repo into /workspace at create (great for agents).
    --setup runs a shell command once after the container starts (best-effort;
    chain with && for multiple steps, e.g. --setup "npm i x && pip install y").

  sb terminal <id>
    Attach an interactive shell (PTY) to a sandbox in your local terminal.

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

  sb info
    Show the daemon's driver, providers, auth, and cost configuration.

  sb stats <id>
    Show live CPU/mem/net usage and accumulated cost for a sandbox.

  sb egress <id> [--list] [--revoke <token>]
    Mint an egress (LLM gateway) token so the sandbox reaches providers without
    baked-in keys; prints the provider base URLs + env exports to set.

  sb stop <id>
    Stop a sandbox, freeing compute but keeping its persistent workspace.

  sb start <id>
    Resume a stopped sandbox (workspace intact).

  sb backup <id>
    Snapshot a sandbox's /workspace to a durable backup.

  sb restore <id> <backupId>
    Replace a sandbox's /workspace with a backup (taken from any sandbox).

  sb backups [<id>]
    List all backups, or just those from one sandbox.

  sb run-code <id> "<code>" [--lang python|javascript]
    Run a code snippet in the sandbox's interpreter and print its output.

  sb rm <id> [--endpoint <url>]
    Destroy a sandbox, including its persistent workspace volume.

  sb files <subcommand> [args] [--endpoint <url>]
    Manage files inside a sandbox. Run \`sb files\` for subcommand help.

  sb watch <id> [path] [--interval <ms>]
    Stream file-change events (created/modified/deleted) until Ctrl-C.

  sb start <id> "<command>" [--cwd <dir>]
    Launch a long-running background process inside a sandbox.
    (With no command, "sb start <id>" resumes a stopped sandbox — see above.)

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
  --api-key <key>    API key for an auth-enabled daemon (or SBX_API_KEY)
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
