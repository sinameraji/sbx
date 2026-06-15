/**
 * @sbx/sdk — TypeScript client for the sbx daemon.
 *
 * Mirrors the Cloudflare Sandbox SDK surface so existing harnesses port with
 * minimal changes, but points at *your* self-hosted daemon instead of the edge.
 *
 *   const client = new SbxClient({ endpoint: "http://127.0.0.1:4750" });
 *   const sandbox = await client.getSandbox();
 *   const { stdout } = await sandbox.exec("python3 -c 'print(2+2)'");
 *   await sandbox.destroy();
 */

export type ExecEvent =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "exit"; exitCode: number };

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Run inside a persistent session (its cwd/env apply and `cd` persists). */
  sessionId?: string;
  /** Called for each stdout/stderr chunk as it streams in. */
  onOutput?: (stream: "stdout" | "stderr", data: string) => void;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
}

export interface SandboxInfo {
  id: string;
  image: string;
  status: "running" | "stopped";
  createdAt: string;
  labels: Record<string, string>;
  /** Whether `/workspace` is backed by a volume that survives stop/start. */
  persist: boolean;
}

export interface FileInfo {
  path: string;
  name: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string;
}

export interface CreateOptions {
  image?: string;
  env?: Record<string, string>;
  labels?: Record<string, string>;
  /**
   * Back `/workspace` with a named volume so files survive `stop`/`start` and
   * container recreation. Defaults to true.
   */
  persist?: boolean;
}

export interface WriteFileOptions {
  mode?: string;
}

export interface MkdirOptions {
  parents?: boolean;
}

export interface StartProcessOptions {
  cwd?: string;
  env?: Record<string, string>;
}

/** A long-running background process tracked by the daemon. */
export interface ProcessHandle {
  procId: string;
  pid: number;
  command: string;
  status: "running" | "exited";
  exitCode: number | null;
  startedAt: string;
  logPath: string;
}

export interface WaitForPortOptions {
  timeoutMs?: number;
  intervalMs?: number;
  host?: string;
}

/** A port exposed through the daemon's preview-URL reverse proxy. */
export interface ExposedPort {
  port: number;
  exposeId: string;
  token: string | null;
  createdAt: string;
  url: string;
}

/** A persistent execution context (working directory + env) inside a sandbox. */
export interface SessionInfo {
  sessionId: string;
  cwd: string;
  env: Record<string, string>;
  createdAt: string;
}

export interface CreateSessionOptions {
  /** Explicit session id; a random one is assigned when omitted. */
  id?: string;
  cwd?: string;
  env?: Record<string, string>;
}

/** Metadata for a workspace backup. */
export interface BackupInfo {
  backupId: string;
  sandboxId: string;
  createdAt: string;
  /** Size of the backup tarball in bytes. */
  bytes: number;
}

export interface SbxClientOptions {
  endpoint?: string;
}

export class SbxClient {
  readonly endpoint: string;

  constructor(opts: SbxClientOptions = {}) {
    this.endpoint = (opts.endpoint ?? defaultEndpoint()).replace(/\/$/, "");
  }

  /** Create a fresh sandbox (Cloudflare-style: omit id to provision a new one). */
  async getSandbox(id?: string, options?: CreateOptions): Promise<Sandbox> {
    if (id) {
      // Attach to an existing sandbox by id.
      const info = await this.request<SandboxInfo>("GET", `/sandboxes/${id}`);
      return new Sandbox(this, info);
    }
    const info = await this.request<SandboxInfo>("POST", "/sandboxes", options ?? {});
    return new Sandbox(this, info);
  }

  /** List all sandboxes managed by the daemon. */
  async list(): Promise<SandboxInfo[]> {
    const { sandboxes } = await this.request<{ sandboxes: SandboxInfo[] }>(
      "GET",
      "/sandboxes",
    );
    return sandboxes;
  }

  /** Daemon health + active runtime driver. */
  async health(): Promise<{ ok: boolean; driver: string }> {
    return this.request("GET", "/healthz");
  }

  /** List all workspace backups across sandboxes. */
  async listBackups(): Promise<BackupInfo[]> {
    const { backups } = await this.request<{ backups: BackupInfo[] }>(
      "GET",
      "/backups",
    );
    return backups;
  }

  /** Delete a backup by id. */
  async deleteBackup(backupId: string): Promise<void> {
    await this.request("DELETE", `/backups/${backupId}`);
  }

  /** @internal */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.endpoint + path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`sbx ${method} ${path} -> ${res.status}: ${text}`);
    }
    return (await res.json()) as T;
  }
}

export class Sandbox {
  constructor(
    private readonly client: SbxClient,
    private info: SandboxInfo,
  ) {}

  get id(): string {
    return this.info.id;
  }

  /** Current lifecycle status (`running` or `stopped`). */
  get status(): "running" | "stopped" {
    return this.info.status;
  }

  /** Run a command to completion, returning aggregated output. */
  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    for await (const event of this.execStream(command, options)) {
      if (event.type === "stdout") stdout += event.data;
      else if (event.type === "stderr") stderr += event.data;
      else exitCode = event.exitCode;
    }
    return { stdout, stderr, exitCode, success: exitCode === 0 };
  }

  /** Run a command, yielding output events as they stream in. */
  async *execStream(
    command: string,
    options: ExecOptions = {},
  ): AsyncGenerator<ExecEvent> {
    const res = await fetch(
      `${this.client.endpoint}/sandboxes/${this.info.id}/exec`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          command,
          cwd: options.cwd,
          env: options.env,
          sessionId: options.sessionId,
        }),
      },
    );
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`sbx exec -> ${res.status}: ${text}`);
    }
    for await (const event of parseSSE<ExecEvent>(res.body)) {
      if (
        options.onOutput &&
        (event.type === "stdout" || event.type === "stderr")
      ) {
        options.onOutput(event.type, event.data);
      }
      yield event;
    }
  }

  /**
   * Stop the sandbox, freeing compute. With persistence the workspace volume is
   * kept so `start` resumes with files intact; background processes do not
   * survive. A no-op if already stopped.
   */
  async stop(): Promise<void> {
    this.info = await this.client.request<SandboxInfo>(
      "POST",
      `/sandboxes/${this.info.id}/stop`,
    );
  }

  /** Restart a stopped sandbox, reattaching its workspace. A no-op if running. */
  async start(): Promise<void> {
    this.info = await this.client.request<SandboxInfo>(
      "POST",
      `/sandboxes/${this.info.id}/start`,
    );
  }

  /** Snapshot `/workspace` to a durable backup; returns its metadata. */
  async createBackup(): Promise<BackupInfo> {
    return this.client.request<BackupInfo>(
      "POST",
      `/sandboxes/${this.info.id}/backups`,
    );
  }

  /** Replace `/workspace` with the contents of a backup (taken from any sandbox). */
  async restoreBackup(backupId: string): Promise<void> {
    await this.client.request(
      "POST",
      `/sandboxes/${this.info.id}/restore`,
      { backupId },
    );
  }

  /** List the backups taken from this sandbox. */
  async listBackups(): Promise<BackupInfo[]> {
    const { backups } = await this.client.request<{ backups: BackupInfo[] }>(
      "GET",
      `/sandboxes/${this.info.id}/backups`,
    );
    return backups;
  }

  /** Permanently destroy the sandbox, including its persistent volume. */
  async destroy(): Promise<void> {
    await this.client.request("DELETE", `/sandboxes/${this.info.id}`);
  }

  /** Write a UTF-8 file inside the sandbox. */
  async writeFile(
    path: string,
    content: string,
    options: WriteFileOptions = {},
  ): Promise<void> {
    await this.client.request<{ ok: boolean }>(
      "POST",
      `/sandboxes/${this.info.id}/files/write`,
      { path, content, mode: options.mode },
    );
  }

  /** Read a UTF-8 file from the sandbox. */
  async readFile(path: string): Promise<string> {
    const { content } = await this.client.request<{ content: string }>(
      "POST",
      `/sandboxes/${this.info.id}/files/read`,
      { path },
    );
    return content;
  }

  /** Create a directory inside the sandbox. */
  async mkdir(path: string, options: MkdirOptions = {}): Promise<void> {
    await this.client.request<{ ok: boolean }>(
      "POST",
      `/sandboxes/${this.info.id}/files/mkdir`,
      { path, parents: options.parents },
    );
  }

  /** List files and directories at the given path. */
  async listFiles(path: string): Promise<FileInfo[]> {
    const { entries } = await this.client.request<{ entries: FileInfo[] }>(
      "POST",
      `/sandboxes/${this.info.id}/files/list`,
      { path },
    );
    return entries;
  }

  /** Launch a long-running background process; returns immediately. */
  async startProcess(
    command: string,
    options: StartProcessOptions = {},
  ): Promise<ProcessHandle> {
    return this.client.request<ProcessHandle>(
      "POST",
      `/sandboxes/${this.info.id}/processes`,
      { command, cwd: options.cwd, env: options.env },
    );
  }

  /** List background processes started in this sandbox. */
  async listProcesses(): Promise<ProcessHandle[]> {
    const { processes } = await this.client.request<{ processes: ProcessHandle[] }>(
      "GET",
      `/sandboxes/${this.info.id}/processes`,
    );
    return processes;
  }

  /** Signal a background process (default SIGTERM). */
  async killProcess(procId: string, signal?: string): Promise<void> {
    await this.client.request(
      "DELETE",
      `/sandboxes/${this.info.id}/processes/${procId}`,
      signal ? { signal } : undefined,
    );
  }

  /** Stream a process's logs; `follow` tails until the connection closes. */
  async *streamLogs(
    procId: string,
    options: { follow?: boolean } = {},
  ): AsyncGenerator<string> {
    const follow = options.follow ? "1" : "0";
    const res = await fetch(
      `${this.client.endpoint}/sandboxes/${this.info.id}/processes/${procId}/logs?follow=${follow}`,
    );
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`sbx logs -> ${res.status}: ${text}`);
    }
    for await (const event of parseSSE<LogEvent>(res.body)) {
      if (event.type === "log") yield event.data;
      else if (event.type === "end") return;
    }
  }

  /** Block until a TCP port is listening inside the sandbox, or timeout. */
  async waitForPort(
    port: number,
    options: WaitForPortOptions = {},
  ): Promise<boolean> {
    const { ready } = await this.client.request<{ ready: boolean }>(
      "POST",
      `/sandboxes/${this.info.id}/wait-port`,
      { port, ...options },
    );
    return ready;
  }

  /** Expose an in-container port and return its preview URL. */
  async exposePort(
    port: number,
    options: { token?: string } = {},
  ): Promise<ExposedPort> {
    return this.client.request<ExposedPort>(
      "POST",
      `/sandboxes/${this.info.id}/expose`,
      { port, token: options.token },
    );
  }

  /** Remove a previously exposed port. */
  async unexposePort(port: number): Promise<void> {
    await this.client.request(
      "DELETE",
      `/sandboxes/${this.info.id}/expose/${port}`,
    );
  }

  /** List the ports currently exposed for this sandbox. */
  async listExposedPorts(): Promise<ExposedPort[]> {
    const { exposed } = await this.client.request<{ exposed: ExposedPort[] }>(
      "GET",
      `/sandboxes/${this.info.id}/expose`,
    );
    return exposed;
  }

  /** Merge environment variables applied to every subsequent command. */
  async setEnvVars(env: Record<string, string>): Promise<Record<string, string>> {
    const res = await this.client.request<{ env: Record<string, string> }>(
      "POST",
      `/sandboxes/${this.info.id}/env`,
      { env },
    );
    return res.env;
  }

  /** Read the sandbox-level environment variables. */
  async getEnvVars(): Promise<Record<string, string>> {
    const res = await this.client.request<{ env: Record<string, string> }>(
      "GET",
      `/sandboxes/${this.info.id}/env`,
    );
    return res.env;
  }

  /** Create a persistent session; commands run in it share cwd + env. */
  async createSession(options: CreateSessionOptions = {}): Promise<Session> {
    const info = await this.client.request<SessionInfo>(
      "POST",
      `/sandboxes/${this.info.id}/sessions`,
      { id: options.id, cwd: options.cwd, env: options.env },
    );
    return new Session(this, info);
  }

  /** List the sessions open in this sandbox. */
  async listSessions(): Promise<SessionInfo[]> {
    const { sessions } = await this.client.request<{ sessions: SessionInfo[] }>(
      "GET",
      `/sandboxes/${this.info.id}/sessions`,
    );
    return sessions;
  }

  /** @internal — used by Session to reach the env/session endpoints. */
  get _client(): SbxClient {
    return this.client;
  }
}

/**
 * A persistent execution context inside a sandbox. `exec` runs in the session's
 * working directory with its env overlay, and a `cd` persists to later commands.
 */
export class Session {
  constructor(
    private readonly sandbox: Sandbox,
    private readonly info: SessionInfo,
  ) {}

  get sessionId(): string {
    return this.info.sessionId;
  }

  /** Run a command to completion within this session. */
  exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    return this.sandbox.exec(command, { ...options, sessionId: this.sessionId });
  }

  /** Run a command, yielding output events as they stream in. */
  execStream(command: string, options: ExecOptions = {}): AsyncGenerator<ExecEvent> {
    return this.sandbox.execStream(command, {
      ...options,
      sessionId: this.sessionId,
    });
  }

  /** Merge environment variables applied to subsequent commands in this session. */
  async setEnvVars(env: Record<string, string>): Promise<SessionInfo> {
    return this.sandbox._client.request<SessionInfo>(
      "POST",
      `/sandboxes/${this.sandbox.id}/sessions/${this.sessionId}/env`,
      { env },
    );
  }

  /** Delete this session (the sandbox and its files are untouched). */
  async destroy(): Promise<void> {
    await this.sandbox._client.request(
      "DELETE",
      `/sandboxes/${this.sandbox.id}/sessions/${this.sessionId}`,
    );
  }
}

type LogEvent = { type: "log"; data: string } | { type: "end" };

/** Convenience matching the Cloudflare `getSandbox(binding, id)` shape. */
export function getSandbox(
  client: SbxClient,
  id?: string,
  options?: CreateOptions,
): Promise<Sandbox> {
  return client.getSandbox(id, options);
}

// --- internals -------------------------------------------------------------

function defaultEndpoint(): string {
  const env = (globalThis as { process?: { env?: Record<string, string> } })
    .process?.env;
  return env?.SBX_ENDPOINT ?? "http://127.0.0.1:4750";
}

/** Parse a `text/event-stream` body into typed JSON events. */
async function* parseSSE<T>(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const json = line.slice(5).trim();
      if (json) yield JSON.parse(json) as T;
    }
  }
}
