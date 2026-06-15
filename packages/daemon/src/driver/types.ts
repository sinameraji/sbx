import type {
  ExecEvent,
  ExecOptions,
  FileInfo,
  ListFilesOptions,
  MkdirOptions,
  ReadFileOptions,
  WriteFileOptions,
} from "../types.js";

export interface CreateOptions {
  id: string;
  image: string;
  env?: Record<string, string>;
  labels?: Record<string, string>;
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

  /** Provision and start a sandbox. */
  create(opts: CreateOptions): Promise<void>;

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

  /** Permanently destroy the sandbox and free its resources. */
  destroy(id: string): Promise<void>;

  /** Liveness check for the underlying runtime (e.g. Docker daemon reachable). */
  ping(): Promise<void>;
}
