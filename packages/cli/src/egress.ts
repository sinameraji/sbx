import { SbxClient } from "@sbx/sdk";
import type { GlobalArgs } from "./cli.js";

/**
 * sb egress <id>                 — mint an egress token, print provider env exports
 * sb egress <id> --list          — list this sandbox's egress tokens
 * sb egress <id> --revoke <tok>  — revoke a token
 *
 * The egress credential proxy is an LLM gateway: point a provider SDK at the
 * printed base URL and use the token in place of the real key; the daemon injects
 * the real key (held on the daemon host) and meters the call.
 */
export async function egressCommand(
  positional: string[],
  globals: GlobalArgs,
  flags: Record<string, string | boolean>,
): Promise<number> {
  const id = positional[0];
  if (!id) {
    console.error("Usage: sb egress <id> [--list] [--revoke <token>]");
    return 1;
  }
  const client = new SbxClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });
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
      for (const t of tokens) console.log(`  ${t}`);
      console.log(`Providers: ${providers.map((p) => p.name).join(", ") || "(none configured)"}`);
      return 0;
    }

    const minted = await sandbox.createEgressToken();
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
    return 0;
  } catch (err) {
    console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
