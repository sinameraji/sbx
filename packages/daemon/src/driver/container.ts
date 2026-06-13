import Docker from "dockerode";
import { PassThrough } from "node:stream";
import type { ExecEvent, ExecOptions } from "../types.js";
import type { CreateOptions, Driver } from "./types.js";

/**
 * Container driver — backs each sandbox with a long-lived OCI container via the
 * Docker Engine API. Maximum density and works identically on Linux and macOS
 * (Docker Desktop / colima / Apple `container`'s Docker-compatible endpoint).
 *
 * The container is named deterministically from the sandbox id and kept alive
 * (`sleep infinity` / image default) so the daemon can `exec` into it on demand
 * — the same model Docker exec gives us for free in Phase 0, standing in for the
 * dedicated in-sandbox agent that the microVM drivers will need.
 */
export class ContainerDriver implements Driver {
  readonly name = "container";
  private docker: Docker;
  private ensured = new Set<string>();

  constructor(docker?: Docker) {
    this.docker = docker ?? new Docker();
  }

  private containerName(id: string): string {
    return `sbx-${id}`;
  }

  async ping(): Promise<void> {
    await this.docker.ping();
  }

  /** Pull the image if it is not already present locally. */
  private async ensureImage(image: string): Promise<void> {
    if (this.ensured.has(image)) return;
    const images = await this.docker.listImages({
      filters: { reference: [image] },
    });
    if (images.length === 0) {
      await new Promise<void>((resolve, reject) => {
        this.docker.pull(image, (err: unknown, stream: NodeJS.ReadableStream) => {
          if (err) return reject(err);
          this.docker.modem.followProgress(stream, (doneErr: unknown) =>
            doneErr ? reject(doneErr) : resolve(),
          );
        });
      });
    }
    this.ensured.add(image);
  }

  async create(opts: CreateOptions): Promise<void> {
    await this.ensureImage(opts.image);
    const env = Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`);
    const container = await this.docker.createContainer({
      name: this.containerName(opts.id),
      Image: opts.image,
      // Keep the sandbox alive regardless of the image's default CMD.
      Entrypoint: ["/bin/sh", "-c"],
      Cmd: ["sleep infinity"],
      Env: env,
      Labels: { "sbx.managed": "true", "sbx.id": opts.id, ...opts.labels },
      WorkingDir: "/workspace",
      HostConfig: {
        // Phase 0 single-tenant defaults. Per-sandbox cgroup limits and egress
        // controls land alongside the scheduler in Phase 1/3.
        AutoRemove: false,
      },
    });
    await container.start();
  }

  async exec(
    id: string,
    command: string,
    opts: ExecOptions,
    onEvent: (e: ExecEvent) => void,
  ): Promise<number> {
    const container = this.docker.getContainer(this.containerName(id));
    const exec = await container.exec({
      Cmd: ["/bin/bash", "-lc", command],
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: opts.cwd ?? "/workspace",
      Env: Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`),
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdout.on("data", (chunk: Buffer) =>
      onEvent({ type: "stdout", data: chunk.toString("utf8") }),
    );
    stderr.on("data", (chunk: Buffer) =>
      onEvent({ type: "stderr", data: chunk.toString("utf8") }),
    );
    // Demultiplex Docker's combined stdout/stderr framing.
    this.docker.modem.demuxStream(stream, stdout, stderr);

    await new Promise<void>((resolve, reject) => {
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    stdout.end();
    stderr.end();

    const info = await exec.inspect();
    const exitCode = info.ExitCode ?? 0;
    onEvent({ type: "exit", exitCode });
    return exitCode;
  }

  async destroy(id: string): Promise<void> {
    const container = this.docker.getContainer(this.containerName(id));
    try {
      await container.remove({ force: true });
    } catch (err: unknown) {
      // Already gone is fine; rethrow anything else.
      if (!isNotFound(err)) throw err;
    }
  }
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "statusCode" in err &&
    (err as { statusCode?: number }).statusCode === 404
  );
}
