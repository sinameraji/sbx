/**
 * Apple VZ driver M1 end-to-end check. Drives the real `AppleVzDriver` (which
 * boots a microVM via the signed sbx-vz helper and talks to the in-guest agent
 * over the relayed vsock) through the full lifecycle, including the headline M1
 * gate: a file written to /workspace survives stop→start. Run on a Mac with the
 * helper + guest artifacts built: `npm run check:applevz`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
    // Stable cache so converted images + the blank workspace survive across runs.
    imageCacheDir: join(homedir(), ".sbx", "vz", "images"),
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

    // M4c: interactive PTY terminal — type a command into a real shell, read it back.
    const term = await driver.openTerminal(id, { cols: 80, rows: 24 });
    const termOut = await new Promise<string>((resolve) => {
      let buf = "";
      term.stream.on("data", (d: Buffer) => {
        buf += d.toString();
        if (/TERMINAL_OK_42/.test(buf)) resolve(buf);
      });
      term.stream.on("error", () => resolve(buf));
      setTimeout(() => term.stream.write("echo TERMINAL_OK_$((6*7))\n"), 500);
      setTimeout(() => resolve(buf), 3500);
    });
    term.close();
    assert.match(termOut, /TERMINAL_OK_42/, "PTY runs the command in a real shell");
    ok("interactive PTY: command runs in a real shell");

    // M5: stats from the guest /proc + cgroup (via the agent).
    const stats = await driver.stats(id);
    assert.ok(stats.onlineCpus >= 1, "stats reports online CPUs");
    assert.ok(stats.memBytes > 0, "stats reports resident memory");
    assert.ok(stats.pids > 0, "stats reports running pids");
    ok(
      `stats: ${stats.onlineCpus} cpu / ${(stats.memBytes / 1e6).toFixed(0)}MB / ${stats.pids} pids`,
    );

    // M3: watch — open the stream, create a file, assert the event arrives.
    const watchAbort = new AbortController();
    const events: string[] = [];
    const watching = driver.watchFiles(
      id,
      "/workspace",
      { intervalMs: 200, signal: watchAbort.signal },
      (e) => events.push(`${e.type}:${e.path}`),
    );
    await sleep(400); // let the watcher take its baseline snapshot
    await driver.writeFile(id, { path: "/workspace/watched.txt", content: "hi" });
    for (let i = 0; i < 30 && !events.some((e) => /watched\.txt/.test(e)); i++) await sleep(100);
    watchAbort.abort();
    await watching;
    assert.ok(events.some((e) => /watched\.txt/.test(e)), "watch saw the new file");
    ok(`watch: ${events.find((e) => /watched\.txt/.test(e))}`);

    // M5: backup → mutate → restore → rollback round-trip.
    const backupPath = join(stateDir, "backup.tar");
    await driver.writeFile(id, { path: "/workspace/keep.txt", content: "in-backup" });
    const { bytes } = await driver.createBackup(id, backupPath);
    assert.ok(bytes > 0, "backup wrote bytes");
    await driver.writeFile(id, { path: "/workspace/keep.txt", content: "MUTATED" });
    await driver.writeFile(id, { path: "/workspace/extra.txt", content: "added-after-backup" });
    await driver.restoreBackup(id, backupPath);
    assert.equal(
      await driver.readFile(id, { path: "/workspace/keep.txt" }),
      "in-backup",
      "restore rolled the mutation back",
    );
    const filesAfter = await driver.listFiles(id, { path: "/workspace" });
    assert.ok(
      !filesAfter.some((f) => f.name === "extra.txt"),
      "restore cleared files added after the backup",
    );
    ok("★ backup → mutate → restore → rollback");

    await driver.destroy(id);
    ok("destroy");

    // M6b-1: two sandboxes booting the same read-only base rootfs concurrently,
    // each writing to its own workspace — proves the shared base is safe.
    const ca = "vzconcur-a";
    const cb = "vzconcur-b";
    try {
      await Promise.all([
        driver.create({ id: ca, image: "base", persist: true }),
        driver.create({ id: cb, image: "base", persist: true }),
      ]);
      await Promise.all([
        driver.writeFile(ca, { path: "/workspace/who.txt", content: "alpha" }),
        driver.writeFile(cb, { path: "/workspace/who.txt", content: "beta" }),
      ]);
      const [ra, rb] = await Promise.all([
        driver.readFile(ca, { path: "/workspace/who.txt" }),
        driver.readFile(cb, { path: "/workspace/who.txt" }),
      ]);
      assert.equal(ra, "alpha", "sandbox A workspace isolated");
      assert.equal(rb, "beta", "sandbox B workspace isolated");
      ok("two concurrent VMs share the read-only base, isolated workspaces");
    } finally {
      await Promise.all([driver.destroy(ca).catch(() => {}), driver.destroy(cb).catch(() => {})]);
    }

    // M6a: resource limits — a second VM capped at 256 MiB / 1 cpu / 64 pids.
    // Memory + CPU are hard VM caps; pidsLimit is enforced by a guest cgroup.
    const lid = "vzcheck02";
    try {
      await driver.create({
        id: lid,
        image: "base",
        persist: true,
        limits: { memoryMb: 256, cpus: 1, pidsLimit: 64 },
      });
      const read = async (cmd: string): Promise<string> => {
        let o = "";
        await driver.exec(lid, cmd, {}, (e) => {
          if (e.type === "stdout") o += e.data;
        });
        return o.trim();
      };
      const memKb = Number(await read("grep MemTotal /proc/meminfo | awk '{print $2}'"));
      assert.ok(memKb > 0 && memKb <= 256 * 1024, `guest MemTotal ${memKb}KB within the 256 MiB cap`);
      const nproc = Number(await read("nproc"));
      assert.equal(nproc, 1, "guest sees exactly 1 online CPU");
      const pidsMax = await read("cat /sys/fs/cgroup/sandbox/pids.max 2>/dev/null");
      assert.equal(pidsMax, "64", "guest pids cgroup capped at 64");
      ok(`resource limits: ${(memKb / 1024) | 0}MB mem / ${nproc} cpu / pids.max=${pidsMax}`);
    } finally {
      await driver.destroy(lid).catch(() => {});
    }

    // M7a: snapshot/resume. VZ saveMachineStateTo saves the full VM state (RAM +
    // devices); a later start() restores it (instant resume, no kernel boot),
    // falling back to a cold boot if restore is unsupported. Disk state always
    // survives; an in-RAM (tmpfs) marker survives only a true restore.
    const snapId = "vzsnap01";
    try {
      await driver.create({ id: snapId, image: "base", persist: true });
      await driver.writeFile(snapId, { path: "/workspace/disk.txt", content: "on-disk" });
      await driver.exec(snapId, "echo SNAPSHOT_RAM_OK > /run/marker", {}, () => {}); // /run = tmpfs
      await driver.snapshot(snapId); // pause + saveMachineStateTo + tear down
      ok("snapshot saved (VZ saveMachineStateTo)");
      const tResume = Date.now();
      await driver.start({ id: snapId, image: "base", persist: true }); // restore (or cold-fallback)
      const resumeMs = Date.now() - tResume;
      assert.equal(
        await driver.readFile(snapId, { path: "/workspace/disk.txt" }),
        "on-disk",
        "workspace survives resume",
      );
      let ram = "";
      await driver.exec(snapId, "cat /run/marker 2>/dev/null", {}, (e) => {
        if (e.type === "stdout") ram += e.data;
      });
      assert.match(
        ram,
        /SNAPSHOT_RAM_OK/,
        "in-RAM tmpfs marker lost — restore silently fell back to a cold boot",
      );
      ok(`★ instant restore: in-RAM state resumed in ${resumeMs}ms (no cold boot)`);
    } finally {
      await driver.destroy(snapId).catch(() => {});
    }

    // M6b-2: honor SBX_IMAGE — convert a real OCI image and run its own python.
    const pyId = "vzpython01";
    try {
      console.error("[check] converting python:3.11-slim → VZ rootfs (first run pulls + builds)…");
      await driver.create({ id: pyId, image: "python:3.11-slim", persist: true });
      let pyOut = "";
      const pc = await driver.exec(pyId, "python3 --version && echo IMG_OK", {}, (e) => {
        if (e.type === "stdout") pyOut += e.data;
      });
      assert.equal(pc, 0, "python3 exec exit code");
      assert.match(pyOut, /Python 3\.11/, "the converted image runs its own python3");
      assert.match(pyOut, /IMG_OK/, "exec works in the converted image");
      ok(`SBX_IMAGE honored: ${pyOut.trim().split("\n")[0]}`);
    } finally {
      await driver.destroy(pyId).catch(() => {});
    }

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
