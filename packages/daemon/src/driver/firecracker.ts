import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  createWriteStream,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { totalmem, cpus as osCpus } from "node:os";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { AgentConn } from "./agent.js";
import { AgentDriver } from "./agent-driver.js";
import {
  buildFcApiCalls,
  buildSnapshotCreateCall,
  buildSnapshotLoadCall,
  FC_DEFAULT_BOOT_ARGS,
  FC_PAUSE_VM,
  FC_START_ACTION,
  FcApi,
  fcVsockConnect,
} from "./fc-api.js";
import { VzImageCache } from "./vz-image.js";
import type { CreateOptions, HostInfo } from "./types.js";
import { log } from "../logger.js";

/** Config the driver factory hands the Firecracker driver (subset of daemon config). */
export interface FcConfig {
  /** Path to the `firecracker` binary. */
  fcBin: string;
  /** Guest Linux kernel (uncompressed vmlinux, per-arch). */
  kernel: string;
  /** Prebuilt base rootfs (ext4 with the agent as PID 1) for the sentinel images. */
  rootfs: string;
  /** Per-sandbox VM state dir (disks, sockets). */
  stateDir: string;
  /** Initial sparse size of a new workspace disk, in GiB. */
  diskGb: number;
  /** Cache dir for OCI→ext4 converted rootfs images + the blank workspace template. */
  imageCacheDir: string;
  /** Target platform for OCI→ext4 conversion (default matches the host arch). */
  platform?: string;
}

/** Live per-sandbox microVM: the `firecracker` process + its API + vsock sockets. */
interface FcVm {
  proc: ChildProcess;
  apiSock: string;
  vsockUds: string;
  workspaceImg: string;
  stateDir: string;
}

const AGENT_VSOCK_PORT = 1024; // the in-guest agent listens here (matches VZ)

/**
 * Firecracker microVM driver (Linux, KVM). Each sandbox is a Firecracker microVM:
 * the driver spawns `firecracker`, configures it over its HTTP-API-over-unix-socket
 * (boot source / machine-config / drives / vsock), boots it, and reaches the
 * in-guest `sbx-agent` over virtio-vsock — the **same agent and wire protocol the
 * Apple VZ driver uses**, so the entire agent-served surface (exec/files/processes/
 * ports/terminal/stats/backup) is inherited from {@link AgentDriver} unchanged.
 *
 * **Host requirement:** `/dev/kvm` + the `firecracker` binary. All the code here is
 * host-agnostic and compiles/unit-tests anywhere (see `check:fc`); only the live
 * boot needs a KVM (or nested-virt) Linux host, gated behind `smoke:fc`.
 */
export class FirecrackerDriver extends AgentDriver {
  readonly name = "firecracker";
  private vms = new Map<string, FcVm>();
  private images: VzImageCache;

  constructor(private readonly cfg: FcConfig) {
    super();
    // The OCI→ext4 converter + staged guest files live under `helpers/sbx-vz`
    // (shared with the VZ driver: same rootfs artifact, same agent-as-init).
    const vzDir = join(dirname(dirname(cfg.rootfs)));
    this.images = new VzImageCache({
      vzDir: vzDir.endsWith("guest") ? dirname(vzDir) : "helpers/sbx-vz",
      cacheDir: cfg.imageCacheDir,
      prebuiltRootfs: cfg.rootfs,
      // Convert OCI images for the host arch (the guest runs on this KVM host).
      platform: cfg.platform ?? (process.arch === "arm64" ? "linux/arm64" : "linux/amd64"),
    });
  }

  // --- lifecycle ------------------------------------------------------------

  async create(opts: CreateOptions): Promise<void> {
    await this.launch(opts);
    for (const command of opts.setup ?? []) {
      const code = await this.exec(opts.id, command, {}, () => {}).catch(() => -1);
      if (code === 0) log.info("setup command ok", { sandbox: opts.id, command });
      else log.warn("setup command failed (continuing)", { sandbox: opts.id, command, code });
    }
  }

  async start(opts: CreateOptions): Promise<void> {
    await this.launch(opts);
  }

  /** Spawn firecracker, configure + boot the microVM, wait for the agent, apply env. */
  private async launch(opts: CreateOptions): Promise<void> {
    const id = opts.id;
    if (this.vms.has(id)) return;
    const stateDir = join(this.cfg.stateDir, id);
    mkdirSync(stateDir, { recursive: true });

    // If a snapshot exists from a fast-pause, resume from it (guest RAM + device
    // state restored — no kernel boot; background processes come back live).
    const vmstate = join(stateDir, "snapshot.vmstate");
    const memFile = join(stateDir, "snapshot.mem");
    if (existsSync(vmstate) && existsSync(memFile)) {
      try {
        await this.resumeFromSnapshot(id, stateDir, vmstate, memFile);
        log.info("firecracker VM resumed from snapshot", { sandbox: id });
        return;
      } catch (err) {
        // A snapshot that won't load must never brick the sandbox: discard it and
        // cold-boot (workspace intact — `snapshot()` synced the guest fs first;
        // only live RAM/process state is lost).
        log.warn("snapshot restore failed; discarding it and cold-booting", {
          sandbox: id,
          error: (err as Error).message,
        });
        for (const f of [vmstate, memFile]) rmQuiet(f);
      }
    }

    const rootfs = await this.images.ensureRootfs(opts.image);

    // First boot only: give the sandbox its own workspace disk (clone the blank
    // pre-formatted template; else a sparse file the guest formats).
    const workspaceImg = join(stateDir, "workspace.img");
    if (!existsSync(workspaceImg)) {
      let blank: string | null = null;
      try {
        blank = await this.images.ensureBlankWorkspace(this.cfg.diskGb);
      } catch (err) {
        log.warn("blank workspace build failed; guest will format a sparse disk", {
          sandbox: id,
          error: (err as Error).message,
        });
      }
      if (blank) cloneFile(blank, workspaceImg);
      else ensureSparseFile(workspaceImg, this.cfg.diskGb * 1024 ** 3);
    }

    const apiSock = join(stateDir, "fc-api.sock");
    const vsockUds = join(stateDir, "vsock.sock");
    for (const s of [apiSock, vsockUds]) {
      try {
        unlinkSync(s);
      } catch {
        /* not there */
      }
    }

    // Spawn the VMM. It creates the API socket, then waits for configuration.
    const proc = spawn(this.cfg.fcBin, ["--api-sock", apiSock], { stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout.pipe(createWriteStream(join(stateDir, "console.log"), { flags: "a" }));
    proc.stderr.pipe(createWriteStream(join(stateDir, "console.log"), { flags: "a" }));
    const vm: FcVm = { proc, apiSock, vsockUds, workspaceImg, stateDir };
    this.vms.set(id, vm);

    try {
      await waitForFile(apiSock, 5000); // firecracker creates the API socket on startup
      const api = new FcApi(apiSock);

      const cpus = opts.limits?.cpus ? Math.max(1, Math.ceil(opts.limits.cpus)) : 2;
      const memMib = opts.limits?.memoryMb && opts.limits.memoryMb > 0 ? opts.limits.memoryMb : 1024;
      const pidsMax = opts.limits?.pidsLimit && opts.limits.pidsLimit > 0 ? opts.limits.pidsLimit : 0;
      const bootArgs = pidsMax > 0 ? `${FC_DEFAULT_BOOT_ARGS} sbx.pids=${pidsMax}` : FC_DEFAULT_BOOT_ARGS;

      await api.applyAll(
        buildFcApiCalls({
          kernelPath: this.cfg.kernel,
          rootfsPath: rootfs,
          workspacePath: workspaceImg,
          vcpus: cpus,
          memMib,
          vsockUds,
          bootArgs,
        }),
      );
      await api.call(FC_START_ACTION);
    } catch (err) {
      proc.kill("SIGKILL");
      this.vms.delete(id);
      throw new Error(`firecracker: VM start failed: ${(err as Error).message}`);
    }

    await this.waitForAgent(vm);

    if (opts.env && Object.keys(opts.env).length) {
      await this.withConn(id, (c) => c.setEnv(opts.env!));
    }
    log.info("firecracker VM up", { sandbox: id });
  }

  /** Poll the guest vsock until the agent answers its Hello, or time out. */
  private async waitForAgent(vm: FcVm, timeoutMs = 30000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      if (vm.proc.exitCode !== null) {
        throw new Error(`firecracker exited (code ${vm.proc.exitCode}) before the agent came up`);
      }
      try {
        const { socket, leftover } = await fcVsockConnect(vm.vsockUds, AGENT_VSOCK_PORT, 2000);
        const conn = await AgentConn.attach(socket, leftover, 2000);
        conn.close();
        return;
      } catch (err) {
        lastErr = err;
        await sleep(400);
      }
    }
    throw new Error(`firecracker: agent never came up: ${String((lastErr as Error)?.message ?? lastErr)}`);
  }

  /** Boot a fresh VMM and load the saved snapshot into it (no kernel boot). */
  private async resumeFromSnapshot(
    id: string,
    stateDir: string,
    vmstate: string,
    memFile: string,
  ): Promise<void> {
    const apiSock = join(stateDir, "fc-api.sock");
    const vsockUds = join(stateDir, "vsock.sock");
    // The snapshot pins the vsock UDS path; firecracker re-binds it on load, so
    // stale socket files must be gone first.
    for (const s of [apiSock, vsockUds]) rmQuiet(s);
    const proc = spawn(this.cfg.fcBin, ["--api-sock", apiSock], { stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout.pipe(createWriteStream(join(stateDir, "console.log"), { flags: "a" }));
    proc.stderr.pipe(createWriteStream(join(stateDir, "console.log"), { flags: "a" }));
    const vm: FcVm = { proc, apiSock, vsockUds, workspaceImg: join(stateDir, "workspace.img"), stateDir };
    this.vms.set(id, vm);
    try {
      await waitForFile(apiSock, 5000);
      await new FcApi(apiSock).call(buildSnapshotLoadCall(vmstate, memFile));
      await this.waitForAgent(vm);
    } catch (err) {
      proc.kill("SIGKILL");
      this.vms.delete(id);
      throw err;
    }
    // One-shot: guest state diverges the moment the VM resumes, so a second load
    // from these files would resurrect a stale past. Unlinking is safe — the VMM
    // maps the memory file privately (copy-on-write).
    for (const f of [vmstate, memFile]) rmQuiet(f);
  }

  /**
   * Fast-pause (B7): pause the vCPUs, write a Full Firecracker snapshot (device
   * state + guest RAM) into the sandbox's state dir, and tear the VMM down. The
   * next `start` resumes from it **without a kernel boot** — background
   * processes/servers come back live. Same contract as the VZ driver's
   * `snapshot()`: the guest fs is synced first, so if the later restore has to
   * fall back to a cold boot the workspace is still intact.
   */
  async snapshot(id: string): Promise<void> {
    const vm = this.vms.get(id);
    if (!vm) throw new Error(`firecracker: sandbox ${id} is not running`);
    await this.exec(id, "sync", {}, () => {}).catch(() => {});
    const api = new FcApi(vm.apiSock);
    await api.call(FC_PAUSE_VM);
    await api.call(
      buildSnapshotCreateCall(join(vm.stateDir, "snapshot.vmstate"), join(vm.stateDir, "snapshot.mem")),
    );
    vm.proc.kill("SIGKILL"); // state saved; free the compute
    this.vms.delete(id);
    for (const s of [vm.apiSock, vm.vsockUds]) rmQuiet(s);
  }

  async stop(id: string): Promise<void> {
    const vm = this.vms.get(id);
    if (!vm) return;
    // Flush the guest fs so workspace writes survive the abrupt teardown.
    await this.exec(id, "sync", {}, () => {}).catch(() => {});
    vm.proc.kill("SIGKILL"); // tears down the microVM; workspace.img persists
    this.vms.delete(id);
    for (const s of [vm.apiSock, vm.vsockUds]) rmQuiet(s);
  }

  async destroy(id: string): Promise<void> {
    await this.stop(id);
    try {
      rmSync(join(this.cfg.stateDir, id), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  // --- agent transport ------------------------------------------------------

  /** Open a fresh AgentConn to the guest over Firecracker's vsock UDS (CONNECT
   *  handshake → the live socket carries the agent wire protocol). */
  protected async openConn(id: string): Promise<AgentConn> {
    const vm = this.vms.get(id);
    if (!vm) throw new Error(`firecracker: sandbox ${id} is not running`);
    const { socket, leftover } = await fcVsockConnect(vm.vsockUds, AGENT_VSOCK_PORT, 15000);
    return AgentConn.attach(socket, leftover, 15000);
  }

  // --- host probes ----------------------------------------------------------

  async ping(): Promise<void> {
    if (!existsSync("/dev/kvm")) {
      throw new Error(
        "firecracker: /dev/kvm not present — needs a Linux host with KVM (bare metal " +
          "or a nested-virtualization VM, e.g. GCE N2/C3). Use SBX_DRIVER=container otherwise.",
      );
    }
    try {
      execFileSync(this.cfg.fcBin, ["--version"], { stdio: "ignore" });
    } catch (err) {
      throw new Error(
        `firecracker: cannot run "${this.cfg.fcBin}" (${(err as Error).message}). ` +
          "Install firecracker or set SBX_FC_BIN.",
      );
    }
  }

  async hostInfo(): Promise<HostInfo> {
    // Prefer /proc on Linux; fall back to the os module elsewhere (e.g. building
    // on a Mac, where this driver can't actually boot but should still report).
    let memoryMb = Math.round(totalmem() / (1024 * 1024));
    try {
      const meminfo = readFileSync("/proc/meminfo", "utf8");
      const m = /MemTotal:\s+(\d+)\s+kB/.exec(meminfo);
      if (m) memoryMb = Math.round(Number(m[1]) / 1024);
    } catch {
      /* not Linux; use totalmem() */
    }
    return { memoryMb, cpus: osCpus().length };
  }
}

/** Remove a file, ignoring a missing one. */
function rmQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* not there */
  }
}

/** Copy `src`→`dst`, preferring a CoW reflink (btrfs/xfs) and falling back to a
 *  plain sparse-aware copy. Gives each sandbox its own workspace disk cheaply. */
function cloneFile(src: string, dst: string): void {
  try {
    execFileSync("cp", ["--reflink=auto", src, dst]);
  } catch {
    execFileSync("cp", [src, dst]);
  }
}

/** Create a sparse file of `sizeBytes` if it doesn't exist (workspace disk). */
function ensureSparseFile(path: string, sizeBytes: number): void {
  if (existsSync(path)) return;
  const fd = openSync(path, "w");
  try {
    ftruncateSync(fd, sizeBytes);
  } finally {
    closeSync(fd);
  }
}

/** Resolve once `path` exists, polling, or reject after `timeoutMs`. */
async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${path}`);
}
