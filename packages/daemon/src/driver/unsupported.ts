import type {
  CreateOptions,
  Driver,
  HostInfo,
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

/**
 * Base class for runtime drivers that are part of the architecture but not yet
 * built (the Phase 3 microVM drivers). It implements the whole `Driver` surface
 * so the seam — driver selection, the daemon/SDK/CLI layering — is real and
 * compiles today; every operation throws a clear "not implemented" error, and
 * each concrete subclass overrides `ping()` to explain what host support it needs.
 *
 * When a microVM driver is actually implemented (on a KVM Linux box / a Mac with
 * Virtualization.framework) it stops extending this and implements the methods
 * for real — nothing else in the codebase changes.
 */
export abstract class UnsupportedDriver implements Driver {
  abstract readonly name: string;

  /** Subclasses throw a host-specific "this driver needs X" error here. */
  abstract ping(): Promise<void>;

  protected fail(op: string): never {
    throw new Error(
      `driver "${this.name}" does not implement ${op} yet — it is a planned ` +
        `Phase 3 microVM driver (see docs/plan.md). Use SBX_DRIVER=container.`,
    );
  }

  async create(_opts: CreateOptions): Promise<void> {
    this.fail("create");
  }
  async stop(_id: string): Promise<void> {
    this.fail("stop");
  }
  async start(_opts: CreateOptions): Promise<void> {
    this.fail("start");
  }
  async exec(
    _id: string,
    _command: string,
    _opts: ExecOptions,
    _onEvent: (e: ExecEvent) => void,
  ): Promise<number> {
    this.fail("exec");
  }
  async writeFile(_id: string, _opts: WriteFileOptions): Promise<void> {
    this.fail("writeFile");
  }
  async readFile(_id: string, _opts: ReadFileOptions): Promise<string> {
    this.fail("readFile");
  }
  async mkdir(_id: string, _opts: MkdirOptions): Promise<void> {
    this.fail("mkdir");
  }
  async listFiles(_id: string, _opts: ListFilesOptions): Promise<FileInfo[]> {
    this.fail("listFiles");
  }
  async watchFiles(
    _id: string,
    _path: string,
    _opts: WatchOptions & { signal: AbortSignal },
    _onEvent: (e: FileChangeEvent) => void,
  ): Promise<void> {
    this.fail("watchFiles");
  }
  async startProcess(
    _id: string,
    _procId: string,
    _command: string,
    _opts: StartProcessOptions,
  ): Promise<StartProcessResult> {
    this.fail("startProcess");
  }
  async listProcesses(
    _id: string,
    _procs: Array<{ procId: string; pid: number }>,
  ): Promise<ProcessLiveness[]> {
    this.fail("listProcesses");
  }
  async killProcess(_id: string, _pid: number, _signal?: string): Promise<void> {
    this.fail("killProcess");
  }
  async streamProcessLogs(
    _id: string,
    _logPath: string,
    _opts: { follow: boolean; signal: AbortSignal },
    _onData: (chunk: string) => void,
  ): Promise<void> {
    this.fail("streamProcessLogs");
  }
  async waitForPort(_id: string, _port: number, _opts: WaitForPortOptions): Promise<boolean> {
    this.fail("waitForPort");
  }
  async openTcpBridge(_id: string, _port: number, _host: string): Promise<TcpBridge> {
    this.fail("openTcpBridge");
  }
  async openTerminal(_id: string, _opts: TerminalOptions): Promise<TerminalSession> {
    this.fail("openTerminal");
  }
  async createBackup(_id: string, _tarPath: string): Promise<{ bytes: number }> {
    this.fail("createBackup");
  }
  async restoreBackup(_id: string, _tarPath: string): Promise<void> {
    this.fail("restoreBackup");
  }
  async destroy(_id: string): Promise<void> {
    this.fail("destroy");
  }
  async stats(_id: string): Promise<SandboxStats> {
    this.fail("stats");
  }
  async hostInfo(): Promise<HostInfo> {
    this.fail("hostInfo");
  }
}
