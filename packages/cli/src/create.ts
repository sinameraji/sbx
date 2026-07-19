import { HotcellClient } from "@hotcell/sdk";
import type { GlobalArgs } from "./cli.js";
import { parseEnvPairs } from "./env.js";
import { parseLimitFlags } from "./util.js";

/**
 * hotcell create [--image I] [--env K=V,…] [--sleep-after MS] [--egress] [--label K=V,…]
 *           [--setup "cmd"]
 *
 * Provision a standalone, persistent sandbox and print its id (unlike `sb run`,
 * which runs a command and destroys the sandbox). With `--egress`, also prints the
 * provider env exports the gateway wired in.
 */
export async function createCommand(
  positional: string[],
  globals: GlobalArgs,
  flags: Record<string, string | boolean>,
): Promise<number> {
  const client = new HotcellClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });

  const image = typeof flags.image === "string" ? flags.image : undefined;
  const egress = flags.egress === true;
  const egressSpendCapUsd =
    typeof flags["egress-spend-cap"] === "string" ? Number(flags["egress-spend-cap"]) : undefined;
  const sleepAfter =
    typeof flags["sleep-after"] === "string" ? Number(flags["sleep-after"]) : undefined;
  const driver = typeof flags.driver === "string" ? flags.driver : undefined;
  const { memoryMb, cpus, pidsLimit } = parseLimitFlags(flags);
  const setup = typeof flags.setup === "string" ? [flags.setup] : undefined;
  const repo = typeof flags.repo === "string" ? flags.repo : undefined;
  const repoRef = typeof flags.ref === "string" ? flags.ref : undefined;
  // --branch feat/x  → that name;  bare --branch  → an auto-generated name.
  const branch =
    typeof flags.branch === "string" ? flags.branch : flags.branch === true ? "auto" : undefined;

  let env: Record<string, string> | undefined;
  let labels: Record<string, string> | undefined;
  try {
    if (typeof flags.env === "string") env = parseEnvPairs(flags.env.split(","));
    if (typeof flags.label === "string") labels = parseEnvPairs(flags.label.split(","));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  try {
    const sandbox = await client.getSandbox(undefined, {
      image,
      env,
      labels,
      sleepAfter,
      driver,
      egress,
      egressSpendCapUsd,
      setup,
      repo,
      repoRef,
      branch,
      memoryMb,
      cpus,
      pidsLimit,
    });
    console.log(sandbox.id); // stdout = just the id, so `id=$(hotcell create …)` + agents are unaffected

    // Human affordance (stderr, TTY only): the specs, what's actually installed,
    // and the obvious next moves — otherwise invisible unless you read --help.
    // Non-TTY (agents / CI / pipes) get nothing but the id above.
    if (process.stderr.isTTY) {
      const si = sandbox.getInfo();
      const info = await client.info().catch(() => null);
      const drv = driver ?? info?.driver ?? "container";
      const lim = si.limits ?? {};
      const specParts = [
        lim.cpus ? `${lim.cpus} cpu` : null,
        lim.memoryMb ? `${(lim.memoryMb / 1024).toFixed(lim.memoryMb % 1024 ? 1 : 0)} GiB` : null,
      ].filter(Boolean);
      const desc = describeImage(si.image);
      const e = (s: string) => console.error(s);
      e(`✓ created ${si.id}  ·  ${drv} · ${specParts.length ? specParts.join(" · ") : "unlimited"}`);
      e(`  image      ${si.image}${desc ? `   — ${desc}` : ""}`);
      e(`  workspace  /workspace${repo ? " (repo cloned)" : " (empty)"}`);
      if (branch) e(`  branch     ${branch === "auto" ? "new (auto-named)" : branch}`);
      e("");
      e(`  open a shell   hotcell terminal ${si.id}`);
      if (!setup && !repo) e(`  preinstall     recreate with  --setup "…"   ·   clone a repo:  --repo <url>`);
      if (/slim/.test(si.image)) e(`  fuller image   --image python:3.11 (+git +build tools)   ·   see all: hotcell images`);
      e(`  run an agent   see examples/ (OpenCode, Codex, Claude Code, Mastra) — add --egress for keyless LLM`);
    }

    if (egress) {
      const { providers } = await sandbox.listEgressTokens();
      if (process.stderr.isTTY) console.error("");
      for (const p of providers) {
        if (p.baseUrlEnv) console.error(`  ${p.baseUrlEnv}=${p.baseUrl}`);
      }
    }
    return 0;
  } catch (err) {
    console.error(`Failed to create sandbox: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/**
 * One-line, honest summary of what a base image ships — matched on the image name
 * (we can't introspect the layers). Empty string = don't guess. Keeps the create
 * hint truthful about why a fresh sandbox feels bare (e.g. `-slim` = no git/node).
 */
function describeImage(image: string): string {
  if (/hotcell[/-]base/.test(image)) return "python + node + git + build tools";
  if (/python:.*slim/.test(image)) return "python3 + pip — no git, node, or build tools";
  if (/(^|\/)python:/.test(image)) return "python3 + pip + git + build tools (no node)";
  if (/(^|\/)node:/.test(image)) return "node + npm + git (no python)";
  if (/(^|\/)(ubuntu|debian):/.test(image)) return "bare OS — install what you need with apt";
  return "";
}
