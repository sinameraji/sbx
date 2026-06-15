import Docker from "dockerode";
import { Duplex, PassThrough } from "node:stream";
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
import type {
  CreateOptions,
  Driver,
  ProcessLiveness,
  StartProcessResult,
  TcpBridge,
} from "./types.js";

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
        // Phase 0 single-tenant defaults. Per-sandbox cgroup limits and egress
        // controls land alongside the scheduler in Phase 1/3.
        AutoRemove: false,
        // Back /workspace with the named volume so it outlives the container.
        ...(persist ? { Binds: [`${this.volumeName(opts.id)}:/workspace`] } : {}),
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
    const dir = opts.path.includes("/")
      ? opts.path.slice(0, opts.path.lastIndexOf("/"))
      : "/workspace";
    const encoded = Buffer.from(opts.content, "utf8").toString("base64");
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
    const sig = signal.replace(/^SIG/, "");
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

function shellEscape(value: string): string {
  // Use single quotes and escape any embedded single quotes.
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}
