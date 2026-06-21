import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { closeSync, createWriteStream, existsSync, ftruncateSync, mkdirSync, openSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { AgentConn } from "./agent.js";
import { UnsupportedDriver } from "./unsupported.js";
import type { CreateOptions, HostInfo, ProcessLiveness, StartProcessResult } from "./types.js";
import type {
  ExecEvent,
  ExecOptions,
  FileInfo,
  ListFilesOptions,
  MkdirOptions,
  ReadFileOptions,
  StartProcessOptions,
  WaitForPortOptions,
  WriteFileOptions,
} from "../types.js";
import { log } from "../logger.js";
import { shellEscape } from "../util.js";

/** Config the driver factory hands the VZ driver (subset of the daemon config). */
export interface VzConfig {
  helperPath: string;
  kernel: string;
  rootfs: string;
  stateDir: string;
  diskGb: number;
}

/** Live per-sandbox VM: the `sbx-vz serve` process + its relay socket + disk. */
interface VmState {
  helper: HelperProcess;
  socketPath: string;
  workspaceImg: string;
  stateDir: string;
}

/**
 * Apple Virtualization.framework microVM driver (macOS). Each sandbox is a real
 * VM: a long-lived signed `sbx-vz serve` helper boots it (rootfs + a persistent
 * `workspace.img` over virtio-blk) and relays a unix socket to the guest's vsock,
 * so the daemon's `AgentConn` speaks the agent wire protocol straight into the
 * guest — the same surface the container driver gets from `docker exec`.
 *
 * Implemented (M1/M2): create/stop/start/destroy lifecycle with workspace
 * persistence, exec, files, waitForPort, ping, hostInfo. Processes, terminal,
 * preview bridge, backups, watch, and stats are later milestones (still
 * `UnsupportedDriver`).
 */
export class AppleVzDriver extends UnsupportedDriver {
  readonly name = "applevz";
  private vms = new Map<string, VmState>();

  constructor(private readonly cfg: VzConfig) {
    super();
  }

  // --- lifecycle ------------------------------------------------------------

  async create(opts: CreateOptions): Promise<void> {
    await this.launch(opts);
    // Best-effort setup commands, mirroring the container driver (non-fatal).
    for (const command of opts.setup ?? []) {
      const code = await this.exec(opts.id, command, {}, () => {}).catch(() => -1);
      if (code === 0) log.info("setup command ok", { sandbox: opts.id, command });
      else log.warn("setup command failed (continuing)", { sandbox: opts.id, command, code });
    }
  }

  async start(opts: CreateOptions): Promise<void> {
    await this.launch(opts);
  }

  /** Spawn the helper, create/keep workspace.img, boot the VM, apply sandbox env. */
  private async launch(opts: CreateOptions): Promise<void> {
    const id = opts.id;
    if (this.vms.has(id)) return; // already running
    const stateDir = join(this.cfg.stateDir, id);
    mkdirSync(stateDir, { recursive: true });
    const workspaceImg = join(stateDir, "workspace.img");
    ensureSparseFile(workspaceImg, this.cfg.diskGb * 1024 ** 3); // guest formats on first boot
    const socketPath = `/tmp/sbx-vz-${id}.sock`; // short, fits sun_path
    try {
      unlinkSync(socketPath);
    } catch {
      /* not there */
    }

    const helper = new HelperProcess(this.cfg.helperPath, join(stateDir, "console.log"));
    this.vms.set(id, { helper, socketPath, workspaceImg, stateDir });

    const cpus = opts.limits?.cpus ? Math.max(1, Math.ceil(opts.limits.cpus)) : 2;
    const memMb = opts.limits?.memoryMb && opts.limits.memoryMb > 0 ? opts.limits.memoryMb : 1024;
    try {
      await helper.rpc("start", {
        kernel: this.cfg.kernel,
        rootfs: this.cfg.rootfs,
        workspace: workspaceImg,
        cpus,
        memMb,
        socketPath,
        vsockPort: 1024,
      });
    } catch (err) {
      helper.kill();
      this.vms.delete(id);
      throw new Error(`applevz: VM start failed: ${(err as Error).message}`);
    }

    // The VM has started, but the guest agent needs a moment to boot + bind vsock.
    await this.waitForAgent(id);

    // Sandbox-level env: applied once on the shared agent so every exec inherits it.
    if (opts.env && Object.keys(opts.env).length) {
      await this.withConn(id, (c) => c.setEnv(opts.env!));
    }
    log.info("applevz VM up", { sandbox: id });
  }

  /** Poll the relay until the in-guest agent answers (Hello), or time out. */
  private async waitForAgent(id: string, timeoutMs = 30000): Promise<void> {
    const vm = this.vms.get(id);
    if (!vm) throw new Error(`applevz: sandbox ${id} not tracked`);
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        const conn = await AgentConn.connect({ path: vm.socketPath, timeoutMs: 2000 });
        conn.close();
        return;
      } catch (err) {
        lastErr = err;
        await sleep(400);
      }
    }
    throw new Error(`applevz: agent never came up for ${id}: ${String((lastErr as Error)?.message ?? lastErr)}`);
  }

  async stop(id: string): Promise<void> {
    const vm = this.vms.get(id);
    if (!vm) return;
    // Flush the guest filesystem to the workspace disk before the abrupt VM
    // teardown — otherwise writes still in the guest page cache are lost, and the
    // workspace wouldn't survive stop/start. Best-effort.
    await this.exec(id, "sync", {}, () => {}).catch(() => {});
    vm.helper.kill(); // killing the helper tears down the VM; workspace.img persists
    this.vms.delete(id);
    try {
      unlinkSync(vm.socketPath);
    } catch {
      /* ignore */
    }
  }

  async destroy(id: string): Promise<void> {
    await this.stop(id);
    try {
      rmSync(join(this.cfg.stateDir, id), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  // --- agent-served ops -----------------------------------------------------

  async exec(id: string, command: string, opts: ExecOptions, onEvent: (e: ExecEvent) => void): Promise<number> {
    return this.withConn(id, (c) => c.exec(command, { cwd: opts.cwd, env: opts.env }, onEvent));
  }

  async writeFile(id: string, opts: WriteFileOptions): Promise<void> {
    return this.withConn(id, (c) => c.writeFile(opts.path, opts.content, opts.mode));
  }

  async readFile(id: string, opts: ReadFileOptions): Promise<string> {
    return this.withConn(id, (c) => c.readFile(opts.path));
  }

  async mkdir(id: string, opts: MkdirOptions): Promise<void> {
    return this.withConn(id, (c) => c.mkdir(opts.path, opts.parents ?? true));
  }

  async listFiles(id: string, opts: ListFilesOptions): Promise<FileInfo[]> {
    return this.withConn(id, (c) => c.listFiles(opts.path));
  }

  async waitForPort(id: string, port: number, opts: WaitForPortOptions): Promise<boolean> {
    return this.withConn(id, (c) =>
      c.waitForPort(port, { host: opts.host, timeoutMs: opts.timeoutMs, intervalMs: opts.intervalMs }),
    );
  }

  // --- background processes (via exec, same shell patterns as the container driver) -

  async startProcess(
    id: string,
    procId: string,
    command: string,
    opts: StartProcessOptions,
  ): Promise<StartProcessResult> {
    const logPath = `/tmp/sbx-proc-${procId}.log`;
    // Background `sh -c CMD` and echo its real pid. No `setsid`: busybox setsid
    // forks when the caller is a process-group leader, making `$!` the wrapper pid
    // rather than the command's. The backgrounded process orphans to PID 1 (the
    // agent) when the launching exec returns, so it survives without setsid; kill
    // then targets the right pid.
    const launch = `sh -c ${shellEscape(command)} > ${shellEscape(logPath)} 2>&1 & echo $!`;
    const { stdout, stderr, exitCode } = await this.execCapture(id, launch, opts);
    const pid = Number.parseInt(stdout.trim(), 10);
    if (exitCode !== 0 || !Number.isFinite(pid)) {
      throw new Error(stderr.trim() || `startProcess failed (exit ${exitCode})`);
    }
    return { procId, pid, logPath };
  }

  async listProcesses(
    id: string,
    procs: Array<{ procId: string; pid: number }>,
  ): Promise<ProcessLiveness[]> {
    if (procs.length === 0) return [];
    const pids = procs.map((p) => p.pid).join(" ");
    // A killed process orphaned to the agent (PID 1) lingers as a zombie since the
    // agent doesn't reap, and `kill -0` succeeds on a zombie. So read the proc state
    // and count only a present, non-`Z` (non-zombie) process as running.
    const cmd =
      `for p in ${pids}; do s=$(sed 's/^.*) //;s/ .*//' /proc/$p/stat 2>/dev/null); ` +
      `if [ -n "$s" ] && [ "$s" != "Z" ]; then echo "$p 1"; else echo "$p 0"; fi; done`;
    const { stdout } = await this.execCapture(id, cmd);
    const alive = new Map<number, boolean>();
    for (const line of stdout.split("\n")) {
      const [p, state] = line.trim().split(" ");
      if (p) alive.set(Number(p), state === "1");
    }
    return procs.map((p) => ({ procId: p.procId, pid: p.pid, running: alive.get(p.pid) ?? false }));
  }

  async killProcess(id: string, pid: number, signal = "TERM"): Promise<void> {
    const stripped = signal.replace(/^SIG/, "");
    const sig = /^[A-Z0-9]+$/.test(stripped) ? stripped : "TERM";
    const cmd = `kill -${sig} -${pid} 2>/dev/null; kill -${sig} ${pid} 2>/dev/null; true`;
    await this.execCapture(id, cmd);
  }

  async streamProcessLogs(
    id: string,
    logPath: string,
    opts: { follow: boolean; signal: AbortSignal },
    onData: (chunk: string) => void,
  ): Promise<void> {
    const vm = this.vms.get(id);
    if (!vm) throw new Error(`applevz: sandbox ${id} is not running`);
    const conn = await AgentConn.connect({ path: vm.socketPath, timeoutMs: 15000 });
    const cmd = opts.follow
      ? `tail -n +1 -F ${shellEscape(logPath)}`
      : `cat ${shellEscape(logPath)}`;
    const onAbort = () => conn.close();
    opts.signal.addEventListener("abort", onAbort);
    try {
      await conn.exec(cmd, {}, (e) => {
        if (e.type !== "exit") onData(e.data);
      });
    } catch {
      /* connection closed on abort */
    } finally {
      opts.signal.removeEventListener("abort", onAbort);
      conn.close();
    }
  }

  /** Run a command and collect its full stdout/stderr/exit (for the process shims). */
  private async execCapture(
    id: string,
    command: string,
    opts: ExecOptions = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    let stdout = "";
    let stderr = "";
    const exitCode = await this.exec(id, command, opts, (e) => {
      if (e.type === "stdout") stdout += e.data;
      else if (e.type === "stderr") stderr += e.data;
    });
    return { stdout, stderr, exitCode };
  }

  /** Open a fresh AgentConn to the sandbox's relay socket, run `fn`, close it. */
  private async withConn<T>(id: string, fn: (c: AgentConn) => Promise<T>): Promise<T> {
    const vm = this.vms.get(id);
    if (!vm) throw new Error(`applevz: sandbox ${id} is not running`);
    const conn = await AgentConn.connect({ path: vm.socketPath, timeoutMs: 15000 });
    try {
      return await fn(conn);
    } finally {
      conn.close();
    }
  }

  // --- host probes (one-shot helper, no VM) ---------------------------------

  async ping(): Promise<void> {
    let res: HelperOneShot;
    try {
      res = await this.oneShot("probe");
    } catch (err) {
      throw new Error(
        `applevz: cannot run the sbx-vz helper at "${this.cfg.helperPath}" (${(err as Error).message}). ` +
          `Build it with 'npm run build:vz', or set SBX_VZ_HELPER_PATH.`,
      );
    }
    const r = res.result as { available?: boolean; reason?: string } | undefined;
    if (!res.ok || !r?.available) {
      throw new Error(`applevz: Virtualization.framework not available: ${r?.reason || res.error || "unknown"}`);
    }
  }

  async hostInfo(): Promise<HostInfo> {
    const res = await this.oneShot("hostInfo");
    if (!res.ok) throw new Error(`applevz hostInfo failed: ${res.error ?? "unknown"}`);
    const r = res.result as { memoryMb?: number; cpus?: number };
    return { memoryMb: Number(r?.memoryMb) || 0, cpus: Number(r?.cpus) || 0 };
  }

  /** One-shot stdio RPC to a throwaway helper process (probe/hostInfo). */
  private oneShot(method: string): Promise<HelperOneShot> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.cfg.helperPath, [], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr.on("data", (d: Buffer) => (err += d.toString()));
      child.on("error", reject);
      child.on("close", () => {
        const line = out.split("\n").find((l) => l.trim());
        if (!line) return reject(new Error(err.trim() || "no response from sbx-vz"));
        try {
          resolve(JSON.parse(line) as HelperOneShot);
        } catch {
          reject(new Error(`bad sbx-vz response: ${line}`));
        }
      });
      child.stdin.write(JSON.stringify({ id: 1, method }) + "\n");
      child.stdin.end();
    });
  }
}

interface HelperOneShot {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Long-lived `sbx-vz serve` process for one sandbox. Drives it over stdio
 * JSON-RPC (`start`/`stop`); the guest console + helper logs go to a console
 * file. RPC replies are matched by id; stdout carries only JSON replies.
 */
class HelperProcess {
  readonly proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buf = "";

  constructor(helperPath: string, consoleLogPath: string) {
    this.proc = spawn(helperPath, ["serve"], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout.on("data", (d: Buffer) => this.feed(d.toString()));
    this.proc.stderr.pipe(createWriteStream(consoleLogPath, { flags: "a" }));
    const fail = (e: Error) => {
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
    };
    this.proc.on("exit", () => fail(new Error("sbx-vz helper exited")));
    this.proc.on("error", (e) => fail(e));
  }

  rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  private feed(s: string): void {
    this.buf += s;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let m: { id?: number; ok?: boolean; result?: unknown; error?: string };
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      const p = m.id != null ? this.pending.get(m.id) : undefined;
      if (!p || m.id == null) continue;
      this.pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(m.error || "sbx-vz helper error"));
    }
  }

  kill(): void {
    try {
      this.proc.kill();
    } catch {
      /* already gone */
    }
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
