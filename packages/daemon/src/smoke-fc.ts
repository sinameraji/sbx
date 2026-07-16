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
import { createServer as createHttpServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { FirecrackerDriver } from "./driver/firecracker.js";

async function main(): Promise<void> {
  const stateDir = mkdtempSync(join(tmpdir(), "sbx-fc-smoke-"));
  const image = process.env.SBX_FC_SMOKE_IMAGE ?? "alpine:3.20";
  // Mock egress gateway: guests reach it ONLY via the vsock relay (no NIC).
  const EGRESS_PORT = 47523;
  const gateway = createHttpServer((_req, res) => res.end("fc-egress-pong"));
  await new Promise<void>((r) => gateway.listen(EGRESS_PORT, "127.0.0.1", r));
  const driver = new FirecrackerDriver({
    fcBin: process.env.SBX_FC_BIN ?? "firecracker",
    kernel: process.env.SBX_FC_KERNEL ?? "helpers/sbx-vz/guest/vmlinux-fc",
    rootfs: "helpers/sbx-vz/guest/rootfs.img", // prebuilt path (unused for a converted image)
    stateDir,
    diskGb: 2,
    imageCacheDir: process.env.SBX_FC_IMAGE_CACHE ?? join(homedir(), ".sbx", "fc", "images"),
    egressPort: EGRESS_PORT,
    egressHost: "127.0.0.1",
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

    // Egress-over-vsock: the NIC-less guest reaches the (mock) gateway through
    // its loopback relay — its only route out of the VM.
    let egOut = "";
    const egCode = await driver.exec(id, `wget -qO- http://127.0.0.1:${EGRESS_PORT}/ping`, {}, (e) => {
      if (e.type === "stdout") egOut += e.data;
    });
    assert.equal(egCode, 0, "in-guest wget via the egress relay");
    assert.match(egOut, /fc-egress-pong/, "egress relay reached the gateway");
    ok("★ egress-over-vsock: guest loopback → vsock → gateway (no NIC)");

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

    // Fast-pause → resume (B7): full snapshot to disk, restore WITHOUT a kernel
    // boot. In-RAM state must survive: a tmpfs marker + a live background process.
    console.error("[smoke-fc] snapshot → resume (fast-pause)…");
    const markerCode = await driver.exec(
      id,
      "grep -qE '^tmpfs /tmp ' /proc/mounts && echo ram-1 > /tmp/ram-marker",
      {},
      () => {},
    );
    assert.equal(markerCode, 0, "/tmp is tmpfs (marker is genuinely RAM-only)");
    const survivor = await driver.startProcess(id, "p2", "while true; do sleep 1; done", {});
    const tSave = Date.now();
    await driver.snapshot(id);
    const saveMs = Date.now() - tSave;
    const tResume = Date.now();
    await driver.start({ id, image, env: {}, persist: true });
    const resumeMs = Date.now() - tResume;
    assert.match(
      await driver.readFile(id, { path: "/tmp/ram-marker" }),
      /ram-1/,
      "tmpfs marker survived snapshot→resume (guest RAM restored)",
    );
    const alive = await driver.listProcesses(id, [{ procId: "p2", pid: survivor.pid }]);
    assert.ok(alive[0]?.running, "background process survived snapshot→resume");
    await driver.killProcess(id, survivor.pid);
    // The egress relay survives the cycle: the in-guest listener lives in
    // restored RAM; the host relay is re-installed by the fresh VMM spawn.
    let egResume = "";
    await driver.exec(id, `wget -qO- http://127.0.0.1:${EGRESS_PORT}/after-resume`, {}, (e) => {
      if (e.type === "stdout") egResume += e.data;
    });
    assert.match(egResume, /fc-egress-pong/, "egress relay must work after snapshot→resume");
    ok(`★ snapshot fast-pause → resume, no kernel boot (save ${saveMs}ms, resume ${resumeMs}ms); egress relay survives`);

    // Persistence across stop/start (cold path: workspace survives, RAM doesn't).
    console.error("[smoke-fc] stop → start (workspace persistence)…");
    await driver.stop(id);
    const tCold = Date.now();
    await driver.start({ id, image, env: {}, persist: true });
    const coldMs = Date.now() - tCold;
    assert.equal(
      await driver.readFile(id, { path: "/workspace/persist.txt" }),
      "fc-persist-123",
      "workspace persisted across stop/start",
    );
    const markerGone = await driver
      .readFile(id, { path: "/tmp/ram-marker" })
      .then(() => false)
      .catch(() => true);
    assert.ok(markerGone, "tmpfs marker cleared by a cold stop/start (RAM not persisted)");
    ok(`★ workspace.img persists across stop/start (cold boot ${coldMs}ms vs resume ${resumeMs}ms)`);

    await driver.destroy(id);
    ok("destroy");

    // Warm pool (B7): a pre-booted spare is adopted near-instantly, and a
    // snapshot → resume of the ADOPTED VM still works — the no-move symlink
    // adoption keeps Firecracker's recorded boot-time paths valid.
    console.error("[smoke-fc] warm pool…");
    const poolStateDir = mkdtempSync(join(tmpdir(), "sbx-fc-pool-"));
    const pooled = new FirecrackerDriver({
      fcBin: process.env.SBX_FC_BIN ?? "firecracker",
      kernel: process.env.SBX_FC_KERNEL ?? "helpers/sbx-vz/guest/vmlinux-fc",
      rootfs: "helpers/sbx-vz/guest/rootfs.img",
      stateDir: poolStateDir,
      diskGb: 2,
      imageCacheDir: process.env.SBX_FC_IMAGE_CACHE ?? join(homedir(), ".sbx", "fc", "images"),
      warmPool: 1,
      poolImage: image,
    });
    const wid = "fcwarm01";
    try {
      const deadline = Date.now() + 60000;
      while (pooled.poolSize() < 1 && Date.now() < deadline) await sleep(250);
      assert.ok(pooled.poolSize() >= 1, "warm pool failed to pre-boot a spare");
      const tAdopt = Date.now();
      await pooled.create({ id: wid, image, env: {}, persist: true });
      const adoptMs = Date.now() - tAdopt;
      let wout = "";
      await pooled.exec(wid, "echo WARM_OK", {}, (e) => {
        if (e.type === "stdout") wout += e.data;
      });
      assert.match(wout, /WARM_OK/, "adopted microVM must serve exec");
      // Cross-feature: the adopted VM must still snapshot → resume with RAM intact.
      await pooled.exec(wid, "echo warm-ram > /tmp/warm-marker", {}, () => {});
      await pooled.snapshot(wid);
      await pooled.start({ id: wid, image, env: {}, persist: true });
      assert.match(
        await pooled.readFile(wid, { path: "/tmp/warm-marker" }),
        /warm-ram/,
        "adopted VM lost RAM across snapshot→resume (symlink adoption broken?)",
      );
      ok(`★ warm pool: adopt ${adoptMs}ms; adopted VM snapshot→resume keeps RAM`);
    } finally {
      await pooled.destroy(wid).catch(() => {});
      await pooled.drainPool().catch(() => {});
      rmSync(poolStateDir, { recursive: true, force: true });
    }

    console.log(`\nsmoke-fc: ${passed} checks passed (real Firecracker microVM)`);
  } finally {
    await driver.stop(id).catch(() => {});
    await new Promise<void>((r) => gateway.close(() => r()));
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
