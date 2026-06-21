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
import { setTimeout as sleep } from "node:timers/promises";
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

    // M4a: background processes (start → list running → logs → kill → list dead).
    const proc = await driver.startProcess(
      id,
      "p1",
      "i=0; while true; do echo tick-$i; i=$((i+1)); sleep 0.2; done",
      {},
    );
    assert.ok(Number.isFinite(proc.pid), "startProcess returns a pid");
    await sleep(700);
    const live = await driver.listProcesses(id, [{ procId: "p1", pid: proc.pid }]);
    assert.ok(live[0]?.running, "process is running");
    let logs = "";
    await driver.streamProcessLogs(id, proc.logPath, { follow: false, signal: new AbortController().signal }, (d) => {
      logs += d;
    });
    assert.match(logs, /tick-/, "process logs captured");
    await driver.killProcess(id, proc.pid);
    await sleep(400);
    const dead = await driver.listProcesses(id, [{ procId: "p1", pid: proc.pid }]);
    assert.ok(!dead[0]?.running, "process killed");
    ok("background process: start → running → logs → kill → dead");

    // M4b: preview-URL TCP bridge — a busybox `nc` loop serves a fixed HTTP
    // response; fetch it through the bridge.
    await driver.startProcess(
      id,
      "srv",
      "while true; do printf 'HTTP/1.0 200 OK\\r\\n\\r\\nbridge-works' | nc -l -p 9100 2>/dev/null; done",
      {},
    );
    await sleep(900);
    const bridge = await driver.openTcpBridge(id, 9100, "127.0.0.1");
    const resp = await new Promise<string>((resolve) => {
      let buf = "";
      bridge.stream.on("data", (d: Buffer) => (buf += d.toString()));
      bridge.stream.on("end", () => resolve(buf));
      bridge.stream.on("error", () => resolve(buf));
      setTimeout(() => resolve(buf), 2500);
    });
    bridge.close();
    assert.match(resp, /bridge-works/, "HTTP response flows through the bridge");
    ok("preview TCP bridge: HTTP round-trips through the guest");

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
