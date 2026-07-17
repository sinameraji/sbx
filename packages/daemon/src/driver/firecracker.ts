import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer, connect as netConnect } from "node:net";
import {
  closeSync,
  createWriteStream,
  existsSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  rmSync,
  symlinkSync,
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
  /** Warm-pool size: keep N pre-booted spare microVMs for instant adoption (0 = off). */
  warmPool?: number;
  /** Image the warm pool pre-boots (a plain create of this image adopts a spare). */
  poolImage?: string;
  /**
   * Egress gateway port for the guest relay (0/unset = no relay). The guest gets
   * a loopback listener on this port whose connections tunnel over vsock to the
   * host and on to `egressHost:egressPort` — the NIC-less guest's only way out.
   */
  egressPort?: number;
  /** Host the egress gateway listens on (default 127.0.0.1). */
  egressHost?: string;
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
  private pool: FcVm[] = [];
  private poolTarget: number;
  private poolSeq = 0;
  private filling = false;
  private readonly poolImage: string;
  private readonly poolDir: string;

  constructor(private readonly cfg: FcConfig) {
    super();
    // The OCI→ext4 converter + staged guest files live under `helpers/hotcell-vz`
    // (shared with the VZ driver: same rootfs artifact, same agent-as-init).
    const vzDir = join(dirname(dirname(cfg.rootfs)));
    this.images = new VzImageCache({
      vzDir: vzDir.endsWith("guest") ? dirname(vzDir) : "helpers/hotcell-vz",
      cacheDir: cfg.imageCacheDir,
      prebuiltRootfs: cfg.rootfs,
      // Convert OCI images for the host arch (the guest runs on this KVM host).
      platform: cfg.platform ?? (process.arch === "arm64" ? "linux/arm64" : "linux/amd64"),
    });
    this.poolTarget = Math.max(0, cfg.warmPool ?? 0);
    this.poolImage = cfg.poolImage ?? "base";
    this.poolDir = join(cfg.stateDir, "_pool");
    if (this.poolTarget > 0) {
      // Clear stale slots from a previous run (their VMMs died with the daemon).
      try {
        rmSync(this.poolDir, { recursive: true, force: true });
      } catch {
        /* not there */
      }
      this.fillPool();
    }
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

  /** Bring a sandbox live: adopt a warm-pool spare when eligible (instant), else
   *  resume its snapshot, else cold-boot. Then apply the sandbox env. */
  private async launch(opts: CreateOptions): Promise<void> {
    const id = opts.id;
    if (this.vms.has(id)) return;
    const stateDir = join(this.cfg.stateDir, id);

    // Warm-pool adoption — must run before the canonical dir is created, since
    // adoption makes that path a symlink to the spare's slot dir.
    if (this.tryAdopt(opts)) {
      if (opts.env && Object.keys(opts.env).length) {
        await this.withConn(id, (c) => c.setEnv(opts.env!));
      }
      log.info("firecracker VM up", { sandbox: id, warm: true });
      return;
    }

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

    const vm = await this.bootMicroVm({ id, stateDir, image: opts.image, limits: opts.limits });
    this.vms.set(id, vm);
    try {
      if (opts.env && Object.keys(opts.env).length) {
        await this.withConn(id, (c) => c.setEnv(opts.env!));
      }
    } catch (err) {
      this.vms.delete(id);
      await killAndWait(vm.proc);
      throw err;
    }
    log.info("firecracker VM up", { sandbox: id });
  }

  /**
   * Cold-boot a microVM in `stateDir` and wait for its in-guest agent, returning
   * the live FcVm. Shared by the launch path and the warm-pool filler. Does not
   * touch `this.vms` or apply sandbox env — the caller owns those.
   */
  private async bootMicroVm(p: {
    id: string;
    stateDir: string;
    image: string;
    limits?: CreateOptions["limits"];
  }): Promise<FcVm> {
    mkdirSync(p.stateDir, { recursive: true });
    const rootfs = await this.images.ensureRootfs(p.image);

    // First boot only: give the sandbox its own workspace disk (clone the blank
    // pre-formatted template; else a sparse file the guest formats).
    const workspaceImg = join(p.stateDir, "workspace.img");
    if (!existsSync(workspaceImg)) {
      let blank: string | null = null;
      try {
        blank = await this.images.ensureBlankWorkspace(this.cfg.diskGb);
      } catch (err) {
        log.warn("blank workspace build failed; guest will format a sparse disk", {
          sandbox: p.id,
          error: (err as Error).message,
        });
      }
      if (blank) cloneFile(blank, workspaceImg);
      else ensureSparseFile(workspaceImg, this.cfg.diskGb * 1024 ** 3);
    }

    const cpus = p.limits?.cpus ? Math.max(1, Math.ceil(p.limits.cpus)) : 2;
    const memMib = p.limits?.memoryMb && p.limits.memoryMb > 0 ? p.limits.memoryMb : 1024;
    const pidsMax = p.limits?.pidsLimit && p.limits.pidsLimit > 0 ? p.limits.pidsLimit : 0;
    const bootArgs = pidsMax > 0 ? `${FC_DEFAULT_BOOT_ARGS} hotcell.pids=${pidsMax} sbx.pids=${pidsMax}` : FC_DEFAULT_BOOT_ARGS;

    const configureAndBoot = async (): Promise<FcVm> => {
      const vm = await this.spawnVmm(p.stateDir);
      try {
        const api = new FcApi(vm.apiSock);
        await api.applyAll(
          buildFcApiCalls({
            kernelPath: this.cfg.kernel,
            rootfsPath: rootfs,
            workspacePath: workspaceImg,
            vcpus: cpus,
            memMib,
            vsockUds: vm.vsockUds,
            bootArgs,
          }),
        );
        await api.call(FC_START_ACTION);
        return vm;
      } catch (err) {
        await killAndWait(vm.proc);
        throw err;
      }
    };
    const vm = await this.withOneRetry(p.id, configureAndBoot, "boot");
    try {
      await this.waitForAgent(vm);
      // Cold boots need the in-guest side of the egress relay started (after a
      // snapshot resume it's already alive in the restored RAM).
      if (this.cfg.egressPort && this.cfg.egressPort > 0) {
        const { socket, leftover } = await fcVsockConnect(vm.vsockUds, AGENT_VSOCK_PORT, 15000);
        const conn = await AgentConn.attach(socket, leftover, 15000);
        try {
          await conn.egressListen(this.cfg.egressPort);
        } finally {
          conn.close();
        }
      }
    } catch (err) {
      await killAndWait(vm.proc);
      throw err;
    }
    return vm;
  }

  // --- warm pool --------------------------------------------------------------

  /** Spares currently ready for adoption (used by checks). */
  poolSize(): number {
    return this.pool.length;
  }

  /**
   * Adopt a pre-booted spare for `opts` when eligible — a plain create of the
   * pool image with default limits and no prior state. Adoption moves nothing:
   * the canonical state dir becomes a **symlink** to the spare's slot dir, so
   * every path the daemon joins under it resolves correctly while the absolute
   * slot paths Firecracker recorded at boot (drives, vsock UDS) stay real — which
   * keeps a later `snapshot()`/restore of the adopted VM loadable (`/snapshot/load`
   * re-opens the boot-time paths embedded in the vmstate).
   */
  private tryAdopt(opts: CreateOptions): boolean {
    if (this.poolTarget <= 0) return false;
    const noLimits =
      !opts.limits || (!opts.limits.memoryMb && !opts.limits.cpus && !opts.limits.pidsLimit);
    const canonical = join(this.cfg.stateDir, opts.id);
    if (opts.image !== this.poolImage || !noLimits || existsSync(canonical)) return false;

    const spare = this.pool.shift();
    if (!spare) {
      this.fillPool(); // none ready — warm up for next time
      return false;
    }
    mkdirSync(dirname(canonical), { recursive: true });
    symlinkSync(spare.stateDir, canonical);
    this.vms.set(opts.id, spare);
    this.fillPool(); // replenish in the background
    log.info("firecracker adopted a warm-pool microVM", { sandbox: opts.id });
    return true;
  }

  /** Top the pool up to its target in the background (one filler at a time). */
  private fillPool(): void {
    if (this.poolTarget <= 0 || this.filling) return;
    void this.doFill();
  }

  private async doFill(): Promise<void> {
    this.filling = true;
    try {
      while (this.pool.length < this.poolTarget) {
        const n = ++this.poolSeq;
        try {
          const vm = await this.bootMicroVm({
            id: `pool-${n}`,
            stateDir: join(this.poolDir, `slot-${n}`),
            image: this.poolImage,
          });
          this.pool.push(vm);
          log.info("warm pool: spare microVM ready", { size: this.pool.length, target: this.poolTarget });
        } catch (err) {
          log.warn("warm pool: spare boot failed (will retry on next claim)", {
            error: (err as Error).message,
          });
          break; // don't hot-loop on a persistent failure
        }
      }
    } finally {
      this.filling = false;
    }
  }

  /** Tear down all spare microVMs (e.g. on daemon shutdown). Idempotent. */
  async drainPool(): Promise<void> {
    this.poolTarget = 0;
    const spares = this.pool.splice(0);
    for (const vm of spares) await killAndWait(vm.proc);
    try {
      rmSync(this.poolDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  /** Spawn a fresh VMM process for `stateDir` and wait for its API socket. */
  private async spawnVmm(stateDir: string): Promise<FcVm> {
    const apiSock = join(stateDir, "fc-api.sock");
    const vsockUds = join(stateDir, "vsock.sock");
    for (const s of [apiSock, vsockUds]) rmQuiet(s);
    const proc = spawn(this.cfg.fcBin, ["--api-sock", apiSock], { stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout.pipe(createWriteStream(join(stateDir, "console.log"), { flags: "a" }));
    proc.stderr.pipe(createWriteStream(join(stateDir, "console.log"), { flags: "a" }));
    const vm: FcVm = { proc, apiSock, vsockUds, workspaceImg: join(stateDir, "workspace.img"), stateDir };
    this.startEgressRelay(vm);
    try {
      await waitForFile(apiSock, 5000); // firecracker creates the API socket on startup
    } catch (err) {
      await killAndWait(proc);
      throw err;
    }
    return vm;
  }

  /**
   * Host side of the guest egress relay. When the guest dials vsock port P,
   * firecracker connects to the unix socket `<vsockUds>_P` — so we listen there
   * and splice every such connection to the egress gateway. Set up per-VMM
   * (boot, snapshot-load, and pool spares alike) before the guest can dial;
   * torn down automatically with the VMM process.
   */
  private startEgressRelay(vm: FcVm): void {
    const port = this.cfg.egressPort;
    if (!port || port <= 0) return;
    const path = `${vm.vsockUds}_${port}`;
    rmQuiet(path);
    const srv = createNetServer((guest) => {
      const up = netConnect(port, this.cfg.egressHost ?? "127.0.0.1");
      const close = (): void => {
        guest.destroy();
        up.destroy();
      };
      guest.pipe(up);
      up.pipe(guest);
      guest.on("error", close);
      up.on("error", close);
      guest.on("close", close);
      up.on("close", close);
    });
    srv.on("error", (err) =>
      log.warn("egress relay listener error", { path, error: String(err) }),
    );
    srv.listen(path);
    vm.proc.once("exit", () => {
      srv.close();
      rmQuiet(path);
    });
  }

  /**
   * Run a VMM bring-up step, retrying once on a fresh process. Rationale: a VMM
   * spawned immediately after the previous one's SIGKILL can die silently before
   * serving its API (a transient KVM/VMM teardown race seen on nested-virt
   * hosts, ~ECONNRESET mid-configure); a single respawn reliably clears it.
   */
  private async withOneRetry<T>(id: string, step: () => Promise<T>, what: string): Promise<T> {
    try {
      return await step();
    } catch (err) {
      log.warn(`firecracker ${what} failed; retrying once on a fresh VMM`, {
        sandbox: id,
        error: (err as Error).message,
      });
      try {
        return await step();
      } catch (err2) {
        throw new Error(`firecracker: VM ${what} failed: ${(err2 as Error).message}`);
      }
    }
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

  /** Boot a fresh VMM and load the saved snapshot into it (no kernel boot). The
   *  snapshot pins the vsock UDS path; firecracker re-binds it on load (stale
   *  socket files are cleared by `spawnVmm`). */
  private async resumeFromSnapshot(
    id: string,
    stateDir: string,
    vmstate: string,
    memFile: string,
  ): Promise<void> {
    const loadSnapshot = async (): Promise<FcVm> => {
      const vm = await this.spawnVmm(stateDir);
      try {
        await new FcApi(vm.apiSock).call(buildSnapshotLoadCall(vmstate, memFile));
        return vm;
      } catch (err) {
        await killAndWait(vm.proc);
        throw err;
      }
    };
    const vm = await this.withOneRetry(id, loadSnapshot, "snapshot load");

    this.vms.set(id, vm);
    try {
      await this.waitForAgent(vm);
    } catch (err) {
      this.vms.delete(id);
      await killAndWait(vm.proc);
      throw err;
    }
    // One-shot: guest state diverges the moment the VM resumes, so a second load
    // from these files would resurrect a stale past. Unlinking is safe — the VMM
    // maps the memory file privately (copy-on-write).
    for (const f of [vmstate, memFile]) rmQuiet(f);
  }

  /** A live VM can always be snapshot-paused (KVM snapshots have no OS gate). */
  canSnapshot(id: string): boolean {
    return this.vms.has(id);
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
    this.vms.delete(id);
    await killAndWait(vm.proc); // state saved; free the compute
    for (const s of [vm.apiSock, vm.vsockUds]) rmQuiet(s);
  }

  async stop(id: string): Promise<void> {
    const vm = this.vms.get(id);
    if (!vm) return;
    // Flush the guest fs so workspace writes survive the abrupt teardown.
    await this.exec(id, "sync", {}, () => {}).catch(() => {});
    this.vms.delete(id);
    await killAndWait(vm.proc); // tears down the microVM; workspace.img persists
    for (const s of [vm.apiSock, vm.vsockUds]) rmQuiet(s);
  }

  async destroy(id: string): Promise<void> {
    await this.stop(id);
    const canonical = join(this.cfg.stateDir, id);
    try {
      // An adopted sandbox's canonical dir is a symlink to its warm-pool slot:
      // remove the real slot dir first, then the link itself.
      if (lstatSync(canonical).isSymbolicLink()) {
        rmSync(readlinkSync(canonical), { recursive: true, force: true });
        unlinkSync(canonical);
      } else {
        rmSync(canonical, { recursive: true, force: true });
      }
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

/** SIGKILL a VMM and wait until the process has actually exited, so the next
 *  spawn never overlaps the previous VM's kernel-side teardown. */
function killAndWait(proc: ChildProcess, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    const timer = setTimeout(resolve, timeoutMs);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    proc.kill("SIGKILL");
  });
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
