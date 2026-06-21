/**
 * Apple VZ driver M1 end-to-end check. Drives the real `AppleVzDriver` (which
 * boots a microVM via the signed sbx-vz helper and talks to the in-guest agent
 * over the relayed vsock) through the full lifecycle, including the headline M1
 * gate: a file written to /workspace survives stop→start. Run on a Mac with the
 * helper + guest artifacts built: `npm run check:applevz`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppleVzDriver } from "./driver/applevz.js";

async function main(): Promise<void> {
  const stateDir = mkdtempSync(join(tmpdir(), "sbx-vz-state-"));
  const driver = new AppleVzDriver({
    helperPath: "helpers/sbx-vz/dist/sbx-vz",
    kernel: "helpers/sbx-vz/guest/vmlinux-vz",
    rootfs: "helpers/sbx-vz/guest/rootfs.img",
    stateDir,
    diskGb: 2,
  });
  const id = "vzcheck01";
  let passed = 0;
  const ok = (l: string) => {
    passed++;
    console.log(`  ✓ ${l}`);
  };

  try {
    await driver.ping();
    ok("ping — Virtualization.framework available");

    console.error("[check] booting microVM (create)…");
    await driver.create({ id, image: "base", env: { SBX_TEST: "vz-ok" }, persist: true });
    ok("create — VM booted and agent reachable over vsock");

    let out = "";
    const code = await driver.exec(id, "echo hello-from-vm && uname -sm", {}, (e) => {
      if (e.type === "stdout") out += e.data;
    });
    assert.equal(code, 0, "exec exit code");
    assert.match(out, /hello-from-vm/, "exec stdout");
    assert.match(out, /Linux aarch64/, "running inside a real arm64 Linux VM");
    ok(`exec inside the VM — ${out.trim().replace(/\n/g, " | ")}`);

    let envOut = "";
    await driver.exec(id, "echo $SBX_TEST", {}, (e) => {
      if (e.type === "stdout") envOut += e.data;
    });
    assert.match(envOut, /vz-ok/, "sandbox env applied to exec");
    ok("sandbox env applied");

    await driver.writeFile(id, { path: "/workspace/persist.txt", content: "persist-me-123" });
    assert.equal(await driver.readFile(id, { path: "/workspace/persist.txt" }), "persist-me-123");
    ok("writeFile + readFile in /workspace");

    const files = await driver.listFiles(id, { path: "/workspace" });
    assert.ok(files.some((f) => f.name === "persist.txt"), "listFiles sees the file");
    ok("listFiles /workspace");

    // ★ The M1 gate: persistence across a stop/start cycle.
    console.error("[check] stop → start (workspace persistence)…");
    await driver.stop(id);
    await driver.start({ id, image: "base", env: {}, persist: true });
    assert.equal(
      await driver.readFile(id, { path: "/workspace/persist.txt" }),
      "persist-me-123",
      "file persisted across stop/start",
    );
    ok("★ workspace.img persists across stop/start");

    await driver.destroy(id);
    ok("destroy");

    console.log(`\napplevz-check: ${passed} checks passed`);
  } finally {
    await driver.stop(id).catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("applevz-check FAILED:", err);
    process.exit(1);
  },
);
