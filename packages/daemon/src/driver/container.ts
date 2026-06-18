import Docker from "dockerode";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  ExecEvent,
  ExecOptions,
  FileChangeEvent,
  FileInfo,
  ListFilesOptions,
  MkdirOptions,
  ReadFileOptions,
  StartProcessOptions,
  WaitForPortOptions,
  WatchOptions,
  WriteFileOptions,
} from "../types.js";
import type {
  CreateOptions,
  Driver,
  ProcessLiveness,
  ResourceLimits,
  SandboxStats,
  StartProcessResult,
  TcpBridge,
  TerminalOptions,
  TerminalSession,
} from "./types.js";
import { shellEscape } from "../util.js";

/**
 * Container driver — backs each sandbox with a long-lived OCI container via the
 * Docker Engine API. Maximum density and works identically on Linux and macOS
 * (Docker Desktop / colima / Apple `container`'s Docker-compatible endpoint).
 *
 * The container is named deterministically from the sandbox id and kept alive
 * (`sleep infinity` / image default) so the daemon can `exec` into it on demand
 * — the same model Docker exec gives us for free in Phase 0, standing in for the
 * dedicated in-sandbox agent that the microVM drivers will need.
 */
export class ContainerDriver implements Driver {
  readonly name = "container";
  private docker: Docker;
  private ensured = new Set<string>();

  constructor(docker?: Docker) {
    this.docker = docker ?? new Docker();
  }

  private containerName(id: string): string {
    return `sbx-${id}`;
  }

  /** Deterministic name for the sandbox's persistent workspace volume. */
  private volumeName(id: string): string {
    return `sbx-${id}-workspace`;
  }

  async ping(): Promise<void> {
    await this.docker.ping();
  }

  /** Create the workspace volume if it does not already exist (idempotent). */
  private async ensureVolume(id: string): Promise<void> {
    const name = this.volumeName(id);
    await this.docker.createVolume({
      Name: name,
      Labels: { "sbx.managed": "true", "sbx.id": id },
    });
  }

  /** Pull the image if it is not already present locally. */
  private async ensureImage(image: string): Promise<void> {
    if (this.ensured.has(image)) return;
    const images = await this.docker.listImages({
      filters: { reference: [image] },
    });
    if (images.length === 0) {
      await new Promise<void>((resolve, reject) => {
        this.docker.pull(image, (err: unknown, stream: NodeJS.ReadableStream) => {
          if (err) return reject(err);
          this.docker.modem.followProgress(stream, (doneErr: unknown) =>
            doneErr ? reject(doneErr) : resolve(),
          );
        });
      });
    }
    this.ensured.add(image);
  }

  async create(opts: CreateOptions): Promise<void> {
    await this.launchContainer(opts);
  }

  async start(opts: CreateOptions): Promise<void> {
    try {
      await this.launchContainer(opts);
    } catch (err: unknown) {
      // A 409 means the container already exists (already started) — treat as ok.
      if (!isConflict(err)) throw err;
    }
  }

  async stop(id: string): Promise<void> {
    // Remove the container but keep the workspace volume. With persistence the
    // data survives; without it, stop is effectively a destroy of the rootfs.
    const container = this.docker.getContainer(this.containerName(id));
    try {
      await container.remove({ force: true });
    } catch (err: unknown) {
      if (!isNotFound(err)) throw err;
    }
  }

  /** Shared create/start path: ensure image (+volume), then run the container. */
  private async launchContainer(opts: CreateOptions): Promise<void> {
    await this.ensureImage(opts.image);
    const persist = opts.persist ?? true;
    if (persist) await this.ensureVolume(opts.id);
    const env = Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`);
    const container = await this.docker.createContainer({
      name: this.containerName(opts.id),
      Image: opts.image,
      // Keep the sandbox alive regardless of the image's default CMD.
      Entrypoint: ["/bin/sh", "-c"],
      Cmd: ["sleep infinity"],
      Env: env,
      Labels: { "sbx.managed": "true", "sbx.id": opts.id, ...opts.labels },
      WorkingDir: "/workspace",
      HostConfig: {
        AutoRemove: false,
        // Back /workspace with the named volume so it outlives the container.
        ...(persist ? { Binds: [`${this.volumeName(opts.id)}:/workspace`] } : {}),
        // Hard per-sandbox resource caps (cgroups). Each is omitted when 0/unset.
        ...resourceHostConfig(opts.limits),
      },
    });
    await container.start();
  }

  async exec(
    id: string,
    command: string,
    opts: ExecOptions,
    onEvent: (e: ExecEvent) => void,
  ): Promise<number> {
    const container = this.docker.getContainer(this.containerName(id));
    const exec = await container.exec({
      Cmd: ["/bin/bash", "-lc", command],
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: opts.cwd ?? "/workspace",
      Env: Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`),
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdout.on("data", (chunk: Buffer) =>
      onEvent({ type: "stdout", data: chunk.toString("utf8") }),
    );
    stderr.on("data", (chunk: Buffer) =>
      onEvent({ type: "stderr", data: chunk.toString("utf8") }),
    );
    // Demultiplex Docker's combined stdout/stderr framing.
    this.docker.modem.demuxStream(stream, stdout, stderr);

    await new Promise<void>((resolve, reject) => {
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    stdout.end();
    stderr.end();

    const info = await exec.inspect();
    const exitCode = info.ExitCode ?? 0;
    onEvent({ type: "exit", exitCode });
    return exitCode;
  }

  /**
   * Run a non-interactive command and capture its streams + exit code. Never
   * throws on a non-zero exit — callers decide what a failure means.
   */
  private async execCapture(
    id: string,
    command: string,
    opts: { cwd?: string; env?: Record<string, string> } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const container = this.docker.getContainer(this.containerName(id));
    const exec = await container.exec({
      Cmd: ["/bin/bash", "-c", command],
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: opts.cwd ?? "/workspace",
      Env: Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`),
    });

    const stream = await exec.start({ hijack: true, stdin: false });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let out = "";
    let err = "";
    stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    this.docker.modem.demuxStream(stream, stdout, stderr);

    await new Promise<void>((resolve, reject) => {
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    stdout.end();
    stderr.end();

    const info = await exec.inspect();
    return { stdout: out, stderr: err, exitCode: info.ExitCode ?? 0 };
  }

  /**
   * Run a non-interactive command and return its stdout as a UTF-8 string.
   * Throws if the command exits non-zero.
   */
  private async runAndCapture(id: string, command: string): Promise<string> {
    const { stdout, stderr, exitCode } = await this.execCapture(id, command);
    if (exitCode !== 0) {
      throw new Error(stderr.trim() || `command failed with exit code ${exitCode}`);
    }
    return stdout;
  }

  async writeFile(id: string, opts: WriteFileOptions): Promise<void> {
    if (opts.mode !== undefined && !/^[0-7]{3,4}$/.test(opts.mode)) {
      throw new Error(`invalid file mode: ${opts.mode}`);
    }
    const dir = opts.path.includes("/")
      ? opts.path.slice(0, opts.path.lastIndexOf("/"))
      : "/workspace";
    const encoded = Buffer.from(opts.content, "utf8").toString("base64");
    // `mode` is validated above to be octal digits only, so it's safe unquoted.
    const mode = opts.mode ? `chmod ${opts.mode} ${shellEscape(opts.path)} && ` : "";
    const command = `mkdir -p ${shellEscape(dir)} && printf '%s' '${encoded}' | base64 -d > ${shellEscape(opts.path)} && ${mode}echo ok`;
    const output = await this.runAndCapture(id, command);
    if (output.trim() !== "ok") {
      throw new Error(`writeFile failed: ${output}`);
    }
  }

  async readFile(id: string, opts: ReadFileOptions): Promise<string> {
    return this.runAndCapture(id, `cat ${shellEscape(opts.path)}`);
  }

  async mkdir(id: string, opts: MkdirOptions): Promise<void> {
    const flag = opts.parents ? "-p" : "";
    await this.runAndCapture(id, `mkdir ${flag} ${shellEscape(opts.path)}`);
  }

  async listFiles(id: string, opts: ListFilesOptions): Promise<FileInfo[]> {
    const container = this.docker.getContainer(this.containerName(id));
    const exec = await container.exec({
      Cmd: [
        "/bin/sh",
        "-c",
        `find ${shellEscape(opts.path)} -maxdepth 1 -printf '%y|%p|%s|%TY-%Tm-%TdT%TH:%TM:%TS\\n'`,
      ],
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: "/workspace",
    });

    const stream = await exec.start({ hijack: true, stdin: false });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let out = "";
    let err = "";
    stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    this.docker.modem.demuxStream(stream, stdout, stderr);

    await new Promise<void>((resolve, reject) => {
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    stdout.end();
    stderr.end();

    const info = await exec.inspect();
    if ((info.ExitCode ?? 0) !== 0) {
      throw new Error(`listFiles failed: ${err || "unknown error"}`);
    }

    const lines = out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    return lines.map((line) => {
      const [type, rawPath, size, mtime] = line.split("|");
      const path = rawPath!;
      const name = path.slice(path.lastIndexOf("/") + 1);
      return {
        path,
        name,
        isDirectory: type === "d",
        size: Number(size ?? 0),
        modifiedAt: mtime ?? new Date().toISOString(),
      };
    });
  }

  async watchFiles(
    id: string,
    path: string,
    opts: WatchOptions & { signal: AbortSignal },
    onEvent: (e: FileChangeEvent) => void,
  ): Promise<void> {
    const intervalSec = ((opts.intervalMs ?? 1000) / 1000).toFixed(3);
    const container = this.docker.getContainer(this.containerName(id));
    // A portable poll-based watcher in python3 (guaranteed in the base image);
    // avoids depending on inotify-tools. Emits `<type>\t<path>` lines.
    const cmd = `python3 -u -c ${shellEscape(WATCHER_PY)} ${shellEscape(path)} ${intervalSec}`;
    const exec = await container.exec({
      Cmd: ["/bin/sh", "-c", cmd],
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });

    const stream = await exec.start({ hijack: true, stdin: false });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stderr.resume();
    let buffer = "";
    stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const tab = line.indexOf("\t");
        if (tab === -1) continue;
        const type = line.slice(0, tab);
        if (type === "created" || type === "modified" || type === "deleted") {
          onEvent({ type, path: line.slice(tab + 1) });
        }
      }
    });
    this.docker.modem.demuxStream(stream, stdout, stderr);

    const onAbort = () => {
      (stream as unknown as { destroy?: () => void }).destroy?.();
    };
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });

    try {
      await new Promise<void>((resolve) => {
        stream.on("end", resolve);
        stream.on("close", resolve);
        stream.on("error", () => resolve());
      });
    } finally {
      opts.signal.removeEventListener("abort", onAbort);
      stdout.end();
      stderr.end();
    }
  }

  async startProcess(
    id: string,
    procId: string,
    command: string,
    opts: StartProcessOptions,
  ): Promise<StartProcessResult> {
    const logPath = `/tmp/sbx-proc-${procId}.log`;
    // `setsid` gives the process its own session + group (pgid == its pid), so we
    // can later signal the whole tree, and it survives the exec that launched it.
    // The inner `bash -lc` runs the user command with a login PATH like `exec`.
    const launch = `setsid bash -lc ${shellEscape(command)} > ${shellEscape(logPath)} 2>&1 & echo $!`;
    const { stdout, stderr, exitCode } = await this.execCapture(id, launch, {
      cwd: opts.cwd,
      env: opts.env,
    });
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
    // Emit `<pid> 1` if alive, `<pid> 0` otherwise.
    const pids = procs.map((p) => p.pid).join(" ");
    const cmd = `for p in ${pids}; do if kill -0 "$p" 2>/dev/null; then echo "$p 1"; else echo "$p 0"; fi; done`;
    const { stdout } = await this.execCapture(id, cmd);
    const alive = new Map<number, boolean>();
    for (const line of stdout.split("\n")) {
      const [p, state] = line.trim().split(" ");
      if (p) alive.set(Number(p), state === "1");
    }
    return procs.map((p) => ({
      procId: p.procId,
      pid: p.pid,
      running: alive.get(p.pid) ?? false,
    }));
  }

  async killProcess(id: string, pid: number, signal = "TERM"): Promise<void> {
    const stripped = signal.replace(/^SIG/, "");
    // Whitelist signal names/numbers; anything else (incl. shell metacharacters)
    // falls back to TERM so a crafted `signal` can't inject into the kill command.
    const sig = /^[A-Z0-9]+$/.test(stripped) ? stripped : "TERM";
    // Signal the process group first (pid == pgid via setsid), then the pid.
    const cmd = `kill -${sig} -${pid} 2>/dev/null; kill -${sig} ${pid} 2>/dev/null; true`;
    await this.execCapture(id, cmd);
  }

  async streamProcessLogs(
    id: string,
    logPath: string,
    opts: { follow: boolean; signal: AbortSignal },
    onData: (chunk: string) => void,
  ): Promise<void> {
    const container = this.docker.getContainer(this.containerName(id));
    // `-F` tolerates the logfile not existing yet (it waits for it).
    const cmd = opts.follow
      ? `tail -n +1 -F ${shellEscape(logPath)}`
      : `cat ${shellEscape(logPath)}`;
    const exec = await container.exec({
      Cmd: ["/bin/sh", "-c", cmd],
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({ hijack: true, stdin: false });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdout.on("data", (chunk: Buffer) => onData(chunk.toString("utf8")));
    stderr.on("data", (chunk: Buffer) => onData(chunk.toString("utf8")));
    this.docker.modem.demuxStream(stream, stdout, stderr);

    const onAbort = () => {
      (stream as unknown as { destroy?: () => void }).destroy?.();
    };
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });

    try {
      await new Promise<void>((resolve) => {
        stream.on("end", resolve);
        stream.on("close", resolve);
        stream.on("error", () => resolve());
      });
    } finally {
      opts.signal.removeEventListener("abort", onAbort);
      stdout.end();
      stderr.end();
    }
  }

  async waitForPort(
    id: string,
    port: number,
    opts: WaitForPortOptions,
  ): Promise<boolean> {
    const host = opts.host ?? "127.0.0.1";
    assertHost(host);
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const intervalSec = ((opts.intervalMs ?? 250) / 1000).toFixed(3);
    // bash `/dev/tcp` probe loop with a millisecond deadline.
    const cmd =
      `deadline=$(( $(date +%s%3N) + ${timeoutMs} )); ` +
      `while true; do ` +
      `if (exec 3<>/dev/tcp/${host}/${port}) 2>/dev/null; then exit 0; fi; ` +
      `if [ "$(date +%s%3N)" -ge "$deadline" ]; then exit 1; fi; ` +
      `sleep ${intervalSec}; ` +
      `done`;
    const { exitCode } = await this.execCapture(id, cmd);
    return exitCode === 0;
  }

  async openTcpBridge(id: string, port: number, host: string): Promise<TcpBridge> {
    assertHost(host);
    const container = this.docker.getContainer(this.containerName(id));
    // Relay raw bytes to the in-container port. socat is binary-safe and handles
    // half-close cleanly; fall back to a bash /dev/tcp bridge when socat is
    // absent (default slim image). We run WITHOUT a TTY (Tty:false) so no pty
    // line discipline can cook the bytes — the response is demultiplexed below
    // to strip Docker's 8-byte stream frames, leaving a clean byte stream.
    const relay =
      `if command -v socat >/dev/null 2>&1; then ` +
      `exec socat - TCP:${host}:${port}; ` +
      `else exec bash -c 'exec 3<>/dev/tcp/${host}/${port}; cat <&3 & cat >&3; wait'; fi`;
    const exec = await container.exec({
      Cmd: ["/bin/sh", "-c", relay],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    const hijacked = await exec.start({ hijack: true, stdin: true });

    // Demux the multiplexed output into a clean readable; drain stderr.
    const outbound = new PassThrough();
    const errSink = new PassThrough();
    errSink.resume();
    this.docker.modem.demuxStream(hijacked, outbound, errSink);

    // Present a single duplex: writes -> exec stdin, reads <- demuxed stdout.
    const writable = hijacked as unknown as NodeJS.WritableStream;
    const stream = Duplex.from({ readable: outbound, writable });
    return {
      stream,
      close() {
        (hijacked as unknown as { destroy?: () => void }).destroy?.();
        outbound.destroy();
      },
    };
  }

  async openTerminal(id: string, opts: TerminalOptions): Promise<TerminalSession> {
    const container = this.docker.getContainer(this.containerName(id));
    // A real PTY: Tty:true makes Docker allocate a pseudo-terminal, so the output
    // is raw (no 8-byte stream framing) and line discipline / control chars work.
    // Prefer an interactive login bash, falling back to sh on minimal images.
    const exec = await container.exec({
      Cmd: [
        "/bin/sh",
        "-c",
        "if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi",
      ],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      WorkingDir: opts.cwd ?? "/workspace",
      Env: Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`),
    });
    const stream = (await exec.start({
      hijack: true,
      stdin: true,
      // Tell dockerode this is a TTY stream so it doesn't try to demux frames.
      Tty: true,
    } as Docker.ExecStartOptions)) as unknown as NodeJS.ReadWriteStream;

    if (opts.cols && opts.rows) {
      await exec.resize({ w: opts.cols, h: opts.rows }).catch(() => {});
    }
    return {
      stream,
      resize(cols: number, rows: number) {
        exec.resize({ w: cols, h: rows }).catch(() => {});
      },
      close() {
        (stream as unknown as { destroy?: () => void }).destroy?.();
      },
    };
  }

  async createBackup(id: string, tarPath: string): Promise<{ bytes: number }> {
    const container = this.docker.getContainer(this.containerName(id));
    // getArchive streams a tar of the path's contents (entries rooted at
    // `workspace/...`) straight from the container fs over the Docker socket.
    const stream = (await container.getArchive({
      path: "/workspace",
    })) as NodeJS.ReadableStream;
    await mkdir(dirname(tarPath), { recursive: true });
    let bytes = 0;
    stream.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
    });
    await pipeline(stream, createWriteStream(tarPath));
    return { bytes };
  }

  async restoreBackup(id: string, tarPath: string): Promise<void> {
    // Clear the existing workspace so the restore is a replacement, not a merge.
    await this.execCapture(
      id,
      "find /workspace -mindepth 1 -maxdepth 1 -exec rm -rf {} +",
    );
    const container = this.docker.getContainer(this.containerName(id));
    // The tar entries are rooted at `workspace/`, so extract at `/`.
    await container.putArchive(createReadStream(tarPath), { path: "/" });
  }

  async stats(id: string): Promise<SandboxStats> {
    const container = this.docker.getContainer(this.containerName(id));
    // `stream:false` makes the daemon take two samples ~1s apart and populate
    // `precpu_stats`, so the CPU% delta is correct from a single call (a
    // `one-shot` read would leave precpu zero and inflate CPU%). Depending on the
    // dockerode version this resolves either to a parsed object or a one-shot
    // stream, so handle both.
    const result: unknown = await container.stats({ stream: false });
    const raw = isReadable(result)
      ? await collectJson(result)
      : result;
    return normalizeStats(raw);
  }

  async destroy(id: string): Promise<void> {
    const container = this.docker.getContainer(this.containerName(id));
    try {
      await container.remove({ force: true });
    } catch (err: unknown) {
      // Already gone is fine; rethrow anything else.
      if (!isNotFound(err)) throw err;
    }
    // Drop the persistent volume too — destroy is irreversible.
    try {
      await this.docker.getVolume(this.volumeName(id)).remove({ force: true });
    } catch (err: unknown) {
      if (!isNotFound(err)) throw err;
    }
  }
}

/** Duck-type check for a Node readable stream. */
function isReadable(value: unknown): value is NodeJS.ReadableStream {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { pipe?: unknown }).pipe === "function"
  );
}

/** Read a readable stream to completion and JSON.parse its contents. */
async function collectJson(stream: NodeJS.ReadableStream): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8").trim() || "{}");
}

/** Normalize Docker's raw stats JSON into our cross-driver SandboxStats shape. */
function normalizeStats(s: any): SandboxStats {
  const cpu = s.cpu_stats ?? {};
  const precpu = s.precpu_stats ?? {};
  const cpuDelta = (cpu.cpu_usage?.total_usage ?? 0) - (precpu.cpu_usage?.total_usage ?? 0);
  const systemDelta = (cpu.system_cpu_usage ?? 0) - (precpu.system_cpu_usage ?? 0);
  const onlineCpus =
    cpu.online_cpus || cpu.cpu_usage?.percpu_usage?.length || 1;
  let cpuPercent = 0;
  if (systemDelta > 0 && cpuDelta > 0) {
    cpuPercent = (cpuDelta / systemDelta) * onlineCpus * 100;
  }

  const mem = s.memory_stats ?? {};
  // Exclude reclaimable page cache where the runtime breaks it out (cgroup v2
  // reports `inactive_file`; v1 reports `cache`).
  const cache = mem.stats?.inactive_file ?? mem.stats?.cache ?? 0;
  const memBytes = Math.max(0, (mem.usage ?? 0) - cache);

  let netRxBytes = 0;
  let netTxBytes = 0;
  for (const net of Object.values(s.networks ?? {}) as any[]) {
    netRxBytes += net.rx_bytes ?? 0;
    netTxBytes += net.tx_bytes ?? 0;
  }

  return {
    cpuPercent,
    cpuTotalUsageNs: cpu.cpu_usage?.total_usage ?? 0,
    onlineCpus,
    memBytes,
    memLimitBytes: mem.limit ?? 0,
    netRxBytes,
    netTxBytes,
    pids: s.pids_stats?.current ?? 0,
    sampledAt: new Date().toISOString(),
  };
}

function isNotFound(err: unknown): boolean {
  return statusCode(err) === 404;
}

function isConflict(err: unknown): boolean {
  return statusCode(err) === 409;
}

function statusCode(err: unknown): number | undefined {
  return typeof err === "object" && err !== null && "statusCode" in err
    ? (err as { statusCode?: number }).statusCode
    : undefined;
}

/**
 * Translate sandbox resource limits into Docker `HostConfig` cgroup fields.
 * Omits any limit that's 0/undefined so it stays unlimited. `cpus` → `NanoCpus`
 * (1 core = 1e9), `memoryMb` → `Memory` bytes, `pidsLimit` → `PidsLimit`.
 */
function resourceHostConfig(limits?: ResourceLimits): {
  Memory?: number;
  NanoCpus?: number;
  PidsLimit?: number;
} {
  const cfg: { Memory?: number; NanoCpus?: number; PidsLimit?: number } = {};
  if (limits?.memoryMb && limits.memoryMb > 0) {
    cfg.Memory = Math.round(limits.memoryMb * 1024 * 1024);
  }
  if (limits?.cpus && limits.cpus > 0) {
    cfg.NanoCpus = Math.round(limits.cpus * 1e9);
  }
  if (limits?.pidsLimit && limits.pidsLimit > 0) {
    cfg.PidsLimit = Math.round(limits.pidsLimit);
  }
  return cfg;
}

/**
 * Reject a host that isn't a plain IP/hostname before it's interpolated into a
 * `/dev/tcp/<host>/...` redirect or `socat TCP:<host>` arg, where shell quoting
 * is awkward. Allows letters, digits, `.`, `-`, `_`, and `:` (IPv6) only.
 */
function assertHost(host: string): void {
  if (!/^[A-Za-z0-9._:-]+$/.test(host)) {
    throw new Error(`invalid host: ${host}`);
  }
}

/**
 * Poll-based recursive file watcher (python3, no inotify dependency). Snapshots
 * mtimes under argv[1] every argv[2] seconds and prints `<type>\t<path>` lines
 * for created/modified/deleted files. Contains no single quotes so it survives
 * single-quote shell escaping.
 */
const WATCHER_PY = [
  "import os,sys,time",
  "path=sys.argv[1]; interval=float(sys.argv[2])",
  "def snap():",
  "    s={}",
  "    for root,_,files in os.walk(path):",
  "        for n in files:",
  "            p=os.path.join(root,n)",
  "            try: s[p]=os.path.getmtime(p)",
  "            except OSError: pass",
  "    return s",
  "prev=snap()",
  "while True:",
  "    time.sleep(interval)",
  "    cur=snap()",
  '    for p in cur:',
  '        if p not in prev: print("created\\t"+p,flush=True)',
  '        elif cur[p]!=prev[p]: print("modified\\t"+p,flush=True)',
  '    for p in prev:',
  '        if p not in cur: print("deleted\\t"+p,flush=True)',
  "    prev=cur",
].join("\n");
