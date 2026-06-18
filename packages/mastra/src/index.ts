/**
 * @sbx/mastra — a Mastra Workspace sandbox provider backed by self-hosted sbx.
 *
 * Drop it in alongside Mastra's built-in providers (E2B, Modal, …) to run a
 * Mastra agent's commands inside an sbx sandbox on your own hardware, with the
 * LLM egress gateway, per-agent cost/observability, resource caps, and a repo
 * cloned in:
 *
 *   import { Workspace, Agent } from "@mastra/core";
 *   import { SbxSandbox } from "@sbx/mastra";
 *
 *   const agent = new Agent({
 *     name: "coder",
 *     model: "openai/gpt-5",
 *     workspace: new Workspace({
 *       sandbox: new SbxSandbox({ repo: "https://github.com/me/app", egress: true }),
 *     }),
 *   });
 *
 * Only the `@mastra/core` *types* are imported (`import type`), so this package
 * has no runtime dependency on `@mastra/core` — the consumer supplies it as a
 * peer (use a version published after the 2026-06-17 supply-chain remediation).
 */
import { SbxClient, type Sandbox } from "@sbx/sdk";
import type {
  CommandResult,
  ExecuteCommandOptions,
  ProviderStatus,
  SandboxInfo,
  WorkspaceSandbox,
} from "@mastra/core/workspace";

export interface SbxSandboxOptions {
  /** sbx daemon endpoint (default: `SBX_ENDPOINT` or http://127.0.0.1:4750). */
  endpoint?: string;
  /** API key for an auth-enabled daemon (default: `SBX_API_KEY`). */
  apiKey?: string;
  /** Image for the sandbox (default: the daemon's `SBX_IMAGE`; use one with git/node). */
  image?: string;
  /** Wire the sandbox to the egress LLM gateway (injects provider base-URL + key env). */
  egress?: boolean;
  /** Git repo cloned into `/workspace` at create (great for coding agents). */
  repo?: string;
  /** Branch/tag to check out when cloning `repo`. */
  repoRef?: string;
  /** Shell commands run once at create (e.g. install a CLI harness). */
  setup?: string[];
  /** Hard resource caps. */
  memoryMb?: number;
  cpus?: number;
  pidsLimit?: number;
  /** Attach to an existing sandbox by id instead of creating one. */
  sandboxId?: string;
}

/**
 * Mastra `WorkspaceSandbox` provider backed by sbx. Implements the lifecycle
 * (`start`/`stop`/`destroy`/`getInfo`) and `executeCommand`; the optional
 * process-manager / mount surface is left unimplemented (Mastra degrades
 * gracefully — those tools simply aren't exposed).
 */
export class SbxSandbox implements WorkspaceSandbox {
  readonly name = "sbx";
  readonly provider = "sbx";
  status: ProviderStatus = "pending";
  error?: string;

  private readonly client: SbxClient;
  private readonly opts: SbxSandboxOptions;
  private sandbox?: Sandbox;
  private starting?: Promise<void>;
  private readonly createdAt = new Date();
  private _id = "";

  constructor(opts: SbxSandboxOptions = {}) {
    this.opts = opts;
    this.client = new SbxClient({ endpoint: opts.endpoint, apiKey: opts.apiKey });
  }

  /** Sandbox id (empty until `start()` has run). */
  get id(): string {
    return this._id;
  }

  /** Create (or attach to) the sbx sandbox. Idempotent + concurrency-safe. */
  async start(): Promise<void> {
    if (this.sandbox) return;
    if (!this.starting) this.starting = this.doStart();
    await this.starting;
  }

  private async doStart(): Promise<void> {
    this.status = "starting";
    try {
      this.sandbox = this.opts.sandboxId
        ? await this.client.getSandbox(this.opts.sandboxId)
        : await this.client.getSandbox(undefined, {
            image: this.opts.image,
            egress: this.opts.egress,
            repo: this.opts.repo,
            repoRef: this.opts.repoRef,
            setup: this.opts.setup,
            memoryMb: this.opts.memoryMb,
            cpus: this.opts.cpus,
            pidsLimit: this.opts.pidsLimit,
          });
      this._id = this.sandbox.id;
      this.status = "running";
    } catch (err) {
      this.status = "error";
      this.error = err instanceof Error ? err.message : String(err);
      this.starting = undefined; // allow a retry
      throw err;
    }
  }

  private async ensureStarted(): Promise<Sandbox> {
    if (!this.sandbox) await this.start();
    return this.sandbox!;
  }

  /** Pause the sandbox (freed compute; workspace volume kept). */
  async stop(): Promise<void> {
    if (!this.sandbox) return;
    await this.sandbox.stop();
    this.status = "stopped";
  }

  /** Permanently destroy the sandbox and its volume. */
  async destroy(): Promise<void> {
    if (!this.sandbox) return;
    this.status = "destroying";
    try {
      await this.sandbox.destroy();
    } finally {
      this.sandbox = undefined;
      this.starting = undefined;
      this.status = "destroyed";
    }
  }

  getInstructions(): string {
    return (
      "You have a Linux sandbox with a persistent /workspace directory (bash, " +
      "git, and common tooling). Run shell commands with the execute-command " +
      "tool; the working directory is /workspace. Edit files there and use git " +
      "as normal. Network and any configured LLM provider are available."
    );
  }

  async getInfo(): Promise<SandboxInfo> {
    const info: SandboxInfo = {
      id: this._id,
      name: this.name,
      provider: this.provider,
      status: this.status,
      createdAt: this.createdAt,
    };
    if (this.sandbox) {
      try {
        const m = await this.sandbox.metrics();
        if (m.live) {
          info.resources = {
            memoryUsedMB: Math.round(m.live.memBytes / (1024 * 1024)),
            memoryMB: m.live.memLimitBytes
              ? Math.round(m.live.memLimitBytes / (1024 * 1024))
              : undefined,
            cpuCores: m.live.onlineCpus,
            cpuPercent: Math.round(m.live.cpuPercent),
          };
        }
        info.metadata = { cost: m.cost.total, usage: m.usage };
      } catch {
        // metrics are best-effort introspection
      }
    }
    return info;
  }

  async executeCommand(
    command: string,
    args: string[] = [],
    options: ExecuteCommandOptions = {},
  ): Promise<CommandResult> {
    const sandbox = await this.ensureStarted();
    const full = args.length ? `${command} ${args.map(shellQuote).join(" ")}` : command;

    const env: Record<string, string> | undefined = options.env
      ? Object.fromEntries(
          Object.entries(options.env).filter(([, v]) => v != null) as [string, string][],
        )
      : undefined;

    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    const run = (async () => {
      const res = await sandbox.exec(full, {
        cwd: options.cwd,
        env,
        onOutput: (stream, data) => {
          if (stream === "stdout") {
            stdout += data;
            options.onStdout?.(data);
          } else {
            stderr += data;
            options.onStderr?.(data);
          }
        },
      });
      exitCode = res.exitCode;
    })();

    const timedOut = await raceTimeout(run, options.timeout, options.abortSignal);

    return {
      command,
      args,
      success: !timedOut && exitCode === 0,
      exitCode: timedOut ? 124 : exitCode,
      stdout,
      stderr,
      executionTimeMs: Date.now() - startedAt,
      timedOut,
    };
  }
}

/** Resolve `run` but give up after `timeoutMs` (or on abort). Returns whether it timed out. */
async function raceTimeout(
  run: Promise<void>,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!timeoutMs && !signal) {
    await run;
    return false;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const guards: Promise<"timeout">[] = [];
    if (timeoutMs && timeoutMs > 0) {
      guards.push(
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), timeoutMs);
        }),
      );
    }
    if (signal) {
      guards.push(
        new Promise<"timeout">((resolve) => {
          if (signal.aborted) return resolve("timeout");
          onAbort = () => resolve("timeout");
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      );
    }
    const result = await Promise.race([run.then(() => "done" as const), ...guards]);
    return result === "timeout";
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Minimal POSIX single-quote shell escaping for a command argument. */
function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
