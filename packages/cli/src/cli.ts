import { runCommand } from "./run.js";
import { createCommand } from "./create.js";
import { listCommand } from "./list.js";
import { removeCommand } from "./remove.js";
import { filesCommand } from "./files.js";
import { startCommand, psCommand, killCommand } from "./proc.js";
import { pauseCommand, stopCommand, startSandboxCommand } from "./lifecycle.js";
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
import { capacityCommand } from "./capacity.js";
import { egressCommand } from "./egress.js";
import { terminalCommand } from "./terminal.js";
import { tuiCommand } from "./tui.js";
import { startEngine, stopEngine, engineStatus } from "./engine.js";
import { keysCommand } from "./keys.js";

export interface GlobalArgs {
  endpoint?: string;
  /** API key for an auth-enabled daemon. Falls back to SBX_API_KEY. */
  apiKey?: string;
}

export async function cli(args: string[]): Promise<number> {
  if (args[0] === "--help" || args[0] === "-h") {
    printHelp();
    return 0;
  }

  // Bare `hotcell` (no command) opens the interactive UI when attached to a
  // terminal; falls back to help for pipes/scripts so automation isn't surprised.
  if (args.length === 0) {
    const globals: GlobalArgs = {
      apiKey: process.env.HOTCELL_API_KEY ?? process.env.SBX_API_KEY,
    };
    if (process.stdout.isTTY && process.stdin.isTTY) return tuiCommand([], globals);
    printHelp();
    return 0;
  }

  const [command, ...rest] = args;
  const { flags, positional } = parseFlags(rest);
  const globals: GlobalArgs = {
    endpoint: flags.endpoint as string | undefined,
    apiKey: (flags["api-key"] as string | undefined) ?? (process.env.HOTCELL_API_KEY ?? process.env.SBX_API_KEY),
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
    case "capacity":
      return capacityCommand(positional, globals);
    case "egress":
      return egressCommand(positional, globals, flags);
    case "terminal":
      return terminalCommand(positional, globals);
    case "tui":
    case "top":
      return tuiCommand(positional, globals);
    case "rm":
    case "remove":
      return removeCommand(positional, globals);
    case "files":
      return filesCommand(positional, globals, flags);
    case "start":
      // Arity overload: no args starts the background engine (daemon); `hotcell
      // start <id>` resumes a stopped sandbox; `hotcell start <id> "<cmd>"` launches
      // a process inside it.
      if (positional.length === 0) return startEngine(globals, flags);
      return positional.length >= 2
        ? startCommand(positional, globals, flags)
        : startSandboxCommand(positional, globals);
    case "resume":
      // Clear name for resuming a paused/stopped sandbox (pairs with `pause`).
      return startSandboxCommand(positional, globals);
    case "status":
      return engineStatus(globals);
    case "keys":
      return keysCommand(positional, globals, flags);
    case "stop":
      // No args stops the engine; `hotcell stop <id>` stops a sandbox.
      return positional.length === 0 ? stopEngine(globals) : stopCommand(positional, globals);
    case "pause":
      return pauseCommand(positional, globals);
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
  console.log(`hotcell — sandboxes for AI agents, on your own hardware

Usage: hotcell <command> [options]

Engine (the background daemon that runs your sandboxes):
  hotcell start [--foreground]   Start it in the background; returns your terminal.
  hotcell status                 Is it running? On what port? How much headroom?
  hotcell stop                   Stop it. (Logs: ~/.hotcell/daemon.log)

Commands:
  hotcell run "<command>" [--image <image>] [--keep] [--sleep-after <ms>] [--egress]
         [--repo <git-url>] [--ref <branch>] [--setup "cmd"]
         [--memory <MB>] [--cpus <n>] [--pids <n>] [--endpoint <url>]
    Create a sandbox, run a command, stream output, then destroy it.
    --egress wires the sandbox to the LLM gateway (provider keys injected by the daemon).
    --memory/--cpus/--pids set hard resource caps (override the daemon defaults).

  hotcell create [--image I] [--driver container|firecracker|applevz] [--env K=V,…]
            [--sleep-after MS] [--egress] [--label K=V,…]
            [--repo <git-url>] [--ref <branch>] [--setup "cmd"]
            [--memory <MB>] [--cpus <n>] [--pids <n>]
    Provision a standalone persistent sandbox and print its id.
    --driver picks the isolation tier per sandbox (microVMs need a VZ/KVM host).
    --repo clones a git repo into /workspace at create (great for agents).
    --setup runs a shell command once after the container starts (best-effort;
    chain with && for multiple steps, e.g. --setup "npm i x && pip install y").

  hotcell keys add <provider> [--value <key>]   ·   hotcell keys ls   ·   hotcell keys rm <provider>
    Manage the provider API keys the daemon uses (openrouter, openai, anthropic,
    google). Stored on the host (macOS keychain, else chmod-600 ~/.hotcell/keys.json)
    — never inside a sandbox. Human: prompts for the secret (hidden). Agent: --value/--stdin.

  hotcell tui   (alias: hotcell top)
    Full-screen fleet monitor + control panel. Arrow-key nav, live CPU/mem/cost,
    ⏎ to attach a shell, p/r/d to pause/resume/destroy, c to create.

  hotcell terminal <id>
    Attach an interactive shell (PTY) to a sandbox in your local terminal.

  hotcell exec <id> "<command>" [--session <sid>] [--cwd <dir>] [--env KEY=VAL,...]
    Run a command in an existing sandbox (optionally within a session).

  hotcell env <id> [KEY=VALUE ...]
    Set sandbox environment variables, or print them when none are given.

  hotcell session create <id> [--cwd <dir>] [--env KEY=VAL,...] [--id <sid>]
  hotcell session ls <id>
  hotcell session rm <id> <sessionId>
    Manage persistent sessions (working directory + env) inside a sandbox.

  hotcell ls [--endpoint <url>]
    List sandboxes managed by the daemon.

  hotcell info
    Show the daemon's driver, providers, auth, and cost configuration.

  hotcell capacity
    Show host memory budget, what's committed, and how many more sandboxes fit.

  hotcell stats <id>
    Show live CPU/mem/net usage and accumulated cost for a sandbox.

  hotcell egress <id> [--list] [--revoke <token>]
    Mint an egress (LLM gateway) token so the sandbox reaches providers without
    baked-in keys; prints the provider base URLs + env exports to set.

  hotcell stop <id>
    Stop a sandbox, freeing compute but keeping its persistent workspace.

  hotcell pause <id>
    Fast-pause a sandbox; any later operation resumes it. On microVM sandboxes
    this is a memory snapshot — background processes come back alive.

  hotcell start <id>
    Resume a stopped sandbox (workspace intact).

  hotcell backup <id>
    Snapshot a sandbox's /workspace to a durable backup.

  hotcell restore <id> <backupId>
    Replace a sandbox's /workspace with a backup (taken from any sandbox).

  hotcell backups [<id>]
    List all backups, or just those from one sandbox.

  hotcell run-code <id> "<code>" [--lang python|javascript]
    Run a code snippet in the sandbox's interpreter and print its output.

  hotcell rm <id> [--endpoint <url>]
    Destroy a sandbox, including its persistent workspace volume.

  hotcell files <subcommand> [args] [--endpoint <url>]
    Manage files inside a sandbox. Run \`sb files\` for subcommand help.

  hotcell watch <id> [path] [--interval <ms>]
    Stream file-change events (created/modified/deleted) until Ctrl-C.

  hotcell start <id> "<command>" [--cwd <dir>]
    Launch a long-running background process inside a sandbox.
    (With no command, "hotcell start <id>" resumes a stopped sandbox — see above.)

  hotcell ps <id>
    List background processes in a sandbox.

  hotcell kill <id> <procId> [--signal <SIG>]
    Signal a background process (default SIGTERM).

  hotcell logs <id> <procId> [--follow]
    Stream a background process's logs.

  hotcell wait-port <id> <port> [--timeout <ms>]
    Block until a TCP port is listening inside the sandbox.

  hotcell expose <id> <port> [--token <token>]
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
