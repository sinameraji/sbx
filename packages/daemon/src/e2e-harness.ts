/**
 * Real-harness e2e (plan §Verification 5): run **headless Claude Code** inside a
 * sandbox with provider keys injected by the egress gateway — the sandbox only
 * ever sees a revocable per-sandbox token; the daemon swaps it for the real key
 * and meters the call.
 *
 * The gateway's `openrouter` provider serves Anthropic's Messages API
 * (openrouter.ai/api is Anthropic-compatible), so Claude Code speaks its native
 * protocol through the gateway with the OpenRouter key held on the daemon host.
 *
 * Prereqs: a daemon whose environment has SBX_PROVIDER_KEY_OPENROUTER, Docker
 * (container driver), and internet egress for the gateway itself.
 * Env: SBX_ENDPOINT (default http://127.0.0.1:4750), SBX_API_KEY (if auth on),
 *      SBX_E2E_MODEL (OpenRouter slug; default anthropic/claude-3.5-haiku).
 * Run: npm run e2e:harness
 */
import assert from "node:assert/strict";
import { SbxClient, type Sandbox } from "@sbx/sdk";

async function main(): Promise<number> {
  const endpoint = process.env.SBX_ENDPOINT ?? "http://127.0.0.1:4750";
  const model = process.env.SBX_E2E_MODEL ?? "anthropic/claude-3.5-haiku";
  const client = new SbxClient({ endpoint, apiKey: process.env.SBX_API_KEY });

  let passed = 0;
  const ok = (l: string) => {
    passed++;
    console.log(`  ✓ ${l}`);
  };

  const info = await client.info();
  assert.ok(
    info.egressProviders?.includes("openrouter"),
    `daemon has no openrouter provider key (providers: ${info.egressProviders?.join(", ") || "none"})`,
  );
  ok(`daemon up (${endpoint}); gateway providers: ${info.egressProviders.join(", ")}`);

  let sandbox: Sandbox | undefined;
  try {
    // Node image: Claude Code is an npm package. `egress: true` auto-wires the
    // provider env (BASE_URLs at the gateway + the token as key).
    sandbox = await client.getSandbox(undefined, { image: "node:22-slim", egress: true });
    ok(`sandbox ${sandbox.id} created (node:22-slim, egress wired)`);

    const wiring = await sandbox.exec("echo url=$OPENROUTER_BASE_URL; echo tok=${OPENROUTER_API_KEY:+set}");
    assert.match(wiring.stdout, /url=http.+\/openrouter/, "OPENROUTER_BASE_URL not injected");
    assert.match(wiring.stdout, /tok=set/, "egress token not injected");
    assert.ok(
      !/sk-or-/.test(wiring.stdout),
      "a real provider key leaked into the sandbox env",
    );
    ok("egress env wired: gateway base URL + token (no real key in the sandbox)");

    console.error("[e2e] installing @anthropic-ai/claude-code in the sandbox (~1-2 min)…");
    const install = await sandbox.exec(
      "npm install -g @anthropic-ai/claude-code --no-fund --no-audit 2>&1 | tail -2 && claude --version",
    );
    assert.equal(install.exitCode, 0, `install failed:\n${install.stdout}\n${install.stderr}`);
    ok(`headless harness installed: claude ${install.stdout.trim().split("\n").pop()}`);

    console.error("[e2e] running headless Claude Code through the gateway…");
    const run = await sandbox.exec(
      [
        // Claude Code → gateway → openrouter.ai/api/v1/messages, per OpenRouter's
        // Claude Code integration guide: base URL swap, token as auth, blank the
        // real-key var so nothing conflicts, model pinned to a cheap Anthropic slug.
        `export ANTHROPIC_BASE_URL="$OPENROUTER_BASE_URL"`,
        `export ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY"`,
        `export ANTHROPIC_API_KEY=""`,
        `export ANTHROPIC_DEFAULT_HAIKU_MODEL="${model}"`,
        `export DISABLE_TELEMETRY=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`,
        `export HOME=/root IS_SANDBOX=1`,
        `claude -p "Reply with exactly: SBX_E2E_OK" --model haiku 2>&1`,
      ].join(" && "),
    );
    assert.match(
      run.stdout,
      /SBX_E2E_OK/,
      `no completion came back through the gateway:\n${run.stdout.slice(-800)}`,
    );
    ok("★ headless Claude Code completed a real prompt through the egress gateway");

    // The gateway metered the call: provider requests + tokens on the record.
    const metrics = await sandbox.metrics();
    assert.ok(
      (metrics.usage?.providerCalls ?? 0) > 0,
      "gateway did not meter any provider call",
    );
    ok(
      `gateway metered ${metrics.usage.providerCalls} provider call(s), ` +
        `${metrics.usage.providerTokensIn}/${metrics.usage.providerTokensOut} tokens in/out, ` +
        `provider cost $${metrics.usage.providerCost.toFixed(4)}`,
    );

    console.log(`\ne2e-harness: ${passed} checks passed (real agent, real completion, key never in sandbox)`);
    return 0;
  } catch (err) {
    console.error(`e2e-harness FAILED: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    if (sandbox) await sandbox.destroy().catch(() => {});
  }
}

main().then((code) => process.exit(code));
