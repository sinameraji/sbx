import Docker from "dockerode";
import { PassThrough } from "node:stream";
import type {
  ExecEvent,
  ExecOptions,
  FileInfo,
  ListFilesOptions,
  MkdirOptions,
  ReadFileOptions,
  WriteFileOptions,
} from "../types.js";
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

  /**
   * Run a non-interactive command and return its stdout as a UTF-8 string.
   * Throws if the command exits non-zero.
   */
  private async runAndCapture(id: string, command: string): Promise<string> {
    const container = this.docker.getContainer(this.containerName(id));
    const exec = await container.exec({
      Cmd: ["/bin/sh", "-c", command],
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: "/workspace",
    });

    const stream = await exec.start({ hijack: true, stdin: false });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let out = "";
    let err = "";
    stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    this.docker.modem.demuxStream(stream, stdout, stderr);

    await new Promise<void>((resolve, reject) => {
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    stdout.end();
    stderr.end();

    const info = await exec.inspect();
    if ((info.ExitCode ?? 0) !== 0) {
      throw new Error(err.trim() || `command failed with exit code ${info.ExitCode}`);
    }
    return out;
  }

  async writeFile(id: string, opts: WriteFileOptions): Promise<void> {
    const dir = opts.path.includes("/")
      ? opts.path.slice(0, opts.path.lastIndexOf("/"))
      : "/workspace";
    const encoded = Buffer.from(opts.content, "utf8").toString("base64");
    const mode = opts.mode ? `chmod ${opts.mode} ${shellEscape(opts.path)} && ` : "";
    const command = `mkdir -p ${shellEscape(dir)} && printf '%s' '${encoded}' | base64 -d > ${shellEscape(opts.path)} && ${mode}echo ok`;
    const output = await this.runAndCapture(id, command);
    if (output.trim() !== "ok") {
      throw new Error(`writeFile failed: ${output}`);
    }
  }

  async readFile(id: string, opts: ReadFileOptions): Promise<string> {
    return this.runAndCapture(id, `cat ${shellEscape(opts.path)}`);
  }

  async mkdir(id: string, opts: MkdirOptions): Promise<void> {
    const flag = opts.parents ? "-p" : "";
    await this.runAndCapture(id, `mkdir ${flag} ${shellEscape(opts.path)}`);
  }

  async listFiles(id: string, opts: ListFilesOptions): Promise<FileInfo[]> {
    const container = this.docker.getContainer(this.containerName(id));
    const exec = await container.exec({
      Cmd: [
        "/bin/sh",
        "-c",
        `find ${shellEscape(opts.path)} -maxdepth 1 -printf '%y|%p|%s|%TY-%Tm-%TdT%TH:%TM:%TS\\n'`,
      ],
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: "/workspace",
    });

    const stream = await exec.start({ hijack: true, stdin: false });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let out = "";
    let err = "";
    stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    this.docker.modem.demuxStream(stream, stdout, stderr);

    await new Promise<void>((resolve, reject) => {
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    stdout.end();
    stderr.end();

    const info = await exec.inspect();
    if ((info.ExitCode ?? 0) !== 0) {
      throw new Error(`listFiles failed: ${err || "unknown error"}`);
    }

    const lines = out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    return lines.map((line) => {
      const [type, rawPath, size, mtime] = line.split("|");
      const path = rawPath!;
      const name = path.slice(path.lastIndexOf("/") + 1);
      return {
        path,
        name,
        isDirectory: type === "d",
        size: Number(size ?? 0),
        modifiedAt: mtime ?? new Date().toISOString(),
      };
    });
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

function shellEscape(value: string): string {
  // Use single quotes and escape any embedded single quotes.
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}
