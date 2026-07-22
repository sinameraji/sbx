/**
 * Dependency-free check for environment import: parsing, routability, the
 * manifest round-trip, and the `inject` path into sandbox env. Run:
 * `npm run check:env`.
 *
 * What this guards is the property the whole flow exists for: hotcell never
 * decides which of your variables are secrets. There is no name heuristic and no
 * vendor table beyond the routes the daemon already ships, so the checks below
 * assert the *absence* of classification as much as the presence of behaviour —
 * an unrecognised name must come back undecided, never guessed into a bucket.
 *
 * Runs in a temp HOME/cwd, so it touches no real keystore and needs no daemon.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "hotcell-env-check-"));
process.env.HOTCELL_HOME = join(scratch, "home");
const project = join(scratch, "project");
process.chdir(mkdtempSync(join(tmpdir(), "hotcell-env-proj-")));

// Imported after HOTCELL_HOME is set — the modules resolve it at load time.
const { parseDotenv } = await import("./keys.js");
const {
  ROUTED_ENV_VARS,
  BUILTIN_ROUTES,
  injectedEnv,
  readManifest,
  suggestRouteName,
  validateBaseUrl,
  writeManifest,
  writeValues,
} = await import("./envconfig.js");

let checks = 0;
const ok = (msg: string) => {
  checks++;
  console.log(`  ✓ ${msg}`);
};

console.log("\n[env-check] parsing");
{
  const parsed = parseDotenv(
    [
      "# a comment",
      "",
      "OPENAI_API_KEY=sk-proj-abc123",
      'export QUOTED="quoted value"',
      "SINGLE='single'",
      "DATABASE_URL=postgres://user:pw@db.internal:5432/app",
      "EMPTY=",
      "not a pair",
    ].join("\n"),
  );
  const names = parsed.map((p) => p.envName);
  assert.deepEqual(names, ["OPENAI_API_KEY", "QUOTED", "SINGLE", "DATABASE_URL"]);
  ok("comments, blanks, `export`, and malformed lines are skipped");
  assert.equal(parsed[1].value, "quoted value");
  assert.equal(parsed[2].value, "single");
  ok("quotes are stripped from values");
  // The parser used to also return a guessed provider per line. It must not:
  // every parsed row is name + value, and nothing else.
  assert.deepEqual(Object.keys(parsed[0]).sort(), ["envName", "value"]);
  ok("parsing infers nothing — no provider, no secret classification");
}

console.log("\n[env-check] routability is a URL parse, not a heuristic");
{
  const good = validateBaseUrl("https://api.stripe.com/");
  assert.ok("url" in good && good.url === "https://api.stripe.com");
  ok("https base URL accepted, trailing slash normalised");

  assert.ok("url" in validateBaseUrl("http://localhost:8080"));
  ok("plain http accepted (self-hosted gateways and local endpoints)");

  const pg = validateBaseUrl("postgres://user:pw@db.internal:5432/app");
  assert.ok("error" in pg && /postgres:/.test(pg.error));
  ok("postgres:// rejected — no request header to swap a credential into");

  for (const bad of ["redis://localhost:6379", "mongodb+srv://c.example.net", "not a url", ""]) {
    assert.ok("error" in validateBaseUrl(bad), `expected ${bad} to be rejected`);
  }
  ok("redis, mongodb, junk, and empty input all rejected");
}

console.log("\n[env-check] preselection is a lookup of existing state");
{
  // Every preselected name must map to a route the daemon actually ships,
  // otherwise a green "gateway" row would promise a swap that never happens.
  for (const [envName, provider] of Object.entries(ROUTED_ENV_VARS)) {
    assert.ok(BUILTIN_ROUTES.has(provider), `${envName} → ${provider} has no built-in route`);
  }
  ok(`all ${Object.keys(ROUTED_ENV_VARS).length} preselected names map to built-in routes`);

  for (const unknown of ["STRIPE_SECRET_KEY", "DATABASE_URL", "NODE_ENV", "GH_TOKEN", "SENTRY_DSN"]) {
    assert.equal(ROUTED_ENV_VARS[unknown], undefined, `${unknown} must not be preselected`);
  }
  ok("unrecognised names are not preselected — they come back undecided");

  // The route-name prefill is a suggestion rendered into an editable field. It
  // may be wrong; it may never be applied silently.
  assert.equal(suggestRouteName("STRIPE_SECRET_KEY"), "stripe");
  assert.equal(suggestRouteName("ACME_TOKEN"), "acme");
  assert.equal(suggestRouteName("DATABASE_URL"), "database_url");
  ok("route-name prefill strips credential suffixes only as a visible default");
}

console.log("\n[env-check] manifest + inject path");
{
  writeManifest({
    version: 1,
    vars: {
      OPENAI_API_KEY: { disposition: "gateway", provider: "openai" },
      STRIPE_SECRET_KEY: { disposition: "gateway", provider: "stripe" },
      DATABASE_URL: { disposition: "inject" },
      NODE_ENV: { disposition: "inject" },
      SENTRY_DSN: { disposition: "skip" },
    },
    shapes: { stripe: { baseUrl: "https://api.stripe.com", authHeader: "authorization", format: "Bearer {key}" } },
  });
  writeValues({
    DATABASE_URL: "postgres://user:pw@db.internal:5432/app",
    NODE_ENV: "production",
    SENTRY_DSN: "https://abc@o1.ingest.sentry.io/1",
  });

  const round = readManifest();
  assert.equal(round.vars.OPENAI_API_KEY.provider, "openai");
  assert.equal(round.shapes.stripe.baseUrl, "https://api.stripe.com");
  ok("manifest round-trips dispositions and shapes");

  const env = injectedEnv();
  assert.deepEqual(Object.keys(env).sort(), ["DATABASE_URL", "NODE_ENV"]);
  ok("only `inject` variables reach a sandbox");

  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.STRIPE_SECRET_KEY, undefined);
  ok("`gateway` keys never reach a sandbox — Stripe is treated exactly like OpenAI");

  assert.equal(env.SENTRY_DSN, undefined);
  ok("a `skip` variable stays on the host even while its value is still stored");
}

console.log("\n[env-check] a project with no manifest is unaffected");
{
  process.chdir(mkdtempSync(join(tmpdir(), "hotcell-env-empty-")));
  assert.deepEqual(injectedEnv(), {});
  ok("no manifest → no injected env (sandboxes outside a project are untouched)");
}

rmSync(scratch, { recursive: true, force: true });
rmSync(project, { recursive: true, force: true });
console.log(`\n[env-check] ${checks}/${checks} passed\n`);
