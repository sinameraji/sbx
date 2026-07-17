import { createReadStream, createWriteStream } from "node:fs";
import type { AgentConn } from "./agent.js";
import { UnsupportedDriver } from "./unsupported.js";
import type {
  ProcessLiveness,
  SandboxStats,
  StartProcessResult,
  TcpBridge,
  TerminalOptions,
  TerminalSession,
} from "./types.js";
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
import { shellEscape } from "../util.js";

/**
 * Shared base for microVM drivers whose in-guest work is served by the `sbx-agent`
 * over the A.4 wire protocol (`AgentConn`). Every agent-served `Driver` method —
 * exec, files, watch, processes, preview bridge, terminal, stats, backup/restore —
 * is implemented here **once**, in terms of a single abstract `openConn(id)` that
 * each concrete driver provides for its transport (Apple VZ relays a unix socket
 * to the guest vsock; Firecracker connects to a vsock UDS with a CONNECT
 * handshake). Concrete drivers only implement lifecycle (`create`/`stop`/`start`/
 * `destroy`), `openConn`, and the host probes (`ping`/`hostInfo`) — the whole
 * point of the abstraction is that the surface above the driver is identical.
 */
export abstract class AgentDriver extends UnsupportedDriver {
  /**
   * Open a fresh agent connection to a running sandbox, resolved once the agent's
   * Hello arrives. Throws `<name>: sandbox <id> is not running` if it isn't live.
   * The connection is single-use unless the caller keeps it (long-lived streams).
   */
  protected abstract openConn(id: string): Promise<AgentConn>;

  /** Open a connection, run `fn`, always close it. For one-shot request/response ops. */
  protected async withConn<T>(id: string, fn: (c: AgentConn) => Promise<T>): Promise<T> {
    const conn = await this.openConn(id);
    try {
      return await fn(conn);
    } finally {
      conn.close();
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

  /** Watch a path recursively for changes over the agent (poll-based mtime diff),
   *  streaming events until `opts.signal` aborts. Holds a connection for its life. */
  async watchFiles(
    id: string,
    path: string,
    opts: WatchOptions & { signal: AbortSignal },
    onEvent: (e: FileChangeEvent) => void,
  ): Promise<void> {
    return this.withConn(id, (c) => c.watch(path, opts.intervalMs ?? 1000, opts.signal, onEvent));
  }

  // --- background processes (via exec, same shell patterns as the container driver) -

  async startProcess(
    id: string,
    procId: string,
    command: string,
    opts: StartProcessOptions,
  ): Promise<StartProcessResult> {
    const logPath = `/tmp/hotcell-proc-${procId}.log`;
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
    const conn = await this.openConn(id);
    const cmd = opts.follow ? `tail -n +1 -F ${shellEscape(logPath)}` : `cat ${shellEscape(logPath)}`;
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

  /** Raw byte bridge to `host:port` inside the guest — backs the preview-URL proxy.
   *  Each bridge holds its own connection (the duplex is long-lived). */
  async openTcpBridge(id: string, port: number, host: string): Promise<TcpBridge> {
    const conn = await this.openConn(id);
    const { stream } = conn.openStream({ method: "tcpConnect", host, port });
    return {
      stream,
      close: () => {
        stream.destroy();
        conn.close();
      },
    };
  }

  /** Interactive PTY shell — backs the dashboard/CLI terminal. */
  async openTerminal(id: string, opts: TerminalOptions): Promise<TerminalSession> {
    const conn = await this.openConn(id);
    const { stream, streamId } = conn.openStream({
      method: "openPty",
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: opts.env,
    });
    return {
      stream,
      resize: (cols, rows) => conn.controlStream(streamId, { method: "resize", cols, rows }),
      close: () => {
        stream.destroy();
        conn.close();
      },
    };
  }

  // --- stats + backup/restore -----------------------------------------------

  /** Live resource snapshot from the guest's /proc + cgroup files (via the agent).
   *  cpuPercent is left 0 by the guest — the metrics sampler derives it from the
   *  delta of successive cpuTotalUsageNs samples, exactly as for the container driver. */
  async stats(id: string): Promise<SandboxStats> {
    const s = await this.withConn(id, (c) => c.stats());
    return s as SandboxStats;
  }

  /** Tar the guest's /workspace to `tarPath` on the host (over the agent). */
  async createBackup(id: string, tarPath: string): Promise<{ bytes: number }> {
    const conn = await this.openConn(id);
    try {
      const out = createWriteStream(tarPath);
      let bytes = 0;
      await conn.readStream({ method: "tarWorkspace", path: "/workspace" }, (b) => {
        bytes += b.length;
        out.write(b);
      });
      await new Promise<void>((resolve, reject) =>
        out.end((err?: Error | null) => (err ? reject(err) : resolve())),
      );
      return { bytes };
    } finally {
      conn.close();
    }
  }

  /** Replace the guest's /workspace with the tar at `tarPath` (cleared first). */
  async restoreBackup(id: string, tarPath: string): Promise<void> {
    const conn = await this.openConn(id);
    try {
      const up = conn.writeStream({ method: "untarWorkspace", path: "/workspace" });
      await new Promise<void>((resolve, reject) => {
        const rs = createReadStream(tarPath);
        rs.on("data", (chunk) => up.write(chunk as Buffer));
        rs.on("end", resolve);
        rs.on("error", reject);
      });
      up.end();
      await up.done;
    } finally {
      conn.close();
    }
  }

  /** Run a command and collect its full stdout/stderr/exit (for the process shims). */
  protected async execCapture(
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
}
