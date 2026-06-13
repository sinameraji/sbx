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
}

export function loadConfig(): Config {
  return {
    host: process.env.SBX_HOST ?? "127.0.0.1",
    port: Number(process.env.SBX_PORT ?? 4750),
    defaultImage: process.env.SBX_IMAGE ?? "python:3.11-slim-bookworm",
  };
}
