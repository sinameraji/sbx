/**
 * Per-sandbox driver selection (M7c) end-to-end check. Builds one DriverRouter
 * and runs a **container** sandbox and an **Apple VZ microVM** sandbox side by
 * side under it, proving the daemon routes each sandbox's ops to the driver it
 * was created with. Needs Docker (container driver) + the VZ helper/guest built.
 * Run on a Mac: `npm run check:router`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { DriverRouter } from "./driver/router.js";
import { emptyUsage, SandboxStore } from "./store.js";
import type { SandboxRecord } from "./types.js";

function record(id: string, driver: string, image: string): SandboxRecord {
  const now = new Date().toISOString();
  return {
    id,
    image,
    status: "running",
    createdAt: now,
    driver,
    labels: {},
    env: {},
    persist: true,
    lastActivityAt: now,
    sleepAfterMs: 0,
    limits: {},
    usage: emptyUsage(),
  };
}

async function main(): Promise<void> {
  const stateDir = mkdtempSync(join(tmpdir(), "sbx-router-"));
  const config = {
    ...loadConfig(),
    driver: "container",
    vzStateDir: stateDir,
    vzImageCacheDir: join(homedir(), ".sbx", "vz", "images"),
  };
  const store = new SandboxStore(":memory:");
  const router = new DriverRouter(config, store, "container");

  let passed = 0;
  const ok = (l: string) => {
    passed++;
    console.log(`  ✓ ${l}`);
  };
  const ids = { c: "router-container", v: "router-applevz" };

  try {
    // Create both sandboxes through the same router, each naming its driver.
    await router.create({ id: ids.c, image: config.defaultImage, driver: "container", persist: true });
    store.add(record(ids.c, "container", config.defaultImage));
    ok("container sandbox created via the router");

    await router.create({ id: ids.v, image: "base", driver: "applevz", persist: true });
    store.add(record(ids.v, "applevz", "base"));
    ok("applevz microVM created via the router");

    // Exec in each: the router must dispatch to the right driver. The kernel
    // string distinguishes them — a shared Docker host kernel vs the guest's own.
    const uname = async (id: string): Promise<string> => {
      let out = "";
      const code = await router.exec(id, "uname -sr", {}, (e) => {
        if (e.type === "stdout") out += e.data;
      });
      assert.equal(code, 0, `exec exit code for ${id}`);
      return out.trim();
    };
    const cKernel = await uname(ids.c);
    const vKernel = await uname(ids.v);
    assert.match(cKernel, /Linux/, "container exec ran");
    assert.match(vKernel, /Linux/, "applevz exec ran");
    ok(`container exec → ${cKernel}`);
    ok(`applevz  exec → ${vKernel}`);

    // Prove isolation: a file written in one sandbox is invisible in the other,
    // and each lands on its own driver (different VM/container).
    await router.writeFile(ids.c, { path: "/workspace/who.txt", content: "container" });
    await router.writeFile(ids.v, { path: "/workspace/who.txt", content: "applevz" });
    assert.equal(await router.readFile(ids.c, { path: "/workspace/who.txt" }), "container");
    assert.equal(await router.readFile(ids.v, { path: "/workspace/who.txt" }), "applevz");
    ok("each sandbox's files are isolated on its own driver");

    console.log(`\nrouter-check: ${passed} checks passed (container + applevz under one router)`);
  } finally {
    await router.destroy(ids.c).catch(() => {});
    await router.destroy(ids.v).catch(() => {});
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("router-check FAILED:", err);
    process.exit(1);
  },
);
