import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { HotcellClient } from "@hotcell/sdk";
import { storeKey, removeKey, loadKeys } from "./keystore.js";
import { multilineInput, select, textInput } from "./prompts.js";
import type { GlobalArgs } from "./cli.js";

/**
 * hotcell keys add|ls|rm|import — manage provider API keys the daemon uses to
 * swap token→real key at the egress gateway. Keys live on the daemon host
 * (keychain on macOS, else a chmod-600 ~/.hotcell/keys.json) and never enter a
 * sandbox. The provider name is free-form — built-in gateway routes exist for
 * openai/anthropic/openrouter/google/github; any other name routes once the
 * daemon has a shape for it (`HOTCELL_PROVIDER_<NAME>_BASEURL` etc.).
 *
 * Human: `hotcell keys add openrouter` prompts for the secret (hidden).
 * Agent: `hotcell keys add openrouter --value sk-…` or `… | hotcell keys add openrouter --stdin`.
 * Bulk:  `hotcell keys import .env` or `cat .env | hotcell keys import`.
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

/**
 * Tell a running daemon to hot-reload keys (no restart). Distinguishes "daemon
 * down" from "daemon rejected our API key" — conflating them told users to
 * start a daemon that was already running.
 */
async function reload(globals: GlobalArgs): Promise<"ok" | "auth" | "down"> {
  const client = new HotcellClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });
  try {
    await client.request("POST", "/reload-keys");
    return "ok";
  } catch (err) {
    return err instanceof Error && /-> 401/.test(err.message) ? "auth" : "down";
  }
}

/** `GH_TOKEN` and friends whose suffix-stripped form isn't the provider name. */
const PROVIDER_ALIASES: Record<string, string> = { gh: "github", google_generative_ai: "google" };

/** `OPENAI_API_KEY` → `openai`: strip the credential suffix, lowercase, alias. */
export function providerFromEnvName(envName: string): string {
  const stripped = envName
    .trim()
    .toLowerCase()
    .replace(/_(api_key|api_token|access_token|secret_key|api_secret|key|token|secret)$/, "");
  return PROVIDER_ALIASES[stripped] ?? stripped;
}

export interface ParsedEnvKey {
  envName: string;
  provider: string;
  value: string;
}

/** Parse .env text: KEY=VALUE lines; `export` prefixes, quotes, comments, and
 * blank lines tolerated; anything else is skipped. */
export function parseDotenv(text: string): ParsedEnvKey[] {
  const out: ParsedEnvKey[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!value) continue;
    out.push({ envName: m[1], provider: providerFromEnvName(m[1]), value });
  }
  return out;
}

/** Store every key found in .env text, then hot-reload the daemon once. */
export async function importEnvText(text: string, globals: GlobalArgs): Promise<number> {
  const parsed = parseDotenv(text);
  if (!parsed.length) {
    console.error("no KEY=VALUE lines found — nothing imported");
    return 1;
  }
  const w = Math.max(...parsed.map((p) => p.envName.length));
  for (const { envName, provider, value } of parsed) {
    const source = storeKey(provider, value.trim());
    console.log(`${green("✓")} ${envName.padEnd(w)} ${dim("→")} ${green(provider)}   ${dim(`· ${source}`)}`);
  }
  const applied = await reload(globals);
  console.log(
    applied === "ok"
      ? dim("  applied live")
      : applied === "auth"
        ? dim("  (daemon rejected the API key — pass --api-key, or restart your shell to pick up the new one)")
        : dim("  (start the daemon to use them: hotcell start)"),
  );
  return 0;
}

/**
 * TTY flow shared by the menu and setup wizard: paste .env lines, or read a
 * file. The mode is picked with the raw-mode `select` (not a text prompt) so
 * exactly one readline interface is ever created — two in sequence lose input
 * buffered by the first.
 */
export async function importEnvInteractive(globals: GlobalArgs): Promise<void> {
  const how = await select("import keys from", [
    { label: "paste .env lines here", hint: "ends at an empty line" },
    { label: "a .env file on disk", hint: "give its path" },
    { label: "cancel" },
  ]);
  let text = "";
  if (how === 0) {
    text = await multilineInput("paste .env lines");
  } else if (how === 1) {
    const path = await textInput("path to the .env");
    if (!path) return;
    try {
      text = readFileSync(path.replace(/^~(?=\/)/, homedir()), "utf8");
    } catch {
      console.error(red(`cannot read ${path}`));
      return;
    }
  } else return; // cancel, or Esc (-1)
  if (text.trim()) await importEnvText(text, globals);
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
      console.error('Usage: hotcell keys add <provider> [--value <key>]   — any name (openrouter, stripe, cloudflare, …)');
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
    console.log(
      applied === "ok"
        ? dim("  applied live")
        : applied === "auth"
          ? dim("  (daemon rejected the API key — pass --api-key, or restart your shell to pick up the new one)")
          : dim("  (start the daemon to use it: hotcell start)"),
    );
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

  if (sub === "import") {
    const path = positional[1];
    let text = "";
    if (path) {
      try {
        text = readFileSync(path, "utf8");
      } catch {
        console.error(`cannot read ${path}`);
        return 1;
      }
    } else if (!process.stdin.isTTY) {
      text = await readStdin();
    } else {
      console.error("Usage: hotcell keys import <.env path>   (or pipe: cat .env | hotcell keys import)");
      return 1;
    }
    return importEnvText(text, globals);
  }

  if (sub === "rm" || sub === "remove") {
    const provider = positional[1];
    if (!provider) { console.error("Usage: hotcell keys rm <provider>"); return 1; }
    const removed = removeKey(provider);
    if (removed) await reload(globals);
    console.log(removed ? `${green("✓")} removed ${green(provider)}` : dim(`${red("○")} no key named '${provider}'`));
    return 0;
  }

  console.error("Usage: hotcell keys <add|ls|rm|import> …");
  return 1;
}
