import { HotcellClient } from "@hotcell/sdk";
import type { GlobalArgs } from "./cli.js";
import { configExists, defaultEndpoint, resolveSetting } from "./configfile.js";
import { isUp, startEngine } from "./engine.js";
import { keysCommand } from "./keys.js";
import { loadKeys, KNOWN_PROVIDERS } from "./keystore.js";
import { c, confirm, readKey, select } from "./prompts.js";
import { setupCommand } from "./setup.js";
import { tuiCommand } from "./tui.js";
import { createWizard } from "./wizard.js";

/**
 * Bare `hotcell` (TTY) — the human front door.
 *
 * State machine (the wizard triggers on "never configured", NOT "not running"):
 *   never configured + daemon down  → setup wizard, then the menu
 *   configured but daemon down      → one-keystroke "start it?", then the menu
 *   daemon running                  → the menu (fleet view preselected: Enter drops in)
 *
 * Non-TTY bare `hotcell` never reaches here (cli.ts prints help), so agents and
 * pipes are untouched.
 */
export async function menuCommand(globals: GlobalArgs): Promise<number> {
  // Setup can mint an API key / change the port mid-session; the menu loop must
  // pick those up or every later action 401s against the restarted daemon.
  const refreshGlobals = () => {
    globals.apiKey =
      process.env.HOTCELL_API_KEY ?? process.env.SBX_API_KEY ?? resolveSetting("API_KEY");
    globals.endpoint = globals.endpoint ?? defaultEndpoint();
  };
  const client = () => new HotcellClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });

  if (!(await isUp(client().endpoint))) {
    if (!configExists()) {
      // First run on this machine: surface the irreversible decisions first.
      process.stdout.write(`\n  ${c.bold}${c.cyan}● hotcell${c.reset}   ${c.dim}first run on this machine — quick setup (or Ctrl-C, and use flags/env)${c.reset}\n`);
      const rc = await setupCommand(globals, {});
      refreshGlobals();
      if (rc !== 0) return rc;
      // Cancelled without configuring? Respect the bail — don't trap them in a
      // menu whose every entry needs the daemon they just declined to set up.
      if (!configExists()) return 0;
    } else if (await confirm("hotcell daemon isn't running — start it?", true)) {
      const rc = await startEngine(globals, {});
      if (rc !== 0) return rc;
    } else {
      process.stdout.write(`  ${c.dim}ok — start it later with: hotcell start${c.reset}\n`);
      return 0;
    }
  }

  for (;;) {
    process.stdout.write("\n");
    const pick = await select(`${c.cyan}● hotcell${c.reset}`, [
      { label: "View / manage sandboxes", hint: "live fleet — attach, pause, cost" },
      { label: "Create a sandbox", hint: "guided: image · repo · branch · egress" },
      { label: "Manage provider keys", hint: "openrouter · openai · anthropic · google · github" },
      { label: "Daemon setup", hint: "access · egress · isolation · default image" },
      { label: "Quit" },
    ]);
    if (pick === 0) await tuiCommand([], globals);
    else if (pick === 1) await createWizard(globals);
    else if (pick === 2) await keysMenu(globals);
    else if (pick === 3) {
      await setupCommand(globals, {});
      refreshGlobals();
    } else return 0; // Quit, or Esc (-1)
  }
}

async function keysMenu(globals: GlobalArgs): Promise<void> {
  for (;;) {
    process.stdout.write("\n");
    const pick = await select("provider keys", [
      { label: "Show keys" },
      { label: "Add a key", hint: "hidden input · keychain · applies live" },
      { label: "Remove a key" },
      { label: "Back" },
    ]);
    if (pick === 0) {
      await keysCommand(["ls"], globals, {});
      process.stdout.write(`  ${c.dim}(any key to continue)${c.reset}`);
      await readKey();
      process.stdout.write("\n");
    } else if (pick === 1) {
      const opts = [...KNOWN_PROVIDERS.map((p) => ({ label: p })), { label: "cancel" }];
      const which = await select("provider", opts, KNOWN_PROVIDERS.length);
      if (which >= 0 && which < KNOWN_PROVIDERS.length) {
        await keysCommand(["add", KNOWN_PROVIDERS[which]], globals, {});
      }
    } else if (pick === 2) {
      const names = Object.keys(loadKeys());
      if (names.length === 0) {
        process.stdout.write(`  ${c.dim}no keys stored${c.reset}\n`);
        continue;
      }
      const which = await select("remove which?", [...names.map((n) => ({ label: n })), { label: "cancel" }], names.length);
      if (which >= 0 && which < names.length) await keysCommand(["rm", names[which]], globals, {});
    } else return; // Back, or Esc (-1)
  }
}
