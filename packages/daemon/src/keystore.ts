/**
 * Provider-key storage, shared by the CLI (`hotcell keys …`) and the daemon
 * (which loads keys to swap token→real key at the egress gateway).
 *
 * Three backends, by precedence when loading (env wins so CI can override):
 *   1. file    — ~/.hotcell/keys.json, chmod 600 (the portable fallback)
 *   2. keychain — macOS Keychain via the built-in `security` CLI (encrypted at
 *                 rest; no npm dependency). Used automatically on macOS.
 *   3. env     — HOTCELL_PROVIDER_KEY_<NAME> (and legacy SBX_) — for agents/CI.
 *
 * Writes prefer the keychain on macOS, else the chmod-600 file. Everything is
 * kept on the daemon host and never enters a sandbox.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = process.env.HOTCELL_HOME || join(homedir(), ".hotcell");
const KEYFILE = join(HOME, "keys.json");
const SERVICE = "hotcell";
/** Providers we probe the keychain for (the keychain has no "list by service"). */
export const KNOWN_PROVIDERS = ["openrouter", "openai", "anthropic", "google", "github"];

export type KeySource = "keychain" | "file" | "env";

const onMac = () => process.platform === "darwin";

function keychainGet(provider: string): string | null {
  try {
    return (
      execFileSync("security", ["find-generic-password", "-s", SERVICE, "-a", provider, "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}
function keychainSet(provider: string, value: string): void {
  execFileSync("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", provider, "-w", value], {
    stdio: "ignore",
  });
}
function keychainDelete(provider: string): void {
  try {
    execFileSync("security", ["delete-generic-password", "-s", SERVICE, "-a", provider], { stdio: "ignore" });
  } catch {
    /* not present */
  }
}

function fileRead(): Record<string, string> {
  try {
    return existsSync(KEYFILE) ? (JSON.parse(readFileSync(KEYFILE, "utf8")) as Record<string, string>) : {};
  } catch {
    return {};
  }
}
function fileWrite(obj: Record<string, string>): void {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(KEYFILE, JSON.stringify(obj, null, 2) + "\n");
  try {
    chmodSync(KEYFILE, 0o600);
  } catch {
    /* Windows: relies on the user-profile ACL */
  }
}

/** Store (or replace) a provider key. Returns which backend was used. */
export function storeKey(provider: string, value: string): KeySource {
  provider = provider.toLowerCase();
  if (onMac()) {
    try {
      keychainSet(provider, value);
      return "keychain";
    } catch {
      /* fall through to the file */
    }
  }
  const obj = fileRead();
  obj[provider] = value;
  fileWrite(obj);
  return "file";
}

/** Remove a provider key from every writable backend (keychain + file). */
export function removeKey(provider: string): boolean {
  provider = provider.toLowerCase();
  let removed = false;
  if (onMac()) {
    if (keychainGet(provider)) {
      keychainDelete(provider);
      removed = true;
    }
  }
  const obj = fileRead();
  if (provider in obj) {
    delete obj[provider];
    fileWrite(obj);
    removed = true;
  }
  return removed;
}

/** Load all provider keys with their source. Precedence: file < keychain < env. */
export function loadKeys(): Record<string, { value: string; source: KeySource }> {
  const out: Record<string, { value: string; source: KeySource }> = {};
  for (const [k, v] of Object.entries(fileRead())) out[k.toLowerCase()] = { value: v, source: "file" };
  if (onMac()) {
    for (const p of KNOWN_PROVIDERS) {
      const v = keychainGet(p);
      if (v) out[p] = { value: v, source: "keychain" };
    }
  }
  for (const prefix of ["SBX_PROVIDER_KEY_", "HOTCELL_PROVIDER_KEY_"]) {
    for (const [name, value] of Object.entries(process.env)) {
      if (name.startsWith(prefix) && value) out[name.slice(prefix.length).toLowerCase()] = { value, source: "env" };
    }
  }
  return out;
}

/** Just the name→value map (for the daemon's provider builder). */
export function loadProviderKeyMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [name, { value }] of Object.entries(loadKeys())) map[name] = value;
  return map;
}
