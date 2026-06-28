/**
 * Apple VZ parity smoke. Boots an in-process daemon backed by the **Apple VZ
 * microVM driver** (`SBX_DRIVER=applevz`) and drives the full sandbox surface
 * through the daemon's HTTP/SSE stack via the public TypeScript SDK — the same
 * `npm run smoke` exercises against the container driver. This is the plan's
 * parity gate: the *same* end-to-end flow must work on both drivers, proving the
 * driver abstraction holds from REST → SSE → SDK down to a real microVM.
 *
 * Unlike `applevz-check.ts` (which calls the driver directly), this goes through
 * the daemon server, the preview proxy, and the SDK — so it covers the
 * integration the direct check doesn't. Needs a Mac with the VZ helper + guest
 * artifacts built (`npm run build:vz`, `build:agent`, `build-guest.sh`).
 *
 * Usage: npm run smoke:vz
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { BackupRegistry } from "./backups.js";
import { Capacity } from "./capacity.js";
import { loadConfig } from "./config.js";
import { DriverRouter } from "./driver/router.js";
import { MetricsHistory } from "./metrics.js";
import { SandboxStore } from "./store.js";
import { createApiServer } from "./api/server.js";
import { createProxyServer } from "./proxy/server.js";
import { SbxClient, type Sandbox } from "@sbx/sdk";

async function main(): Promise<number> {
  // Force the VZ driver + isolated ports/state so the run leaves nothing behind
  // and never collides with a dev daemon on the default ports.
  process.env.SBX_DRIVER = "applevz";
  const config = loadConfig();
  config.driver = "applevz";
  config.port = 4790;
  config.proxyPort = 4791;
  config.backupDir = await mkdtemp(join(tmpdir(), "sbx-vz-backups-"));
  const dbDir = await mkdtemp(join(tmpdir(), "sbx-vz-db-"));
  config.dbPath = join(dbDir, "state.db");
  config.vzStateDir = await mkdtemp(join(tmpdir(), "sbx-vz-state-"));
  config.vzImageCacheDir = join(homedir(), ".sbx", "vz", "images"); // stable cache

  const store = new SandboxStore(config.dbPath);
  const driver = new DriverRouter(config, store, config.driver);
  const backups = new BackupRegistry(config.backupDir);
  const history = new MetricsHistory(config.metricsHistory);
  const capacity = new Capacity(store, config, null, history);

  const server = createApiServer({ config, driver, store, backups, history, capacity });
  await new Promise<void>((r) => server.listen(config.port, config.host, r));
  const proxy = createProxyServer({ config, driver, store });
  await new Promise<void>((r) => proxy.listen(config.proxyPort, config.proxyHost, r));
  const endpoint = `http://${config.host}:${config.port}`;
  const proxyEndpoint = `http://${config.proxyHost}:${config.proxyPort}`;
  const client = new SbxClient({ endpoint });

  let passed = 0;
  const ok = (l: string) => {
    passed++;
    console.error(`  ✓ ${l}`);
  };
  const assert = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(msg);
  };

  let sandbox: Sandbox | undefined;
  try {
    // 1. Health + info: the daemon reports the VZ driver.
    const health = await client.health();
    assert(health.ok, "daemon health not ok");
    const info = await client.info();
    assert(info.driver === "applevz", `expected driver=applevz, got ${info.driver}`);
    ok(`daemon up on the applevz driver (${endpoint})`);

    // 2. Create a microVM sandbox (Alpine base — fast, no image conversion).
    sandbox = await client.getSandbox(undefined, { image: "base" });
    ok(`created microVM sandbox ${sandbox.id}`);

    // 3. exec streams stdout/exit over SSE and runs in a real arm64 Linux VM.
    const uname = await sandbox.exec("echo hi-from-vm && uname -sm");
    assert(uname.exitCode === 0, `exec exit ${uname.exitCode}`);
    assert(/hi-from-vm/.test(uname.stdout), "exec stdout missing");
    assert(/Linux aarch64/.test(uname.stdout), "not a real arm64 Linux VM");
    ok(`exec over SSE → ${uname.stdout.trim().replace(/\n/g, " | ")}`);

    // 4. Files: write/read/mkdir/list through REST.
    await sandbox.writeFile("/workspace/hello.txt", "vz-files");
    assert((await sandbox.readFile("/workspace/hello.txt")) === "vz-files", "readFile mismatch");
    await sandbox.mkdir("/workspace/sub");
    const files = await sandbox.listFiles("/workspace");
    assert(files.some((f) => f.name === "hello.txt"), "listFiles missing file");
    assert(files.some((f) => f.name === "sub" && f.isDirectory), "listFiles missing dir");
    ok("files: write / read / mkdir / list");

    // 5. Sandbox env + session cwd persistence.
    await sandbox.setEnvVars({ SBX_VZ_SMOKE: "env-ok" });
    const envOut = await sandbox.exec("echo $SBX_VZ_SMOKE");
    assert(/env-ok/.test(envOut.stdout), "sandbox env not applied");
    const session = await sandbox.createSession({ cwd: "/workspace/sub" });
    await session.exec("echo cwd-marker > here.txt");
    const cwdRead = await sandbox.readFile("/workspace/sub/here.txt");
    assert(/cwd-marker/.test(cwdRead), "session cwd not honored");
    ok("env applied + session cwd persists");

    // 6. Background process + port readiness + preview proxy fetch.
    const proc = await sandbox.startProcess(
      "while true; do printf 'HTTP/1.0 200 OK\\r\\n\\r\\nvz-preview-ok' | nc -l -p 9000 2>/dev/null; done",
    );
    assert(Number.isFinite(proc.pid), "startProcess returned no pid");
    const ready = await sandbox.waitForPort(9000, { timeoutMs: 8000 });
    assert(ready, "port 9000 never became ready");
    await sandbox.exposePort(9000);
    const preview = await fetch(`${proxyEndpoint}/_sbx/${sandbox.id}/9000/`);
    const previewBody = await preview.text();
    assert(/vz-preview-ok/.test(previewBody), `preview proxy did not serve: ${previewBody.slice(0, 60)}`);
    ok("background process → waitForPort → preview proxy round-trip");

    // 7. watch: open the stream, create a file, see the event. The SDK watch is
    //    an async generator; calling return() closes the underlying SSE stream.
    const watchGen = sandbox.watch("/workspace", { intervalMs: 200 });
    let sawWatch = false;
    const watching = (async () => {
      for await (const ev of watchGen) {
        if (/watched\.txt/.test(ev.path)) {
          sawWatch = true;
          break;
        }
      }
    })().catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    await sandbox.writeFile("/workspace/watched.txt", "x");
    for (let i = 0; i < 30 && !sawWatch; i++) await new Promise((r) => setTimeout(r, 100));
    await watchGen.return(undefined); // unblock + close the stream if still pending
    await watching;
    assert(sawWatch, "watch never reported the new file");
    ok("watch streamed a create event");

    // 8. Backup → mutate → restore → rollback.
    await sandbox.writeFile("/workspace/keep.txt", "in-backup");
    const backup = await sandbox.createBackup();
    await sandbox.writeFile("/workspace/keep.txt", "MUTATED");
    await sandbox.restoreBackup(backup.backupId);
    assert((await sandbox.readFile("/workspace/keep.txt")) === "in-backup", "restore did not roll back");
    ok("backup → mutate → restore → rollback");

    // 9. Metrics: the sampler/stats path reports usage through the daemon.
    const metrics = await sandbox.metrics();
    assert(metrics.live ? metrics.live.memBytes > 0 : true, "live metrics memBytes should be > 0");
    ok(`metrics endpoint served (live mem ${metrics.live ? (metrics.live.memBytes / 1e6).toFixed(0) + "MB" : "n/a"})`);

    // 10. Persistence across stop/start (cold resume; workspace survives).
    await sandbox.stop();
    await sandbox.start();
    assert((await sandbox.readFile("/workspace/keep.txt")) === "in-backup", "workspace lost across stop/start");
    ok("workspace persists across stop/start");

    console.error(`\n[smoke-vz] passed — ${passed} checks (full surface on the applevz driver)`);
    return 0;
  } catch (err) {
    console.error(`[smoke-vz] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    if (sandbox) await sandbox.destroy().catch(() => {});
    await new Promise<void>((r) => proxy.close(() => r()));
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    await rm(config.backupDir, { recursive: true, force: true }).catch(() => {});
    await rm(dbDir, { recursive: true, force: true }).catch(() => {});
    await rm(config.vzStateDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().then((code) => process.exit(code));
