import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "../logger.js";

/**
 * On-demand OCI→ext4 image cache for the Apple VZ driver. Converts an OCI image
 * (e.g. `python:3.11-slim`) into a VZ-bootable read-only rootfs — with the
 * in-sandbox agent injected as PID 1 — and caches it keyed by image name, so a
 * VZ sandbox runs the same image as the container driver. Also builds the blank
 * pre-formatted workspace template the driver clones per sandbox.
 *
 * Both artifacts are produced by helper shell scripts that use Docker's
 * `mkfs.ext4 -d` (populate-from-dir) — no privileges or loop-mounts, so it works
 * on macOS where there is no native `mke2fs`.
 */
export interface VzImageCacheOpts {
  /** The `helpers/sbx-vz` dir holding the converter scripts + staged guest files. */
  vzDir: string;
  /** Where converted rootfs images + the blank workspace template are cached. */
  cacheDir: string;
  /** Prebuilt Alpine base rootfs used for the sentinel image names (no conversion). */
  prebuiltRootfs: string;
  /** Target platform for the guest (default linux/arm64 — Apple silicon + VZ). */
  platform?: string;
}

// Image names that map to the prebuilt Alpine base rootfs instead of converting:
// the lightweight default for tests/dev that needs no Docker pull.
const SENTINELS = new Set(["base", "alpine", "sbx/base", "sbx/base:latest", "default"]);

export class VzImageCache {
  private inflight = new Map<string, Promise<string>>();

  constructor(private readonly o: VzImageCacheOpts) {}

  /** Resolve an OCI image to a VZ-bootable rootfs path, converting on cache miss. */
  async ensureRootfs(image: string): Promise<string> {
    if (SENTINELS.has(image)) return this.o.prebuiltRootfs;
    const out = join(this.o.cacheDir, `${this.sanitize(image)}.img`);
    if (existsSync(out)) return out;
    return this.once(out, async () => {
      mkdirSync(this.o.cacheDir, { recursive: true });
      log.info("converting OCI image to a VZ rootfs (first use; cached after)", { image, out });
      await this.run(join(this.o.vzDir, "convert-image.sh"), [
        image,
        out,
        join(this.o.vzDir, "guest", "sbx-agent"),
        join(this.o.vzDir, "guest", "init.sh"),
        this.platform,
      ]);
      return out;
    });
  }

  /** Path to a blank pre-formatted workspace image of `diskGb`, building on miss. */
  async ensureBlankWorkspace(diskGb: number): Promise<string> {
    const sizeMb = Math.max(64, Math.round(diskGb * 1024));
    const out = join(this.o.cacheDir, `blank-${sizeMb}m.img`);
    if (existsSync(out)) return out;
    return this.once(out, async () => {
      mkdirSync(this.o.cacheDir, { recursive: true });
      log.info("building the blank workspace template (first use; cached after)", { sizeMb, out });
      await this.run(join(this.o.vzDir, "build-blank-workspace.sh"), [out, String(sizeMb), this.platform]);
      return out;
    });
  }

  private get platform(): string {
    return this.o.platform ?? "linux/arm64";
  }

  /** Dedupe concurrent builds of the same artifact (key = output path). */
  private once(key: string, fn: () => Promise<string>): Promise<string> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private sanitize(image: string): string {
    return image.replace(/[^a-zA-Z0-9._-]+/g, "_");
  }

  private run(script: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn("bash", [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
      let err = "";
      child.stderr.on("data", (d: Buffer) => (err += d.toString()));
      child.stdout.resume();
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`${script} exited ${code}: ${err.trim().slice(-600)}`)),
      );
    });
  }
}
