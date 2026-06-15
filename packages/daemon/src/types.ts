// Shared daemon types.

export type SandboxStatus = "running" | "stopped";

export interface SandboxRecord {
  id: string;
  image: string;
  status: SandboxStatus;
  createdAt: string;
  labels: Record<string, string>;
  /**
   * Sandbox-level environment variables, merged into every `exec`/`startProcess`
   * in this sandbox. Seeded from the create call's `env` and mutated by
   * `setEnvVars`. Request- and session-level env take precedence over these.
   */
  env: Record<string, string>;
  /**
   * Whether `/workspace` is backed by a named volume that survives `stop`/`start`
   * and container recreation. Set at create time; defaults to true.
   */
  persist: boolean;
}

/**
 * A persistent execution context inside a sandbox. Holds a working directory
 * (which follows `cd` across commands) and its own environment overlay, so a
 * sequence of `exec`s behaves like one shell session. Built on top of the
 * driver's stateless `exec`/`readFile` — no driver support required.
 */
export interface SessionInfo {
  sessionId: string;
  /** Working directory for the next command; updated after each exec. */
  cwd: string;
  /** Session-level env, layered over the sandbox env. */
  env: Record<string, string>;
  createdAt: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
}

/** A single event in a streaming command execution. */
export type ExecEvent =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "exit"; exitCode: number };

/** Metadata returned for a file or directory entry. */
export interface FileInfo {
  path: string;
  name: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string;
}

/** Options for writing a file inside a sandbox. */
export interface WriteFileOptions {
  path: string;
  content: string;
  mode?: string;
}

/** Options for reading a file from a sandbox. */
export interface ReadFileOptions {
  path: string;
}

/** Options for creating a directory inside a sandbox. */
export interface MkdirOptions {
  path: string;
  parents?: boolean;
}

/** Options for listing files inside a sandbox. */
export interface ListFilesOptions {
  path: string;
}

/** Options for launching a long-running background process. */
export interface StartProcessOptions {
  cwd?: string;
  env?: Record<string, string>;
}

/** A long-running background process tracked by the daemon. */
export interface ProcessInfo {
  /** Daemon-assigned handle (stable across PID reuse). */
  procId: string;
  /** In-container PID of the detached process. */
  pid: number;
  command: string;
  status: "running" | "exited";
  exitCode: number | null;
  startedAt: string;
  /** Path of the process logfile inside the sandbox. */
  logPath: string;
}

/** Options for waiting until a TCP port is listening inside a sandbox. */
export interface WaitForPortOptions {
  timeoutMs?: number;
  intervalMs?: number;
  host?: string;
}

/** A port exposed through the daemon's preview-URL reverse proxy. */
export interface ExposedPort {
  /** In-container port the app listens on. */
  port: number;
  /** Routing label / subdomain (`<sandboxId>-<port>`). */
  exposeId: string;
  /** Optional per-port bearer token; null means open on loopback. */
  token: string | null;
  createdAt: string;
  /** Computed preview URL. */
  url: string;
}
