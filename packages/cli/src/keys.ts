import { HotcellClient } from "@hotcell/sdk";
import { storeKey, removeKey, loadKeys } from "./keystore.js";
import type { GlobalArgs } from "./cli.js";

/**
 * hotcell keys add|ls|rm — manage provider API keys the daemon uses to swap
 * token→real key at the egress gateway. Keys live on the daemon host (keychain
 * on macOS, else a chmod-600 ~/.hotcell/keys.json) and never enter a sandbox.
 *
 * Human: `hotcell keys add openrouter` prompts for the secret (hidden).
 * Agent: `hotcell keys add openrouter --value sk-…` or `… | hotcell keys add openrouter --stdin`.
 */

const tty = () => process.stdout.isTTY && !process.env.NO_COLOR;
const green = (s: string) => (tty() ? `\x1b[38;5;114m${s}\x1b[0m` : s);
const dim = (s: string) => (tty() ? `\x1b[38;5;244m${s}\x1b[0m` : s);
const red = (s: string) => (tty() ? `\x1b[38;5;203m${s}\x1b[0m` : s);

const mask = (v: string) => (v.length <= 8 ? "•".repeat(Math.max(4, v.length)) : `${v.slice(0, 5)}…${v.slice(-2)}`);

function promptHidden(label: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(label);
    const wasRaw = stdin.isRaw;
    try { stdin.setRawMode?.(true); } catch { /* not a tty */ }
    stdin.resume();
    let buf = "";
    const onData = (d: Buffer) => {
      for (const ch of d.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          try { stdin.setRawMode?.(wasRaw ?? false); } catch { /* ignore */ }
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          return resolve(buf);
        } else if (ch === "\x03") { process.stdout.write("\n"); process.exit(130); }
        else if (ch === "\x7f" || ch === "\b") buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let d = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (d += c)).on("end", () => resolve(d.trim()));
  });
}

/** Tell a running daemon to hot-reload keys (no restart). Silent if it's down. */
async function reload(globals: GlobalArgs): Promise<boolean> {
  const client = new HotcellClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });
  try {
    await client.request("POST", "/reload-keys");
    return true;
  } catch {
    return false;
  }
}

export async function keysCommand(
  positional: string[],
  globals: GlobalArgs,
  flags: Record<string, string | boolean>,
): Promise<number> {
  const sub = positional[0];

  if (sub === "add") {
    const provider = positional[1];
    if (!provider) {
      console.error('Usage: hotcell keys add <provider> [--value <key>]   (providers: openrouter, openai, anthropic, google)');
      return 1;
    }
    let value =
      typeof flags.value === "string" ? flags.value
      : flags.stdin ? await readStdin()
      : "";
    if (!value) {
      if (!process.stdin.isTTY) {
        console.error("no key given — pass --value <key>, pipe with --stdin, or run in a terminal");
        return 1;
      }
      value = await promptHidden(dim(`paste ${provider} key (hidden): `));
    }
    if (!value) { console.error("empty key — nothing stored"); return 1; }
    const source = storeKey(provider, value.trim());
    const applied = await reload(globals);
    console.log(`${green("✓")} stored ${green(provider)}   ${dim(`· ${source === "keychain" ? "macOS keychain" : "~/.hotcell/keys.json (chmod 600)"}`)}`);
    console.log(applied ? dim("  applied live — the gateway can use it now") : dim("  (start the daemon to use it: hotcell start)"));
    return 0;
  }

  if (sub === "ls" || sub === "list") {
    const keys = loadKeys();
    const names = Object.keys(keys).sort();
    if (!names.length) {
      console.log(dim("no provider keys yet — add one:  hotcell keys add openrouter"));
      return 0;
    }
    const w = Math.max(8, ...names.map((n) => n.length));
    console.log(`${dim("PROVIDER".padEnd(w))}  ${dim("KEY".padEnd(12))}  ${dim("SOURCE")}`);
    for (const n of names) {
      const { value, source } = keys[n];
      console.log(`${n.padEnd(w)}  ${mask(value).padEnd(12)}  ${dim(source)}`);
    }
    return 0;
  }

  if (sub === "rm" || sub === "remove") {
    const provider = positional[1];
    if (!provider) { console.error("Usage: hotcell keys rm <provider>"); return 1; }
    const removed = removeKey(provider);
    if (removed) await reload(globals);
    console.log(removed ? `${green("✓")} removed ${green(provider)}` : dim(`${red("○")} no key named '${provider}'`));
    return 0;
  }

  console.error("Usage: hotcell keys <add|ls|rm> …");
  return 1;
}
