/**
 * Apple VZ warm-pool (M7b) check. Proves a pre-booted spare microVM is adopted
 * on create — an instant acquire — versus a full cold boot, and that the adopted
 * sandbox is fully functional with an isolated workspace that survives stop/start.
 * Run on a Mac with the VZ artifacts built: `npm run check:warmpool`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { AppleVzDriver } from "./driver/applevz.js";

async function main(): Promise<void> {
  const stateDir = mkdtempSync(join(tmpdir(), "hotcell-warmpool-"));
  const driver = new AppleVzDriver({
    helperPath: "helpers/hotcell-vz/dist/hotcell-vz",
    kernel: "helpers/hotcell-vz/guest/vmlinux-vz",
    rootfs: "helpers/hotcell-vz/guest/rootfs.img",
    stateDir,
    diskGb: 2,
    imageCacheDir: join(homedir(), ".sbx", "vz", "images"),
    warmPool: 1, // keep one spare base guest pre-booted
  });

  let passed = 0;
  const ok = (l: string) => {
    passed++;
    console.log(`  ✓ ${l}`);
  };

  try {
    // Wait for the background filler to pre-boot the spare.
    const deadline = Date.now() + 40_000;
    while (driver.poolSize() < 1 && Date.now() < deadline) await sleep(200);
    assert.ok(driver.poolSize() >= 1, "warm pool failed to pre-boot a spare");
    ok(`warm pool pre-booted ${driver.poolSize()} spare guest`);

    // Warm acquire: create a base sandbox — should adopt the spare (instant).
    const warmId = "warm01";
    const t0 = Date.now();
    await driver.create({ id: warmId, image: "base", persist: true });
    const warmMs = Date.now() - t0;
    ok(`warm create adopted a spare in ${warmMs}ms`);

    // The adopted sandbox is a real, working VM with its own workspace.
    let out = "";
    await driver.exec(warmId, "uname -s && echo WARM_OK", {}, (e) => {
      if (e.type === "stdout") out += e.data;
    });
    assert.match(out, /Linux/, "adopted guest runs Linux");
    assert.match(out, /WARM_OK/, "adopted guest execs");
    await driver.writeFile(warmId, { path: "/workspace/w.txt", content: "warm-data" });
    assert.equal(await driver.readFile(warmId, { path: "/workspace/w.txt" }), "warm-data");
    ok("adopted guest execs + has a writable workspace");

    // Workspace survives stop/start (canonical path adopted from the slot).
    await driver.stop(warmId);
    await driver.start({ id: warmId, image: "base", persist: true });
    assert.equal(
      await driver.readFile(warmId, { path: "/workspace/w.txt" }),
      "warm-data",
      "adopted workspace persists across stop/start",
    );
    ok("adopted workspace persists across stop/start");

    // Cold baseline: drain the pool, then create — a full boot for comparison.
    await driver.drainPool();
    const coldId = "cold01";
    const t1 = Date.now();
    await driver.create({ id: coldId, image: "base", persist: true });
    const coldMs = Date.now() - t1;
    ok(`cold create (pool drained) booted in ${coldMs}ms`);

    assert.ok(
      warmMs < coldMs,
      `warm acquire (${warmMs}ms) should beat cold boot (${coldMs}ms)`,
    );
    ok(`★ warm acquire ${warmMs}ms ≪ cold boot ${coldMs}ms (${Math.round(coldMs / Math.max(1, warmMs))}× faster)`);

    await driver.destroy(warmId);
    await driver.destroy(coldId);
    ok("destroy both");

    console.log(`\nwarmpool-check: ${passed} checks passed`);
  } finally {
    await driver.drainPool().catch(() => {});
    await driver.stop("warm01").catch(() => {});
    await driver.stop("cold01").catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("warmpool-check FAILED:", err);
    process.exit(1);
  },
);
