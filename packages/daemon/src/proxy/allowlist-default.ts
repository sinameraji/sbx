/**
 * Curated DEFAULT egress allowlist — the "agents can do real work" baseline.
 * Checked into the repo so the community can audit and PR it. Domain/SNI names
 * only (never IPs). Operators override wholesale with `SBX_ALLOWLIST_FILE`, extend
 * with `SBX_ALLOWLIST_EXTRA`, or drop the riskier `source_control` tier with
 * `SBX_ALLOW_SOURCE_CONTROL=false`.
 *
 * Tiers:
 *  - `registries`     — package managers + their CDNs. ON by default.
 *  - `source_control` — git hosts (github/gitlab/bitbucket). ON by default, but
 *                       NOTE: a writable git host is also an exfil channel
 *                       (`git push` to an attacker repo). High-security operators
 *                       should disable this tier.
 *
 * `deny` is checked before `allow` and lists DNS-over-HTTPS endpoints, so an agent
 * can't tunnel DNS (or arbitrary data) out through a DoH resolver even if a wide
 * allowlist would otherwise permit it.
 */
export interface AllowlistData {
  deny: string[];
  tiers: Record<string, string[]>;
}

export const DEFAULT_ALLOWLIST: AllowlistData = {
  deny: [
    // DNS-over-HTTPS resolvers (DNS/data exfil channel).
    "cloudflare-dns.com",
    "mozilla.cloudflare-dns.com",
    "dns.google",
    "dns.google.com",
    "dns.quad9.net",
    "doh.opendns.com",
    "doh.cleanbrowsing.org",
    "*.dns.nextdns.io",
  ],
  tiers: {
    registries: [
      // Python
      "pypi.org",
      "files.pythonhosted.org",
      // Node
      "registry.npmjs.org",
      // Rust
      "crates.io",
      "static.crates.io",
      "index.crates.io",
      // Go
      "proxy.golang.org",
      "sum.golang.org",
      // Ruby
      "rubygems.org",
      "*.rubygems.org",
      // Java / Maven
      "repo.maven.apache.org",
      "repo1.maven.org",
      // PHP / Composer
      "packagist.org",
      "repo.packagist.org",
      // OS packages (base images)
      "deb.debian.org",
      "security.debian.org",
      "archive.ubuntu.com",
      "security.ubuntu.com",
      "ports.ubuntu.com",
      "dl-cdn.alpinelinux.org",
    ],
    source_control: [
      "github.com",
      "codeload.github.com",
      "*.githubusercontent.com",
      "gitlab.com",
      "bitbucket.org",
    ],
  },
};
