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

  // -n / --count: create N identical cells in one command (each with its own
  // auto-named branch under `--branch`). stdout stays machine-clean: one id per
  // line, so `ids=$(hotcell create -n 5 …)` splits trivially.
  const count = Math.max(1, Math.floor(Number(flags.n ?? flags.count ?? 1)) || 1);
  const options = {
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
  };

  if (count > 1) {
    // A NAMED branch with -n would give every cell the same branch → colliding
    // pushes. Auto-suffix per cell (feat/x-1…N) and say so; bare --branch (auto)
    // already yields a unique name per sandbox daemon-side.
    const optionsFor = (i: number) =>
      branch && branch !== "auto" ? { ...options, branch: `${branch}-${i + 1}` } : options;
    const results = await Promise.allSettled(
      Array.from({ length: count }, (_, i) => client.getSandbox(undefined, optionsFor(i))),
    );
    const ok = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof client.getSandbox>>> =>
        r.status === "fulfilled",
    );
    for (const r of ok) console.log(r.value.id);
    const failed = results.length - ok.length;
    if (process.stderr.isTTY) {
      console.error(`✓ created ${ok.length}/${count} sandboxes`);
      ok.forEach((r, i) => console.error(`  #${i + 1}  hotcell terminal ${r.value.id}`));
      if (branch === "auto") console.error(`  each on its own branch (auto-named)`);
      else if (branch) console.error(`  branches ${branch}-1 … ${branch}-${count} (suffixed so pushes don't collide)`);
    }
    if (failed) {
      const first = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
      console.error(
        `✗ ${failed} create(s) failed: ${first ? String(first.reason?.message ?? first.reason) : "unknown"}`,
      );
    }
    return failed ? 1 : 0;
  }

  try {
    const sandbox = await client.getSandbox(undefined, options);
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

    // TTY-only guidance; and a token-listing hiccup must NOT flip the exit code —
    // the sandbox exists and its id is already on stdout (agents would retry and
    // leak sandboxes otherwise). Recoverable anytime via `hotcell egress <id>`.
    if (egress && process.stderr.isTTY) {
      try {
        const { providers } = await sandbox.listEgressTokens();
        console.error("");
        for (const p of providers) {
          if (p.baseUrlEnv) console.error(`  ${p.baseUrlEnv}=${p.baseUrl}`);
        }
      } catch (err) {
        console.error(`  (sandbox created; egress token listing failed: ${err instanceof Error ? err.message : String(err)})`);
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
