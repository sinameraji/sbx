import { readFileSync } from "node:fs";
import type { Config } from "../config.js";
import { log } from "../logger.js";
import { DEFAULT_ALLOWLIST } from "./allowlist-default.js";

/**
 * Domain allowlist for the egress control plane's forward-proxy path (the
 * absolute-form HTTP and CONNECT tunnels that carry pip/npm/git/apt traffic).
 *
 * Default-deny: a host is reachable only if it matches the allowlist AND does not
 * match the denylist (which wins). Matching is by **domain/SNI name, not IP** —
 * registries and code hosts hide behind rotating CDN IPs (Fastly, Cloudflare, S3),
 * so an IP allowlist is both unmaintainable and leaky. The host comes from the
 * forward-proxy request target / the CONNECT authority / the TLS SNI, none of
 * which require decrypting traffic, so there is no MITM.
 *
 * The denylist exists so that even an operator who widens the allowlist can't
 * accidentally re-open DNS-over-HTTPS endpoints (a DNS-exfil / allowlist-bypass
 * channel) without explicitly removing the deny entry.
 */
export interface AllowlistDecision {
  allow: boolean;
  /** Why: `denylist` | `allowlist` | `default-deny`. */
  reason: "denylist" | "allowlist" | "default-deny";
}

export class Allowlist {
  private allowExact = new Set<string>();
  private allowSuffix: string[] = []; // ".foo.com" — matches apex + any subdomain
  private denyExact = new Set<string>();
  private denySuffix: string[] = [];

  constructor(allow: string[], deny: string[]) {
    for (const p of allow) this.add(p, this.allowExact, this.allowSuffix);
    for (const p of deny) this.add(p, this.denyExact, this.denySuffix);
  }

  private add(pattern: string, exact: Set<string>, suffix: string[]): void {
    const p = pattern.trim().toLowerCase().replace(/\.$/, "");
    if (!p) return;
    if (p.startsWith("*.")) suffix.push(p.slice(1)); // "*.foo.com" -> ".foo.com"
    else exact.add(p);
  }

  /** Decide whether `host` (may include a port) may be reached. Deny wins. */
  check(host: string): AllowlistDecision {
    const h = normalizeHost(host);
    if (this.matches(h, this.denyExact, this.denySuffix)) return { allow: false, reason: "denylist" };
    if (this.matches(h, this.allowExact, this.allowSuffix)) return { allow: true, reason: "allowlist" };
    return { allow: false, reason: "default-deny" };
  }

  private matches(host: string, exact: Set<string>, suffix: string[]): boolean {
    if (exact.has(host)) return true;
    // "*.foo.com" (stored as ".foo.com") matches subdomains AND the apex "foo.com".
    return suffix.some((s) => host.endsWith(s) || host === s.slice(1));
  }

  /** Hosts on the allowlist (for logging/introspection). */
  size(): number {
    return this.allowExact.size + this.allowSuffix.length;
  }
}

/** Strip a `:port` and trailing dot, lower-case. */
export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  // Strip a trailing :port (but not the colons inside an IPv6 literal).
  if (!h.includes("[") && h.lastIndexOf(":") > h.indexOf(".")) {
    h = h.slice(0, h.lastIndexOf(":"));
  } else if (h.startsWith("[")) {
    h = h.slice(1, h.indexOf("]"));
  }
  return h.replace(/\.$/, "");
}

interface AllowlistFile {
  deny?: string[];
  /** Tiered allow groups; all are merged. `source_control` is the riskier tier. */
  tiers?: Record<string, string[]>;
  /** Flat allow list (alternative/addition to tiers). */
  allow?: string[];
}

/**
 * Build the deployment allowlist: the checked-in defaults (registries always; the
 * `source_control` tier unless `SBX_ALLOW_SOURCE_CONTROL=false`) plus
 * `SBX_ALLOWLIST_EXTRA` hosts, OR — when `SBX_ALLOWLIST_FILE` is set — that file's
 * `{allow, deny}` verbatim (a full override for operators who want total control).
 */
export function loadAllowlist(config: Config): Allowlist {
  if (config.allowlistFile) {
    try {
      const f = JSON.parse(readFileSync(config.allowlistFile, "utf8")) as AllowlistFile;
      const allow = [...(f.allow ?? []), ...Object.values(f.tiers ?? {}).flat(), ...config.allowlistExtra];
      return new Allowlist(allow, f.deny ?? []);
    } catch (err) {
      log.error("allowlist: SBX_ALLOWLIST_FILE unreadable — failing closed (deny all)", {
        path: config.allowlistFile,
        error: String((err as Error)?.message ?? err),
      });
      return new Allowlist([], []); // fail closed: deny everything rather than silently open
    }
  }
  const def = DEFAULT_ALLOWLIST;
  const allow: string[] = [];
  for (const [name, hosts] of Object.entries(def.tiers)) {
    if (name === "source_control" && !config.allowSourceControl) continue;
    allow.push(...hosts);
  }
  allow.push(...config.allowlistExtra);
  return new Allowlist(allow, def.deny);
}
