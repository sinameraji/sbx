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
}

export function loadConfig(): Config {
  return {
    host: process.env.SBX_HOST ?? "127.0.0.1",
    port: Number(process.env.SBX_PORT ?? 4750),
    defaultImage: process.env.SBX_IMAGE ?? "python:3.11-slim-bookworm",
    proxyHost: process.env.SBX_PROXY_HOST ?? "127.0.0.1",
    proxyPort: Number(process.env.SBX_PROXY_PORT ?? 4751),
    backupDir: process.env.SBX_BACKUP_DIR ?? join(homedir(), ".sbx", "backups"),
    dbPath: process.env.SBX_DB ?? join(homedir(), ".sbx", "state.db"),
    defaultSleepAfterMs: Number(process.env.SBX_SLEEP_AFTER_MS ?? 0),
    reapIntervalMs: Number(process.env.SBX_REAP_INTERVAL_MS ?? 15000),
  };
}

/**
 * Build the preview URL for an exposed port. Uses a `*.localhost` subdomain,
 * which browsers resolve to 127.0.0.1 with zero DNS/hosts config. Sandbox ids
 * are dash-free hex, so `<id>-<port>` is an unambiguous label.
 */
export function previewUrl(config: Config, sandboxId: string, port: number): string {
  return `http://${sandboxId}-${port}.localhost:${config.proxyPort}/`;
}
