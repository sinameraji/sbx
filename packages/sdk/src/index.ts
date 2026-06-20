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

export type SandboxStatus = "running" | "paused" | "stopped";

/** Hard per-sandbox resource caps (0/absent = unlimited). */
export interface SandboxLimits {
  /** Memory cap in MiB. */
  memoryMb?: number;
  /** CPU cap in fractional cores (e.g. 0.5, 2). */
  cpus?: number;
  /** Max processes/threads. */
  pidsLimit?: number;
}

export interface SandboxInfo {
  id: string;
  image: string;
  /**
   * Lifecycle state. `paused` is entered automatically after `sleepAfterMs` of
   * inactivity (the next operation transparently resumes it); `stopped` is a
   * manual stop that does not auto-resume.
   */
  status: SandboxStatus;
  createdAt: string;
  labels: Record<string, string>;
  /** Whether `/workspace` is backed by a volume that survives stop/start. */
  persist: boolean;
  /** ISO timestamp of the last activity (drives idle auto-pause). */
  lastActivityAt: string;
  /** Idle timeout (ms) before auto-pause; 0 disables it. */
  sleepAfterMs: number;
  /** Resolved hard resource caps applied to the sandbox ({} = unlimited). */
  limits: SandboxLimits;
}

export interface FileInfo {
  path: string;
  name: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string;
}

/** Live resource snapshot for a running sandbox. */
export interface SandboxStats {
  cpuPercent: number;
  cpuTotalUsageNs: number;
  onlineCpus: number;
  memBytes: number;
  memLimitBytes: number;
  netRxBytes: number;
  netTxBytes: number;
  pids: number;
  sampledAt: string;
}

/** Cumulative, time-integrated usage backing the cost meter. */
export interface SandboxUsage {
  cpuSeconds: number;
  memByteSeconds: number;
  egressBytes: number;
  /** LLM-provider calls made through the egress credential proxy. */
  providerCalls: number;
  /** Bytes exchanged with providers through the egress proxy. */
  providerBytes: number;
  /** Prompt/input tokens billed across provider calls. */
  providerTokensIn: number;
  /** Completion/output tokens billed across provider calls. */
  providerTokensOut: number;
  /** Provider-reported LLM cost in USD (e.g. OpenRouter `usage.cost`), summed. */
  providerCost: number;
}

/** A provider reachable through the egress credential proxy (LLM gateway). */
export interface EgressProvider {
  name: string;
  /** Base URL to point the provider SDK at (sandbox uses the token as the key). */
  baseUrl: string;
  /** Conventional env var for the base URL (e.g. OPENAI_BASE_URL). */
  baseUrlEnv?: string;
  /** Conventional env var for the API key (set it to the egress token). */
  keyEnv?: string;
}

/**
 * Per-token egress policy. Every field is optional; an omitted/empty policy means
 * "unlimited" (the original behaviour). Enforced by the daemon's egress gateway.
 */
export interface EgressPolicy {
  /** ISO timestamp after which the token is rejected (403). */
  expiresAt?: string;
  /** Sugar accepted on mint: expire `ttlMs` after creation. */
  ttlMs?: number;
  /** Cumulative USD this token may spend (402 once reached). */
  spendCapUsd?: number;
  /** Sliding-window rate limit (per token). */
  rateLimit?: { calls?: number; tokens?: number; windowMs: number };
  /** Allowed model ids/prefix-globs. Omit = all. */
  models?: string[];
  /** Allowed provider names. Omit = every configured provider. */
  providers?: string[];
}

/** A minted egress token plus the provider base URLs it unlocks. */
export interface EgressToken {
  token: string;
  /** The policy bound to the token (echoed back on mint). */
  policy?: EgressPolicy;
  providers: EgressProvider[];
}

/** An egress token with its policy + running spend, as returned by `listEgressTokens`. */
export interface EgressTokenInfo {
  token: string;
  policy: EgressPolicy;
  spendUsd: number;
  /** USD left under the spend cap, or null when uncapped. */
  spendRemaining: number | null;
}

/** Per-resource cost breakdown in the daemon's configured currency. */
export interface CostBreakdown {
  cpu: number;
  mem: number;
  egress: number;
  /** LLM cost (provider-reported, e.g. OpenRouter `usage.cost`). */
  provider: number;
  total: number;
}

/** Metrics + cost for a sandbox; `live` is null when not running. */
export interface SandboxMetrics {
  status: SandboxStatus;
  live: SandboxStats | null;
  usage: SandboxUsage;
  cost: CostBreakdown;
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
  /**
   * Auto-pause the sandbox after this many milliseconds of inactivity (the idle
   * reaper frees compute while the workspace volume persists; the next operation
   * auto-resumes it). Omit or set 0 to disable. Defaults to the daemon's
   * `SBX_SLEEP_AFTER_MS`.
   */
  sleepAfter?: number;
  /**
   * Wire the sandbox to the egress credential proxy: the daemon mints an egress
   * token and injects provider base-URL + key env vars (e.g. `OPENAI_BASE_URL`,
   * `OPENAI_API_KEY`) so LLM SDKs inside route through the gateway with no real
   * keys. Only providers configured on the daemon are wired. Defaults to false.
   *
   * Pass an `EgressPolicy` object instead of `true` to bind the minted token to a
   * policy (TTL, spend cap, rate limit, model/provider scope).
   */
  egress?: boolean | EgressPolicy;
  /**
   * Hard ceiling (USD) on this sandbox's total LLM-provider cost across all its
   * egress tokens; the gateway returns 402 once reached. A blast-radius backstop
   * independent of per-token caps. Omit/0 = unlimited (or the daemon default).
   */
  egressSpendCapUsd?: number;
  /**
   * Ordered shell commands run once, after the container starts at create time
   * (e.g. `["npm i kimiflare"]`). Best-effort: a non-zero exit is logged on the
   * daemon, not fatal. Not re-run on resume — with persistence (the default) the
   * workspace volume already holds the result.
   */
  setup?: string[];
  /**
   * Git repository URL cloned into `/workspace` at create time (before `setup`),
   * so an agent comes up with the code in place. Private repos: embed a token in
   * the URL (`https://<token>@github.com/owner/repo.git`). A clone failure fails
   * the create.
   */
  repo?: string;
  /** Branch/tag to check out when cloning `repo` (default: the repo's default branch). */
  repoRef?: string;
  /** Hard memory cap in MiB (overrides the daemon default; 0 = unlimited). */
  memoryMb?: number;
  /** Hard CPU cap in fractional cores, e.g. 0.5 (overrides the daemon default). */
  cpus?: number;
  /** Hard process/thread cap (overrides the daemon default; 0 = unlimited). */
  pidsLimit?: number;
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

/** A filesystem change observed by `watch`. */
export interface FileChangeEvent {
  type: "created" | "modified" | "deleted";
  path: string;
}

export type CodeLanguage = "python" | "javascript";

/** Public view of a code-interpreter context. */
export interface CodeContextInfo {
  contextId: string;
  language: CodeLanguage;
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
  results: CodeOutput[];
  error: string | null;
}

/** Metadata for a workspace backup. */
export interface BackupInfo {
  backupId: string;
  sandboxId: string;
  createdAt: string;
  /** Size of the backup tarball in bytes. */
  bytes: number;
}

/** Host capacity + admission status from `GET /capacity`. */
export interface CapacitySnapshot {
  enforced: boolean;
  overcommit: number;
  defaultReservationMb: number;
  memory: { budgetMb: number; committedMb: number; availableMb: number };
  cpu: { budget: number; committed: number; available: number };
  running: number;
  /** Approx. number of additional default-reservation sandboxes that still fit. */
  fits: number;
}

/** Daemon metadata from `GET /info`. */
export interface DaemonInfo {
  driver: string;
  drivers: string[];
  defaultImage: string;
  proxyPort: number;
  egressPort: number;
  egressProviders: string[];
  costCpuPerHour: number;
  costMemGbPerHour: number;
  costEgressPerGb: number;
  defaultSleepAfterMs: number;
  auth: boolean;
  otlp: boolean;
}

export interface SbxClientOptions {
  endpoint?: string;
  /**
   * API key sent as `Authorization: Bearer <key>` on every request. Required when
   * the daemon is started with `SBX_API_KEY`. Defaults to the `SBX_API_KEY` env
   * var when omitted.
   */
  apiKey?: string;
}

/** One live-metrics sample (for sparklines / history charts). */
export interface MetricSample {
  at: string;
  cpuPercent: number;
  memBytes: number;
  netRxBytes: number;
  netTxBytes: number;
  pids: number;
}

export class SbxClient {
  readonly endpoint: string;
  private readonly apiKey: string;

  constructor(opts: SbxClientOptions = {}) {
    this.endpoint = (opts.endpoint ?? defaultEndpoint()).replace(/\/$/, "");
    this.apiKey = opts.apiKey ?? defaultApiKey();
  }

  /** Build request headers, attaching the API key and any extras. */
  authHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;
    return headers;
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

  /** Daemon info: active/available drivers, default image, ports, providers, cost rates. */
  async info(): Promise<DaemonInfo> {
    return this.request<DaemonInfo>("GET", "/info");
  }

  /** Host capacity + admission status (committed vs budget memory, how many more fit). */
  async capacity(): Promise<CapacitySnapshot> {
    return this.request<CapacitySnapshot>("GET", "/capacity");
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
      headers: this.authHeaders(body ? { "content-type": "application/json" } : undefined),
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

  /** Current lifecycle status (`running`, `paused`, or `stopped`). */
  get status(): SandboxStatus {
    return this.info.status;
  }

  /** The sandbox metadata captured when this handle was created/attached. */
  getInfo(): SandboxInfo {
    return this.info;
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
        headers: this.client.authHeaders({ "content-type": "application/json" }),
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

  /**
   * Fetch live resource stats, cumulative usage, and cost. `live` is null when
   * the sandbox isn't running. Reading metrics does not count as activity, so it
   * won't keep an idle sandbox from auto-pausing.
   */
  async metrics(): Promise<SandboxMetrics> {
    return this.client.request<SandboxMetrics>(
      "GET",
      `/sandboxes/${this.info.id}/metrics`,
    );
  }

  /** Recent live-metrics samples (oldest→newest) for sparklines/history charts. */
  async metricsHistory(): Promise<MetricSample[]> {
    const { samples } = await this.client.request<{ samples: MetricSample[] }>(
      "GET",
      `/sandboxes/${this.info.id}/metrics/history`,
    );
    return samples;
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

  /**
   * Create a persistent code-interpreter context. Variables and imports persist
   * across `runCode` calls made against the returned context (Jupyter-style).
   */
  async createCodeContext(
    options: { language?: CodeLanguage } = {},
  ): Promise<CodeContext> {
    const info = await this.client.request<CodeContextInfo>(
      "POST",
      `/sandboxes/${this.info.id}/code-contexts`,
      { language: options.language ?? "python" },
    );
    return new CodeContext(this, info);
  }

  /** List the open code-interpreter contexts in this sandbox. */
  async listCodeContexts(): Promise<CodeContextInfo[]> {
    const { contexts } = await this.client.request<{ contexts: CodeContextInfo[] }>(
      "GET",
      `/sandboxes/${this.info.id}/code-contexts`,
    );
    return contexts;
  }

  /**
   * Run a code cell and return its captured output. Pass a `context` to keep
   * state across calls, or omit it for a one-off run in a throwaway kernel.
   */
  async runCode(
    code: string,
    options: { context?: CodeContext; language?: CodeLanguage; timeoutMs?: number } = {},
  ): Promise<CodeResult> {
    return this.client.request<CodeResult>(
      "POST",
      `/sandboxes/${this.info.id}/run-code`,
      {
        code,
        contextId: options.context?.contextId,
        language: options.language,
        timeoutMs: options.timeoutMs,
      },
    );
  }

  /**
   * Mint an egress token for this sandbox. Configure the sandbox's LLM SDK with
   * the returned `providers[].baseUrl` and use the token in place of the real API
   * key — the daemon injects the real provider key and meters the call, so keys
   * never live inside the sandbox.
   */
  async createEgressToken(policy?: EgressPolicy): Promise<EgressToken> {
    return this.client.request<EgressToken>(
      "POST",
      `/sandboxes/${this.info.id}/egress-tokens`,
      policy ?? {},
    );
  }

  /** List this sandbox's egress tokens (with policy + spend) and provider routes. */
  async listEgressTokens(): Promise<{ tokens: EgressTokenInfo[]; providers: EgressProvider[] }> {
    return this.client.request("GET", `/sandboxes/${this.info.id}/egress-tokens`);
  }

  /** Revoke a previously minted egress token. */
  async revokeEgressToken(token: string): Promise<void> {
    await this.client.request(
      "DELETE",
      `/sandboxes/${this.info.id}/egress-tokens/${token}`,
    );
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

  /**
   * Watch a path (recursively) for file changes, yielding events until the
   * returned generator is closed (e.g. `break` out of the loop).
   */
  async *watch(
    path = "/workspace",
    options: { intervalMs?: number } = {},
  ): AsyncGenerator<FileChangeEvent> {
    const params = new URLSearchParams({ path });
    if (options.intervalMs) params.set("interval", String(options.intervalMs));
    const res = await fetch(
      `${this.client.endpoint}/sandboxes/${this.info.id}/watch?${params}`,
      { headers: this.client.authHeaders() },
    );
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`sbx watch -> ${res.status}: ${text}`);
    }
    for await (const event of parseSSE<FileChangeEvent>(res.body)) {
      yield event;
    }
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
      { headers: this.client.authHeaders() },
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

/**
 * A persistent code-interpreter context. `runCode` executes in a kernel that
 * keeps its namespace across calls, so variables and imports persist.
 */
export class CodeContext {
  constructor(
    private readonly sandbox: Sandbox,
    private readonly info: CodeContextInfo,
  ) {}

  get contextId(): string {
    return this.info.contextId;
  }

  get language(): CodeLanguage {
    return this.info.language;
  }

  /** Run code in this context, sharing state with previous runs. */
  runCode(code: string, options: { timeoutMs?: number } = {}): Promise<CodeResult> {
    return this.sandbox.runCode(code, { context: this, timeoutMs: options.timeoutMs });
  }

  /** Destroy this context and its kernel. */
  async destroy(): Promise<void> {
    await this.sandbox._client.request(
      "DELETE",
      `/sandboxes/${this.sandbox.id}/code-contexts/${this.info.contextId}`,
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
  return envVar("SBX_ENDPOINT") ?? "http://127.0.0.1:4750";
}

function defaultApiKey(): string {
  return envVar("SBX_API_KEY") ?? "";
}

function envVar(name: string): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.[
    name
  ];
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
