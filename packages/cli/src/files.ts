import { HotcellClient } from "@hotcell/sdk";
import { formatError } from "./util.js";
import type { GlobalArgs } from "./cli.js";

export async function filesCommand(
  positional: string[],
  globals: GlobalArgs,
  flags: Record<string, string | boolean>,
): Promise<number> {
  const [subcommand, id, path] = positional;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printHelp();
    return 0;
  }

  const client = new HotcellClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });

  try {
    const sandbox = await client.getSandbox(id);

    switch (subcommand) {
      case "write": {
        if (!path) {
          console.error("Usage: hotcell files write <id> <path> --content <string> [--mode <mode>]");
          return 1;
        }
        const content = typeof flags.content === "string" ? flags.content : "";
        await sandbox.writeFile(path, content, {
          mode: typeof flags.mode === "string" ? flags.mode : undefined,
        });
        console.log(`Wrote ${path}.`);
        return 0;
      }
      case "read": {
        if (!path) {
          console.error("Usage: hotcell files read <id> <path>");
          return 1;
        }
        const content = await sandbox.readFile(path);
        process.stdout.write(content);
        return 0;
      }
      case "mkdir": {
        if (!path) {
          console.error("Usage: hotcell files mkdir <id> <path> [--parents]");
          return 1;
        }
        await sandbox.mkdir(path, { parents: flags.parents === true });
        console.log(`Created directory ${path}.`);
        return 0;
      }
      case "ls":
      case "list": {
        const target = path || "/workspace";
        const entries = await sandbox.listFiles(target);
        if (entries.length === 0) {
          console.log("No files.");
          return 0;
        }
        for (const entry of entries) {
          const type = entry.isDirectory ? "d" : "-";
          console.log(`${type} ${entry.size.toString().padStart(10)} ${entry.modifiedAt} ${entry.name}`);
        }
        return 0;
      }
      default:
        console.error(`Unknown files subcommand: ${subcommand}`);
        printHelp();
        return 1;
    }
  } catch (err) {
    console.error(`Failed: ${formatError(err)}`);
    return 1;
  }
}

function printHelp(): void {
  console.log(`sb files — manage files inside a sandbox

Usage: hotcell files <subcommand> [args]

Subcommands:
  hotcell files write <id> <path> --content <string> [--mode <mode>]
    Write a file inside the sandbox.

  hotcell files read <id> <path>
    Read a file from the sandbox.

  hotcell files mkdir <id> <path> [--parents]
    Create a directory inside the sandbox.

  hotcell files ls <id> [path]
    List files and directories (defaults to /workspace).`);
}
