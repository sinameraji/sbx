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
}

export function loadConfig(): Config {
  return {
    host: process.env.SBX_HOST ?? "127.0.0.1",
    port: Number(process.env.SBX_PORT ?? 4750),
    defaultImage: process.env.SBX_IMAGE ?? "python:3.11-slim-bookworm",
    proxyHost: process.env.SBX_PROXY_HOST ?? "127.0.0.1",
    proxyPort: Number(process.env.SBX_PROXY_PORT ?? 4751),
    backupDir: process.env.SBX_BACKUP_DIR ?? join(homedir(), ".sbx", "backups"),
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
