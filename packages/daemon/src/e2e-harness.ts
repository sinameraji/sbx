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
 *      HOTCELL_E2E_MODEL (OpenRouter slug), HOTCELL_E2E_HARNESS — "claude-code"
 *      (default) or "opencode" (any OpenRouter model, e.g. Kimi K2.5),
 *      HOTCELL_E2E_EXPECT — "completion" (default; needs a real provider key) or
 *      "auth-fail": run with a dummy key and accept the provider's auth error
 *      as proof the whole chain works (sandbox → token env → headless Claude
 *      Code → gateway → key injection → real provider), minus the billing.
 * Run: npm run e2e:harness
 */
import assert from "node:assert/strict";
import { HotcellClient, type Sandbox } from "@hotcell/sdk";

async function main(): Promise<number> {
  const endpoint = process.env.SBX_ENDPOINT ?? "http://127.0.0.1:4750";
  const harness = process.env.HOTCELL_E2E_HARNESS ?? "claude-code";
  const model =
    process.env.HOTCELL_E2E_MODEL ??
    (harness === "opencode" ? "openrouter/moonshotai/kimi-k2.5" : "anthropic/claude-3.5-haiku");
  const client = new HotcellClient({ endpoint, apiKey: process.env.SBX_API_KEY });

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

    const installCmd =
      harness === "opencode"
        ? // OpenCode reads the openrouter provider from its config; point its
          // baseURL at the gateway with the egress token as the "key".
          `npm install -g opencode-ai --no-fund --no-audit 2>&1 | tail -1 && mkdir -p ~/.config/opencode && ` +
          `printf '{"provider":{"openrouter":{"options":{"baseURL":"%s/v1","apiKey":"%s"}}}}' ` +
          `"$OPENROUTER_BASE_URL" "$OPENROUTER_API_KEY" > ~/.config/opencode/opencode.json && opencode --version`
        : "npm install -g @anthropic-ai/claude-code --no-fund --no-audit 2>&1 | tail -2 && claude --version";
    console.error(`[e2e] installing ${harness} in the sandbox (~1-2 min)…`);
    const install = await sandbox.exec(installCmd);
    assert.equal(install.exitCode, 0, `install failed:\n${install.stdout}\n${install.stderr}`);
    ok(`headless harness installed: ${harness} ${install.stdout.trim().split("\n").pop()}`);

    console.error(`[e2e] running headless ${harness} through the gateway…`);
    const run = await sandbox.exec(
      harness === "opencode"
        ? `export HOME=/root && opencode run -m "${model}" --dangerously-skip-permissions "Reply with exactly: HOTCELL_E2E_OK" 2>&1`
        :
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
        `claude -p "Reply with exactly: HOTCELL_E2E_OK" --model haiku 2>&1`,
      ].join(" && "),
    );
    const expect = process.env.HOTCELL_E2E_EXPECT ?? "completion";
    if (expect === "auth-fail") {
      // Dummy-key mode: the provider rejecting our injected key IS the proof —
      // the request left headless Claude Code, crossed the gateway, had the
      // (dummy) real key injected, and reached the provider over the internet.
      assert.match(
        run.stdout,
        /401|unauthori[sz]ed|invalid.*(key|token)|authentication/i,
        `expected a provider auth error, got:\n${run.stdout.slice(-800)}`,
      );
      ok("★ headless Claude Code → gateway → real provider (auth error as expected with a dummy key)");
    } else {
      assert.match(
        run.stdout,
        /HOTCELL_E2E_OK/,
        `no completion came back through the gateway:\n${run.stdout.slice(-800)}`,
      );
      ok("★ headless Claude Code completed a real prompt through the egress gateway");
    }

    // The gateway metered the traffic: provider calls on the record.
    const metrics = await sandbox.metrics();
    if (expect === "auth-fail") {
      ok(`gateway saw ${metrics.usage?.providerCalls ?? 0} provider call(s) (auth-fail mode)`);
    } else {
      assert.ok(
        (metrics.usage?.providerCalls ?? 0) > 0,
        "gateway did not meter any provider call",
      );
      ok(
        `gateway metered ${metrics.usage.providerCalls} provider call(s), ` +
          `${metrics.usage.providerTokensIn}/${metrics.usage.providerTokensOut} tokens in/out, ` +
          `provider cost $${metrics.usage.providerCost.toFixed(4)}`,
      );
    }

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
