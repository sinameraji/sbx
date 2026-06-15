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

/** A live bidirectional byte stream bridged to a port inside a sandbox. */
export interface TcpBridge {
  /** Raw duplex carrying bytes to/from the in-container TCP relay. */
  stream: NodeJS.ReadWriteStream;
  /** Tear down the bridge and the in-container relay process. */
  close(): void;
}

/** Result of launching a background process. */
export interface StartProcessResult {
  procId: string;
  pid: number;
  logPath: string;
}

/** Liveness view of a tracked background process. */
export interface ProcessLiveness {
  procId: string;
  pid: number;
  running: boolean;
}

export interface CreateOptions {
  id: string;
  image: string;
  env?: Record<string, string>;
  labels?: Record<string, string>;
  /**
   * Back `/workspace` with a named volume so files outlive the container. With
   * persistence the container is cattle: `stop` removes it, `start` recreates it,
   * and the workspace survives. Defaults to true.
   */
  persist?: boolean;
}

/**
 * Runtime-driver interface — the core abstraction of sbx.
 *
 * Phase 0 ships the `container` driver (Docker Engine API). Future drivers
 * (`firecracker` on Linux, `applevz` on macOS) implement this same surface so
 * the daemon, SDK, and CLI are unchanged when you swap isolation tiers.
 *
 * Drivers are addressed by the public sandbox `id`; they derive their own
 * backing-resource name from it and stay otherwise stateless.
 */
export interface Driver {
  readonly name: string;

  /** Provision and start a sandbox (creating its persistent volume if needed). */
  create(opts: CreateOptions): Promise<void>;

  /**
   * Stop a sandbox, freeing its compute. With persistence the container is
   * removed but its workspace volume is kept, so `start` can recreate it with
   * the data intact. In-container processes do not survive a stop.
   */
  stop(id: string): Promise<void>;

  /**
   * (Re)create and start a sandbox's container, reattaching its persistent
   * volume. Used to resume a stopped sandbox; the workspace is preserved.
   */
  start(opts: CreateOptions): Promise<void>;

  /**
   * Run a command inside the sandbox, streaming output via `onEvent`.
   * Resolves with the process exit code.
   */
  exec(
    id: string,
    command: string,
    opts: ExecOptions,
    onEvent: (e: ExecEvent) => void,
  ): Promise<number>;

  /** Write a file inside the sandbox. */
  writeFile(id: string, opts: WriteFileOptions): Promise<void>;

  /** Read a file from the sandbox, returning its UTF-8 contents. */
  readFile(id: string, opts: ReadFileOptions): Promise<string>;

  /** Create a directory inside the sandbox. */
  mkdir(id: string, opts: MkdirOptions): Promise<void>;

  /** List files and directories at the given path. */
  listFiles(id: string, opts: ListFilesOptions): Promise<FileInfo[]>;

  /**
   * Launch a detached background process. `procId` is daemon-supplied so the
   * in-container logfile is deterministic. Resolves once the process is spawned.
   */
  startProcess(
    id: string,
    procId: string,
    command: string,
    opts: StartProcessOptions,
  ): Promise<StartProcessResult>;

  /** Report liveness for the given in-container PIDs. */
  listProcesses(
    id: string,
    procs: Array<{ procId: string; pid: number }>,
  ): Promise<ProcessLiveness[]>;

  /** Send a signal to a process group (default TERM). */
  killProcess(id: string, pid: number, signal?: string): Promise<void>;

  /** Stream a process logfile to `onData`; `follow` tails it until aborted. */
  streamProcessLogs(
    id: string,
    logPath: string,
    opts: { follow: boolean; signal: AbortSignal },
    onData: (chunk: string) => void,
  ): Promise<void>;

  /** Block until a TCP port is listening inside the sandbox, or timeout. */
  waitForPort(id: string, port: number, opts: WaitForPortOptions): Promise<boolean>;

  /**
   * Open a raw bidirectional byte bridge to `host:port` inside the sandbox.
   * Used by the preview-URL proxy; goes through the Docker socket so it works
   * even where container IPs are unreachable from the host (macOS Docker Desktop).
   */
  openTcpBridge(id: string, port: number, host: string): Promise<TcpBridge>;

  /**
   * Permanently destroy the sandbox and free its resources, including its
   * persistent workspace volume. This is irreversible — use `stop` to pause.
   */
  destroy(id: string): Promise<void>;

  /** Liveness check for the underlying runtime (e.g. Docker daemon reachable). */
  ping(): Promise<void>;
}
