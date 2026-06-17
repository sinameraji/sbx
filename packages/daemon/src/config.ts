import { homedir } from "node:os";
import { join } from "node:path";

// Daemon configuration, all overridable via environment variables.
export interface Config {
  host: string;
  port: number;
  /**
   * Default OCI image for new sandboxes. Defaults to a small Debian-based
   * Python image (ships /bin/bash + python3) so the vertical slice works with
   * zero local image builds. Build images/base and set SBX_IMAGE=sbx/base:latest
   * for the richer toolset (Node 20, git, ripgrep, …).
   */
  defaultImage: string;
  /** Bind host for the preview-URL reverse proxy. */
  proxyHost: string;
  /** Port for the preview-URL reverse proxy (separate from the REST API). */
  proxyPort: number;
  /** Bind host for the egress credential proxy (LLM gateway). */
  egressHost: string;
  /** Port for the egress credential proxy. `0` disables it. */
  egressPort: number;
  /**
   * Hostname advertised in egress base URLs returned to clients. Sandboxes reach
   * the daemon host through this name, so on Docker Desktop it defaults to
   * `host.docker.internal`. Set to a LAN IP/DNS name for remote sandboxes.
   */
  egressAdvertiseHost: string;
  /**
   * Provider API keys, held on the daemon host and injected into outbound calls
   * so they never live inside a sandbox. Keyed by lower-case provider name
   * (`openai`, `anthropic`, `openrouter`). A provider's gateway route exists only
   * when its key is present here. Sourced from `SBX_PROVIDER_KEY_<NAME>` env vars.
   */
  providerKeys: Record<string, string>;
  /** Host directory where sandbox backup tarballs + metadata are stored. */
  backupDir: string;
  /**
   * Path to the embedded SQLite database holding durable control-plane state
   * (sandbox/process/session/context/exposed-port records). Survives daemon
   * restarts. Set to `:memory:` for an ephemeral, in-process store.
   */
  dbPath: string;
  /**
   * Default idle timeout (ms) applied to new sandboxes that don't specify their
   * own `sleepAfter`. The reaper auto-pauses a sandbox after this long without
   * activity. `0` (the default) disables auto-pause.
   */
  defaultSleepAfterMs: number;
  /** How often (ms) the idle reaper scans for sandboxes to auto-pause. */
  reapIntervalMs: number;
  /** How often (ms) the metrics sampler integrates per-sandbox usage. `0` disables it. */
  metricsIntervalMs: number;
  /** Cost-meter rate: currency units per vCPU-hour. */
  costCpuPerHour: number;
  /** Cost-meter rate: currency units per GB-hour of memory. */
  costMemGbPerHour: number;
  /** Cost-meter rate: currency units per GB of preview-proxy egress. */
  costEgressPerGb: number;
  /** Minimum level emitted by the structured logger. */
  logLevel: LogLevel;
  /** Log encoding: `json` (one JSON object per line) or `pretty` (human). */
  logFormat: LogFormat;
  /**
   * API key required on every REST call (except `/healthz` and the dashboard
   * HTML). Empty string (the default) disables auth — loopback, single-tenant.
   */
  apiKey: string;
  /**
   * OTLP/HTTP traces endpoint (e.g. `http://localhost:4318`). When set, spans are
   * batch-exported to `<endpoint>/v1/traces`. Empty disables export; recent spans
   * are always kept in-memory for `GET /traces` regardless.
   */
  otlpEndpoint: string;
  /** How many of the most recent metric samples per sandbox to retain in memory. */
  metricsHistory: number;
  /** How many of the most recent finished spans to retain in memory for `/traces`. */
  traceRing: number;
}

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFormat = "json" | "pretty";

export function loadConfig(): Config {
  return {
    host: process.env.SBX_HOST ?? "127.0.0.1",
    port: Number(process.env.SBX_PORT ?? 4750),
    defaultImage: process.env.SBX_IMAGE ?? "python:3.11-slim-bookworm",
    proxyHost: process.env.SBX_PROXY_HOST ?? "127.0.0.1",
    proxyPort: Number(process.env.SBX_PROXY_PORT ?? 4751),
    egressHost: process.env.SBX_EGRESS_HOST ?? "127.0.0.1",
    egressPort: Number(process.env.SBX_EGRESS_PORT ?? 4752),
    egressAdvertiseHost: process.env.SBX_EGRESS_ADVERTISE_HOST ?? "host.docker.internal",
    providerKeys: loadProviderKeys(),
    backupDir: process.env.SBX_BACKUP_DIR ?? join(homedir(), ".sbx", "backups"),
    dbPath: process.env.SBX_DB ?? join(homedir(), ".sbx", "state.db"),
    defaultSleepAfterMs: Number(process.env.SBX_SLEEP_AFTER_MS ?? 0),
    reapIntervalMs: Number(process.env.SBX_REAP_INTERVAL_MS ?? 15000),
    metricsIntervalMs: Number(process.env.SBX_METRICS_INTERVAL_MS ?? 10000),
    costCpuPerHour: Number(process.env.SBX_COST_CPU_PER_HOUR ?? 0.05),
    costMemGbPerHour: Number(process.env.SBX_COST_MEM_GB_PER_HOUR ?? 0.005),
    costEgressPerGb: Number(process.env.SBX_COST_EGRESS_PER_GB ?? 0.01),
    logLevel: parseLogLevel(process.env.SBX_LOG_LEVEL),
    logFormat: process.env.SBX_LOG_FORMAT === "json" ? "json" : "pretty",
    apiKey: process.env.SBX_API_KEY ?? "",
    otlpEndpoint: (process.env.SBX_OTLP_ENDPOINT ?? "").replace(/\/$/, ""),
    metricsHistory: Number(process.env.SBX_METRICS_HISTORY ?? 60),
    traceRing: Number(process.env.SBX_TRACE_RING ?? 200),
  };
}

/** Collect provider keys from `SBX_PROVIDER_KEY_<NAME>` env vars (name lowercased). */
function loadProviderKeys(): Record<string, string> {
  const keys: Record<string, string> = {};
  const prefix = "SBX_PROVIDER_KEY_";
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith(prefix) && value) {
      keys[name.slice(prefix.length).toLowerCase()] = value;
    }
  }
  return keys;
}

function parseLogLevel(value: string | undefined): LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error"
    ? value
    : "info";
}

/**
 * Build the preview URL for an exposed port. Uses a `*.localhost` subdomain,
 * which browsers resolve to 127.0.0.1 with zero DNS/hosts config. Sandbox ids
 * are dash-free hex, so `<id>-<port>` is an unambiguous label.
 */
export function previewUrl(config: Config, sandboxId: string, port: number): string {
  return `http://${sandboxId}-${port}.localhost:${config.proxyPort}/`;
}
