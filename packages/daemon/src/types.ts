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

/**
 * A persistent code-interpreter context. Backed by a long-lived kernel process
 * inside the sandbox that keeps a namespace across `runCode` calls (variables
 * and imports persist, Jupyter-style).
 */
export interface CodeContextInfo {
  contextId: string;
  language: "python" | "javascript";
  /** Context directory inside the sandbox (holds the kernel + its fifos). */
  dir: string;
  /** procId of the kernel background process (so it can be killed on cleanup). */
  procId: string;
  /** In-container PID of the kernel (target for the kill on cleanup). */
  pid: number;
  /** Monotonic cell counter, incremented per `runCode`. */
  seq: number;
  createdAt: string;
}

/** A single rich output from a code cell. */
export interface CodeOutput {
  type: "text";
  text: string;
}

/** The result of running a code cell. */
export interface CodeResult {
  stdout: string;
  stderr: string;
  /** Rich outputs (e.g. the value of a trailing expression). */
  results: CodeOutput[];
  /** Formatted traceback/stack if the cell raised, else null. */
  error: string | null;
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
