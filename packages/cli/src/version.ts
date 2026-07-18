import { readFileSync } from "node:fs";
import { HotcellClient } from "@hotcell/sdk";
import type { GlobalArgs } from "./cli.js";

const dim = (s: string) => (process.stdout.isTTY ? `\x1b[38;5;244m${s}\x1b[0m` : s);

/**
 * hotcell --version — prints the CLI version AND the running daemon's version.
 *
 * The daemon (not the CLI) picks the default image and does the real work, and an
 * `npm i -g` upgrade can leave a stale bundled daemon behind — so surfacing both,
 * and flagging a mismatch, makes that drift obvious instead of silent.
 */
export async function versionCommand(globals: GlobalArgs): Promise<number> {
  let cliVer = "unknown";
  try {
    cliVer = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "unknown";
  } catch {
    // ignore — fall back to "unknown"
  }
  console.log(`hotcell ${cliVer}  ${dim("(CLI)")}`);
  try {
    const client = new HotcellClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });
    const h = await client.health();
    if (!h.version) {
      console.log(`daemon  running · version unknown ${dim("(older than 0.1.7 — reinstall to refresh)")}`);
    } else if (h.version !== cliVer) {
      console.log(`daemon  ${h.version}  ⚠ differs from the CLI`);
      console.log(dim(`        fix: npm uninstall -g hotcell && npm install -g hotcell, then hotcell stop && hotcell start`));
    } else {
      console.log(`daemon  ${h.version}  ${dim("(running)")}`);
    }
  } catch {
    console.log(`daemon  ${dim("not running — start it with: hotcell start")}`);
  }
  return 0;
}
