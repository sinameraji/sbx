import { spawn } from "node:child_process";
import { UnsupportedDriver } from "./unsupported.js";
import type { HostInfo } from "./types.js";

/**
 * Apple Virtualization.framework microVM driver (Phase 3, macOS). Gives each
 * sandbox a VM-grade isolated guest on Apple silicon behind the same `Driver`
 * interface, with the in-sandbox agent reached over vsock. Node can't call
 * Virtualization.framework directly, so a signed Swift helper (`sbx-vz`, built by
 * `npm run build:vz`) does the native work and the driver drives it over a
 * line-delimited JSON-RPC on stdio.
 *
 * **M0 (this):** `ping` (is VZ available via the helper) + `hostInfo` (real
 * mem/cpus) — so `SBX_DRIVER=applevz` starts the daemon and the capacity meter
 * works. VM lifecycle, the vsock agent, and the rest of the `Driver` surface land
 * in M1+ (see `docs/plan.md` Appendix A); until then those methods still report
 * "not implemented" via `UnsupportedDriver`.
 */
export class AppleVzDriver extends UnsupportedDriver {
  readonly name = "applevz";

  constructor(private readonly helperPath: string) {
    super();
  }

  async ping(): Promise<void> {
    let res: HelperResponse;
    try {
      res = await this.callHelper("probe");
    } catch (err) {
      throw new Error(
        `applevz: cannot run the sbx-vz helper at "${this.helperPath}" ` +
          `(${(err as Error).message}). Build it with 'npm run build:vz', or set ` +
          `SBX_VZ_HELPER_PATH to the signed binary.`,
      );
    }
    const result = res.result as { available?: boolean; reason?: string } | undefined;
    if (!res.ok || !result?.available) {
      throw new Error(
        `applevz: Virtualization.framework not available: ${result?.reason || res.error || "unknown"}`,
      );
    }
  }

  async hostInfo(): Promise<HostInfo> {
    const res = await this.callHelper("hostInfo");
    if (!res.ok) throw new Error(`applevz hostInfo failed: ${res.error ?? "unknown"}`);
    const r = res.result as { memoryMb?: number; cpus?: number };
    return { memoryMb: Number(r?.memoryMb) || 0, cpus: Number(r?.cpus) || 0 };
  }

  /**
   * One-shot JSON-RPC to the helper: spawn, write one request line, read the first
   * response line, done. M1+ replaces this with a long-lived helper process whose
   * vsock streams are multiplexed; for the stateless probe/hostInfo calls a fresh
   * process per call is simplest and has no shared state to corrupt.
   */
  private callHelper(method: string, params: unknown = {}): Promise<HelperResponse> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.helperPath, [], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr.on("data", (d: Buffer) => (err += d.toString()));
      child.on("error", reject); // ENOENT (missing binary), EACCES, …
      child.on("close", () => {
        const line = out.split("\n").find((l) => l.trim());
        if (!line) return reject(new Error(err.trim() || "no response from sbx-vz"));
        try {
          resolve(JSON.parse(line) as HelperResponse);
        } catch {
          reject(new Error(`bad sbx-vz response: ${line}`));
        }
      });
      child.stdin.write(JSON.stringify({ id: 1, method, params }) + "\n");
      child.stdin.end();
    });
  }
}

interface HelperResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}
