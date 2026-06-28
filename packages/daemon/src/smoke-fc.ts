/**
 * Firecracker live-boot smoke (B1–B6). Drives the real `FirecrackerDriver` —
 * which spawns `firecracker`, configures it over its API socket, boots a microVM,
 * and talks to the in-guest `sbx-agent` over vsock — through the core sandbox
 * surface. **Requires a KVM host** (`/dev/kvm` + the `firecracker` binary + a
 * vsock-capable guest kernel); run on the nested-virt box: `npm run smoke:fc`.
 *
 * Env: SBX_FC_KERNEL (guest vmlinux), SBX_FC_BIN (firecracker). Uses a converted
 * OCI image (default `alpine:3.20`) so the rootfs matches the host arch.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { FirecrackerDriver } from "./driver/firecracker.js";

async function main(): Promise<void> {
  const stateDir = mkdtempSync(join(tmpdir(), "sbx-fc-smoke-"));
  const image = process.env.SBX_FC_SMOKE_IMAGE ?? "alpine:3.20";
  const driver = new FirecrackerDriver({
    fcBin: process.env.SBX_FC_BIN ?? "firecracker",
    kernel: process.env.SBX_FC_KERNEL ?? "helpers/sbx-vz/guest/vmlinux-fc",
    rootfs: "helpers/sbx-vz/guest/rootfs.img", // prebuilt path (unused for a converted image)
    stateDir,
    diskGb: 2,
    imageCacheDir: process.env.SBX_FC_IMAGE_CACHE ?? join(homedir(), ".sbx", "fc", "images"),
  });
  const id = "fcsmoke01";
  let passed = 0;
  const ok = (l: string) => {
    passed++;
    console.log(`  ✓ ${l}`);
  };

  try {
    await driver.ping();
    ok("ping — /dev/kvm + firecracker present");

    console.error(`[smoke-fc] converting ${image} + booting microVM…`);
    await driver.create({ id, image, env: { SBX_FC_TEST: "fc-ok" }, persist: true });
    ok("create — microVM booted and agent reachable over vsock");

    let out = "";
    const code = await driver.exec(id, "echo hi-from-fc && uname -sm", {}, (e) => {
      if (e.type === "stdout") out += e.data;
    });
    assert.equal(code, 0, "exec exit code");
    assert.match(out, /hi-from-fc/, "exec stdout");
    assert.match(out, /Linux x86_64/, "running inside a real x86_64 Linux microVM");
    ok(`exec inside the microVM — ${out.trim().replace(/\n/g, " | ")}`);

    let envOut = "";
    await driver.exec(id, "echo $SBX_FC_TEST", {}, (e) => {
      if (e.type === "stdout") envOut += e.data;
    });
    assert.match(envOut, /fc-ok/, "sandbox env applied");
    ok("sandbox env applied to exec");

    await driver.writeFile(id, { path: "/workspace/persist.txt", content: "fc-persist-123" });
    assert.equal(await driver.readFile(id, { path: "/workspace/persist.txt" }), "fc-persist-123");
    const files = await driver.listFiles(id, { path: "/workspace" });
    assert.ok(files.some((f) => f.name === "persist.txt"), "listFiles sees the file");
    ok("files: write / read / list in /workspace");

    // Background process + liveness.
    const proc = await driver.startProcess(id, "p1", "i=0; while true; do echo t-$i; i=$((i+1)); sleep 0.2; done", {});
    await sleep(700);
    const live = await driver.listProcesses(id, [{ procId: "p1", pid: proc.pid }]);
    assert.ok(live[0]?.running, "process running");
    await driver.killProcess(id, proc.pid);
    ok("background process: start → running → kill");

    // Stats from the guest /proc.
    const stats = await driver.stats(id);
    assert.ok(stats.memBytes > 0 && stats.onlineCpus >= 1, "stats reports mem + cpus");
    ok(`stats: ${stats.onlineCpus} cpu / ${(stats.memBytes / 1e6).toFixed(0)}MB / ${stats.pids} pids`);

    // Persistence across stop/start.
    console.error("[smoke-fc] stop → start (workspace persistence)…");
    await driver.stop(id);
    await driver.start({ id, image, env: {}, persist: true });
    assert.equal(
      await driver.readFile(id, { path: "/workspace/persist.txt" }),
      "fc-persist-123",
      "workspace persisted across stop/start",
    );
    ok("★ workspace.img persists across stop/start");

    await driver.destroy(id);
    ok("destroy");

    console.log(`\nsmoke-fc: ${passed} checks passed (real Firecracker microVM)`);
  } finally {
    await driver.stop(id).catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("smoke-fc FAILED:", err);
    process.exit(1);
  },
);
