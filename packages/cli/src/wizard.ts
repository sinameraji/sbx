import type { GlobalArgs } from "./cli.js";
import { resolveSetting } from "./configfile.js";
import { createCommand } from "./create.js";
import { loadKeys } from "./keystore.js";
import { c, confirm, select, textInput } from "./prompts.js";

/**
 * Guided sandbox create (`hotcell create -i`, or Create in the home menu).
 *
 * Every answer maps to an existing flag, and the assembled command is printed
 * before running — the wizard teaches the scriptable path, never replaces it.
 * The create-time irreversible facts (image, repo, branch) come first.
 */

// Verified OpenCode wiring (same as examples/agents.sh): install, then point its
// openrouter provider at the egress gateway env the daemon injects.
const OPENCODE_SETUP =
  `npm i -g opencode-ai >/dev/null 2>&1 && mkdir -p ~/.config/opencode && ` +
  `printf '{"provider":{"openrouter":{"options":{"baseURL":"%s/v1","apiKey":"%s"}}}}' ` +
  `"$OPENROUTER_BASE_URL" "$OPENROUTER_API_KEY" > ~/.config/opencode/opencode.json`;

export async function createWizard(globals: GlobalArgs): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("guided create needs a terminal — use flags instead: hotcell create --help");
    return 1;
  }
  const out = process.stdout;
  out.write(`\n  ${c.bold}${c.cyan}create a sandbox${c.reset}\n\n`);

  const flags: Record<string, string | boolean> = {};
  const parts: string[] = ["hotcell create"];

  // image (irreversible per sandbox). Option 0 = "no --image flag" = whatever
  // the daemon's default resolves to — say so honestly when it's been changed.
  const configuredDefault = resolveSetting("IMAGE");
  const img = await select("base image", [
    {
      label: configuredDefault ? `daemon default (${configuredDefault})` : "hotcell-base",
      hint: configuredDefault ? "as configured in setup" : "git + node + python — the default",
    },
    { label: "python:3.11-slim", hint: "minimal (no git/node)" },
    { label: "node:20", hint: "node + git (no python)" },
    { label: "custom…" },
  ]);
  if (img < 0) {
    out.write(`  ${c.dim}cancelled${c.reset}\n`);
    return 0;
  }
  const IMAGES = [undefined, "python:3.11-slim", "node:20"] as const;
  let image = img < 3 ? IMAGES[img] : await textInput("image", "");
  if (image) {
    flags.image = image;
    parts.push(`--image ${image}`);
  }

  // repo + branch
  const repo = await textInput("clone a repo (git url)");
  if (repo) {
    flags.repo = repo;
    parts.push(`--repo ${repo}`);
    if (await confirm("create a new branch after cloning?", true)) {
      const name = await textInput("branch name", "auto");
      flags.branch = name === "auto" ? true : name;
      parts.push(name === "auto" ? "--branch" : `--branch ${name}`);
    }
  }

  // how many parallel cells — "0" (or junk) means "actually, no": cancel, don't
  // silently coerce to 1 and create something they didn't ask for.
  const countRaw = await textInput("how many sandboxes?", "1");
  const count = Math.floor(Number(countRaw));
  if (!Number.isFinite(count) || count < 1) {
    out.write(`  ${c.dim}cancelled (count "${countRaw}")${c.reset}\n`);
    return 0;
  }
  if (count > 1) {
    flags.n = String(count);
    parts.push(`-n ${count}`);
  }

  // egress + opencode
  const keys = loadKeys();
  const hasLlmKey = ["openrouter", "openai", "anthropic", "google"].some((p) => keys[p]);
  if (!hasLlmKey) {
    out.write(`  ${c.dim}no LLM provider key on the host yet (hotcell keys add openrouter) — egress would inject nothing${c.reset}\n`);
  }
  if (await confirm("wire keyless egress (LLM/GitHub through the gateway)?", hasLlmKey)) {
    flags.egress = true;
    parts.push("--egress");
    // OpenCode needs npm — only offer it on images that have node.
    const nodeCapable = image === undefined || /node|hotcell-base/.test(image);
    if (keys.openrouter && nodeCapable && (await confirm("install OpenCode, ready to run?", false))) {
      flags.setup = OPENCODE_SETUP;
      parts.push(`--setup '<install opencode + point it at the gateway>'`);
    } else if (keys.openrouter && !nodeCapable) {
      out.write(`  ${c.dim}(OpenCode skipped — ${image} has no node/npm)${c.reset}\n`);
    }
  }

  out.write(`\n  ${c.dim}equivalent:${c.reset} ${parts.join(" ")}\n`);
  if (flags.setup) out.write(`  ${c.dim}(the full --setup string: ${OPENCODE_SETUP})${c.reset}\n`);
  if (!(await confirm("create?", true))) {
    out.write(`  ${c.dim}cancelled${c.reset}\n`);
    return 0;
  }
  out.write("\n");
  return createCommand([], globals, flags);
}
