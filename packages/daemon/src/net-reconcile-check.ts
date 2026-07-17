/**
 * Regression check for the egress-network subnet-collision reconcile (the 422
 * an upgrader hits when a pre-rename daemon left `sbx-egress` squatting the
 * enforcement subnet). Needs Docker. Run: `npm run check:netreconcile`.
 *
 * Scenarios:
 *  1. A stale *hotcell-managed*, idle network on our subnet → removed + recreated
 *     under our name (the upgrade case). initEgress() succeeds.
 *  2. A *foreign* (unlabelled) network on our subnet → NOT deleted; initEgress()
 *     fails with an actionable message naming it and the override flag.
 */
import assert from "node:assert/strict";
import Docker from "dockerode";
import { ContainerDriver, type EgressNetConfig } from "./driver/container.js";

const SUBNET = "10.211.0.0/24"; // an unusual range so we never touch a real one
const OURS = "hotcell-egress-check";
const STALE = "sbx-egress-check-stale";
const FOREIGN = "someone-elses-net-check";

let passed = 0;
const ok = (l: string) => {
  passed++;
  console.log(`  ✓ ${l}`);
};

async function rm(docker: Docker, name: string): Promise<void> {
  try {
    await docker.getNetwork(name).remove();
  } catch {
    /* not there */
  }
}

async function main(): Promise<void> {
  const docker = new Docker();
  await docker.ping();
  const egress: EgressNetConfig = { enforce: true, network: OURS, subnet: SUBNET, dns: "" };

  // Clean slate.
  for (const n of [OURS, STALE, FOREIGN]) await rm(docker, n);

  try {
    // Scenario 1 — stale hotcell-managed network squatting the subnet.
    await docker.createNetwork({
      Name: STALE,
      Driver: "bridge",
      IPAM: { Config: [{ Subnet: SUBNET }] },
      Labels: { "sbx.managed": "true" }, // pre-rename label
    });
    const d1 = new ContainerDriver(docker, egress);
    await d1.initEgress(); // must reconcile, not throw
    const nets1 = await docker.listNetworks();
    assert.ok(nets1.some((n) => n.Name === OURS), "our egress network was created");
    assert.ok(!nets1.some((n) => n.Name === STALE), "stale network was removed");
    ok("stale hotcell-managed network on our subnet → removed + recreated (no 422)");
    await rm(docker, OURS);

    // Scenario 2 — a foreign network holding the subnet must NOT be deleted.
    await docker.createNetwork({
      Name: FOREIGN,
      Driver: "bridge",
      IPAM: { Config: [{ Subnet: SUBNET }] },
      // no hotcell/sbx label → not ours
    });
    const d2 = new ContainerDriver(docker, egress);
    let threw = false;
    try {
      await d2.initEgress();
    } catch (err) {
      threw = true;
      const msg = (err as Error).message;
      assert.match(msg, new RegExp(FOREIGN), "error names the conflicting network");
      assert.match(msg, /HOTCELL_EGRESS_SUBNET/, "error names the override flag");
    }
    assert.ok(threw, "initEgress fails loudly on a foreign subnet collision");
    const nets2 = await docker.listNetworks();
    assert.ok(nets2.some((n) => n.Name === FOREIGN), "foreign network was NOT deleted");
    ok("foreign network on our subnet → fails loudly, left intact");

    console.log(`\nnet-reconcile-check: ${passed} checks passed`);
  } finally {
    for (const n of [OURS, STALE, FOREIGN]) await rm(docker, n);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("net-reconcile-check FAILED:", err);
    process.exit(1);
  },
);
