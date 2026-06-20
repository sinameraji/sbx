import { execFile } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";
import type { Config } from "../config.js";
import { log } from "../logger.js";

const exec = promisify(execFile);

/**
 * Host-side default-deny egress firewall for sandboxes (Linux only).
 *
 * When `SBX_EGRESS_ENFORCE=true`, sandboxes run on a dedicated bridge network
 * (`config.egressSubnet`). This installs `iptables` rules in the `DOCKER-USER`
 * chain — the supported, operator-owned hook Docker consults before its own rules
 * — so traffic from that subnet may reach ONLY the egress gateway (the bridge
 * gateway `.1` on `egressPort`) and the pinned DNS resolver; everything else is
 * dropped. The sandbox holds no `CAP_NET_ADMIN`, so it cannot edit these rules.
 *
 * Rules live in a dedicated `SBX-EGRESS` chain that is flushed + rebuilt on every
 * startup (idempotent), with a single jump from `DOCKER-USER`.
 *
 * NOT a hard isolation boundary: a kernel-shared container is weaker than a VM,
 * and on Docker Desktop (macOS) `DOCKER-USER` isn't host-editable — there
 * enforcement degrades to advisory (proxy env is still set, but direct egress is
 * not blocked). Transparent, in-guest-enforced default-deny is the microVM driver's
 * job; this is the best that plain Docker on Linux can do. Requires the daemon to
 * run with iptables privileges (root or `CAP_NET_ADMIN`).
 */

const CHAIN = "SBX-EGRESS";

/** Derive the bridge gateway IP (`.1`) from a `/24`-style subnet base. */
export function gatewayOf(subnet: string): string {
  const base = subnet.split("/")[0] ?? subnet;
  const octets = base.split(".");
  if (octets.length !== 4) return base;
  octets[3] = "1";
  return octets.join(".");
}

export async function ensureEgressFirewall(config: Config): Promise<void> {
  if (!config.egressEnforce) return;
  if (platform() !== "linux") {
    log.warn(
      "egress enforcement requested but host is not Linux — fail-closed firewall is ADVISORY only " +
        "(proxy env is injected, but direct egress is NOT blocked). Use the microVM driver for hard isolation.",
      { platform: platform() },
    );
    return;
  }

  const subnet = config.egressSubnet;
  const gateway = gatewayOf(subnet);
  const port = String(config.egressPort);
  const dns = config.egressDnsResolver;

  // The ordered rule set for the SBX-EGRESS chain. Allows return traffic, the
  // gateway, and DNS (to the pinned resolver if set, else the bridge gateway, which
  // Docker's embedded resolver forwards through); drops the rest.
  const rules: string[][] = [
    ["-m", "state", "--state", "ESTABLISHED,RELATED", "-j", "ACCEPT"],
    ["-p", "tcp", "-d", gateway, "--dport", port, "-j", "ACCEPT"],
    ["-p", "udp", "-d", dns || gateway, "--dport", "53", "-j", "ACCEPT"],
    ["-p", "tcp", "-d", dns || gateway, "--dport", "53", "-j", "ACCEPT"],
    ["-j", "DROP"],
  ];

  try {
    // Create (ignore "exists"), then flush so we rebuild cleanly each boot.
    await ipt(["-N", CHAIN]).catch(() => {});
    await ipt(["-F", CHAIN]);
    for (const rule of rules) await ipt(["-A", CHAIN, ...rule]);
    // Jump from DOCKER-USER for our subnet, exactly once.
    const jump = ["-s", subnet, "-j", CHAIN];
    const present = await ipt(["-C", "DOCKER-USER", ...jump]).then(
      () => true,
      () => false,
    );
    if (!present) await ipt(["-I", "DOCKER-USER", ...jump]);
    log.info("egress firewall installed (default-deny)", { subnet, gateway, port, dns: dns || "embedded" });
  } catch (err) {
    log.error(
      "egress firewall: failed to install iptables rules — egress is NOT locked down. " +
        "Run the daemon with root / CAP_NET_ADMIN, or disable SBX_EGRESS_ENFORCE.",
      { error: String((err as Error)?.message ?? err) },
    );
  }
}

/** Run an `iptables` command, throwing with stderr on failure. */
async function ipt(args: string[]): Promise<void> {
  await exec("iptables", ["-w", ...args]);
}
