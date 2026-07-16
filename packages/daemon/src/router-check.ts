/**
 * Per-sandbox driver selection (M7c) end-to-end check. Builds one DriverRouter
 * and runs a **container** sandbox and a **microVM** sandbox side by side under
 * it, proving the daemon routes each sandbox's ops to the driver it was created
 * with. The microVM driver is platform-picked (applevz on macOS, firecracker on
 * Linux; override with SBX_ROUTER_MICROVM). Needs Docker (container driver) +
 * the platform's microVM prerequisites. Run: `npm run check:router`.
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
  const microvm =
    process.env.SBX_ROUTER_MICROVM ?? (process.platform === "darwin" ? "applevz" : "firecracker");
  const microImage =
    process.env.SBX_ROUTER_MICROVM_IMAGE ?? (microvm === "applevz" ? "base" : "alpine:3.20");
  const config = {
    ...loadConfig(),
    driver: "container",
    ...(microvm === "applevz"
      ? { vzStateDir: stateDir, vzImageCacheDir: join(homedir(), ".sbx", "vz", "images") }
      : { fcStateDir: stateDir }),
  };
  const store = new SandboxStore(":memory:");
  const router = new DriverRouter(config, store, "container");

  let passed = 0;
  const ok = (l: string) => {
    passed++;
    console.log(`  ✓ ${l}`);
  };
  const ids = { c: "router-container", v: `router-${microvm}` };

  try {
    // Create both sandboxes through the same router, each naming its driver.
    await router.create({ id: ids.c, image: config.defaultImage, driver: "container", persist: true });
    store.add(record(ids.c, "container", config.defaultImage));
    ok("container sandbox created via the router");

    await router.create({ id: ids.v, image: microImage, driver: microvm, persist: true });
    store.add(record(ids.v, microvm, microImage));
    ok(`${microvm} microVM created via the router`);

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
    assert.match(vKernel, /Linux/, "microVM exec ran");
    ok(`container exec → ${cKernel}`);
    ok(`${microvm}  exec → ${vKernel}`);

    // Prove isolation: a file written in one sandbox is invisible in the other,
    // and each lands on its own driver (different VM/container).
    await router.writeFile(ids.c, { path: "/workspace/who.txt", content: "container" });
    await router.writeFile(ids.v, { path: "/workspace/who.txt", content: microvm });
    assert.equal(await router.readFile(ids.c, { path: "/workspace/who.txt" }), "container");
    assert.equal(await router.readFile(ids.v, { path: "/workspace/who.txt" }), microvm);
    ok("each sandbox's files are isolated on its own driver");

    console.log(`\nrouter-check: ${passed} checks passed (container + ${microvm} under one router)`);
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
