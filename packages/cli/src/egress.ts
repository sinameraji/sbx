import { HotcellClient, type EgressPolicy } from "@hotcell/sdk";
import type { GlobalArgs } from "./cli.js";

/**
 * sb egress <id>                 — mint an egress token, print provider env exports
 * sb egress <id> --list          — list this sandbox's egress tokens + policies
 * sb egress <id> --revoke <tok>  — revoke a token
 *
 * Policy flags on mint (omit for an unlimited token):
 *   --ttl <dur>        token expiry (e.g. 30m, 24h, 7d)
 *   --spend-cap <usd>  max cumulative USD this token may spend
 *   --models <csv>     allowed model ids/prefixes (e.g. gpt-4o,claude-3-5*)
 *   --providers <csv>  allowed provider names (e.g. openai,anthropic)
 *   --rate-calls <n>   max provider calls per rate window
 *   --rate-tokens <n>  max billed tokens per rate window
 *   --rate-window <dur> rate window length (default 1m when a rate cap is set)
 *
 * The egress credential proxy is an LLM gateway: point a provider SDK at the
 * printed base URL and use the token in place of the real key; the daemon injects
 * the real key (held on the daemon host) and meters + governs the call.
 */
export async function egressCommand(
  positional: string[],
  globals: GlobalArgs,
  flags: Record<string, string | boolean>,
): Promise<number> {
  const id = positional[0];
  if (!id) {
    console.error("Usage: sb egress <id> [--list] [--revoke <token>] [policy flags]");
    return 1;
  }
  const client = new HotcellClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });
  try {
    const sandbox = await client.getSandbox(id);

    if (typeof flags.revoke === "string") {
      await sandbox.revokeEgressToken(flags.revoke);
      console.log(`Revoked ${flags.revoke}`);
      return 0;
    }

    if (flags.list) {
      const { tokens, providers } = await sandbox.listEgressTokens();
      console.log(`${tokens.length} token(s) for ${id}:`);
      for (const t of tokens) console.log(`  ${t.token}  ${summarizePolicy(t.policy)}${spendNote(t)}`);
      console.log(`Providers: ${providers.map((p) => p.name).join(", ") || "(none configured)"}`);
      return 0;
    }

    const policy = buildPolicy(flags);
    if ("error" in policy) {
      console.error(`Failed: ${policy.error}`);
      return 1;
    }
    const minted = await sandbox.createEgressToken(policy.value);
    console.log(`Egress token: ${minted.token}`);
    if (minted.providers.length === 0) {
      console.log(
        "\n(no providers configured — set SBX_PROVIDER_KEY_OPENAI / _ANTHROPIC / _OPENROUTER on the daemon)",
      );
      return 0;
    }
    console.log("\n# Configure the sandbox's LLM SDK with these (token replaces the real key):");
    for (const p of minted.providers) {
      console.log(`# ${p.name}`);
      if (p.baseUrlEnv) console.log(`export ${p.baseUrlEnv}=${p.baseUrl}`);
      if (p.keyEnv) console.log(`export ${p.keyEnv}=${minted.token}`);
    }
    if (minted.policy && Object.keys(minted.policy).length > 0) {
      console.log(`\n# Policy: ${summarizePolicy(minted.policy)}`);
    }
    return 0;
  } catch (err) {
    console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/** Build an EgressPolicy from CLI flags. Returns `{ value }` (undefined if no
 *  policy flags were given) or `{ error }` on a malformed flag. */
function buildPolicy(
  flags: Record<string, string | boolean>,
): { value: EgressPolicy | undefined } | { error: string } {
  const policy: EgressPolicy = {};

  if (typeof flags.ttl === "string") {
    const ms = parseDuration(flags.ttl);
    if (ms === null) return { error: `invalid --ttl: ${flags.ttl}` };
    policy.ttlMs = ms;
  }
  const spend = numFlag(flags["spend-cap"]);
  if (spend === null) return { error: `invalid --spend-cap` };
  if (spend !== undefined) policy.spendCapUsd = spend;

  if (typeof flags.models === "string") policy.models = csv(flags.models);
  if (typeof flags.providers === "string") policy.providers = csv(flags.providers);

  const calls = numFlag(flags["rate-calls"]);
  const tokens = numFlag(flags["rate-tokens"]);
  if (calls === null || tokens === null) return { error: `invalid --rate-calls/--rate-tokens` };
  if (calls !== undefined || tokens !== undefined) {
    let windowMs = 60_000;
    if (typeof flags["rate-window"] === "string") {
      const w = parseDuration(flags["rate-window"]);
      if (w === null || w <= 0) return { error: `invalid --rate-window: ${flags["rate-window"]}` };
      windowMs = w;
    }
    policy.rateLimit = { windowMs };
    if (calls !== undefined) policy.rateLimit.calls = calls;
    if (tokens !== undefined) policy.rateLimit.tokens = tokens;
  }

  return { value: Object.keys(policy).length > 0 ? policy : undefined };
}

/** Parse a duration like `500`, `30s`, `15m`, `24h`, `7d` into milliseconds. */
function parseDuration(s: string): number | null {
  const m = s.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] ?? "ms";
  const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]!;
  return n * mult;
}

/** Read a numeric flag: undefined if absent, null if present-but-invalid. */
function numFlag(v: string | boolean | undefined): number | undefined | null {
  if (v === undefined) return undefined;
  if (typeof v !== "string") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function csv(s: string): string[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

function summarizePolicy(p: EgressPolicy): string {
  const parts: string[] = [];
  if (p.expiresAt) parts.push(`expires ${p.expiresAt}`);
  if (p.spendCapUsd !== undefined) parts.push(`cap $${p.spendCapUsd}`);
  if (p.rateLimit) {
    const r = p.rateLimit;
    const lims = [r.calls && `${r.calls} calls`, r.tokens && `${r.tokens} tok`].filter(Boolean);
    parts.push(`rate ${lims.join("+")}/${r.windowMs}ms`);
  }
  if (p.models) parts.push(`models ${p.models.join("|")}`);
  if (p.providers) parts.push(`providers ${p.providers.join("|")}`);
  return parts.length ? parts.join(", ") : "unlimited";
}

function spendNote(t: { spendUsd: number; spendRemaining: number | null }): string {
  if (t.spendUsd <= 0 && t.spendRemaining === null) return "";
  const rem = t.spendRemaining === null ? "" : `, $${t.spendRemaining.toFixed(4)} left`;
  return `  [spent $${t.spendUsd.toFixed(4)}${rem}]`;
}
