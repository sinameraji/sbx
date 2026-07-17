/**
 * Firecracker density benchmark (plan §Verification 4): launch N small microVMs
 * on one host, prove they're all live and functional, and measure what density
 * actually costs — boot latency distribution, host memory per VM, teardown.
 *
 * Run on a KVM host: SBX_DENSITY_N=40 npm run bench:density
 * (image conversion must be cached — run smoke:fc once first).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { FirecrackerDriver } from "./driver/firecracker.js";

const N = Number(process.env.SBX_DENSITY_N ?? 40);
const CONCURRENCY = Number(process.env.SBX_DENSITY_CONCURRENCY ?? 4);
const MEM_MB = Number(process.env.SBX_DENSITY_MEM_MB ?? 256);

function hostAvailableMb(): number {
  const m = /MemAvailable:\s+(\d+)\s+kB/.exec(readFileSync("/proc/meminfo", "utf8"));
  return m ? Math.round(Number(m[1]) / 1024) : 0;
}

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

async function main(): Promise<number> {
  const stateDir = mkdtempSync(join(tmpdir(), "hotcell-density-"));
  const image = process.env.SBX_FC_SMOKE_IMAGE ?? "alpine:3.20";
  const driver = new FirecrackerDriver({
    fcBin: process.env.SBX_FC_BIN ?? "firecracker",
    kernel: process.env.SBX_FC_KERNEL ?? "helpers/hotcell-vz/guest/vmlinux-fc",
    rootfs: "helpers/hotcell-vz/guest/rootfs.img",
    stateDir,
    diskGb: 1,
    imageCacheDir: process.env.SBX_FC_IMAGE_CACHE ?? join(homedir(), ".sbx", "fc", "images"),
  });

  const ids = Array.from({ length: N }, (_, i) => `dens${String(i).padStart(3, "0")}`);
  const bootMs: number[] = [];
  const failures: string[] = [];
  const memBefore = hostAvailableMb();
  const t0 = Date.now();

  console.error(`[density] booting ${N} microVMs (${MEM_MB}MB cap each, concurrency ${CONCURRENCY})…`);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < ids.length) {
      const id = ids[next++];
      const t = Date.now();
      try {
        await driver.create({ id, image, env: {}, persist: true, limits: { memoryMb: MEM_MB, cpus: 1 } });
        bootMs.push(Date.now() - t);
      } catch (err) {
        failures.push(`${id}: ${(err as Error).message.slice(0, 120)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const bootWallS = ((Date.now() - t0) / 1000).toFixed(1);
  const memAfter = hostAvailableMb();

  // Every VM must be live and functional, not just booted.
  console.error("[density] exec in every VM…");
  let functional = 0;
  for (const id of ids) {
    if (failures.some((f) => f.startsWith(id))) continue;
    try {
      let out = "";
      const code = await driver.exec(id, "echo ok-$HOSTNAME", {}, (e) => {
        if (e.type === "stdout") out += e.data;
      });
      if (code === 0 && /ok-/.test(out)) functional++;
    } catch {
      failures.push(`${id}: exec failed post-boot`);
    }
  }

  const booted = bootMs.length;
  const perVmMb = booted > 0 ? Math.round((memBefore - memAfter) / booted) : 0;
  bootMs.sort((a, b) => a - b);
  console.log(`\ndensity-bench: ${booted}/${N} booted, ${functional} functional, ${failures.length} failures`);
  console.log(`  boot latency: p50 ${pct(bootMs, 50)}ms / p95 ${pct(bootMs, 95)}ms / max ${pct(bootMs, 100)}ms`);
  console.log(`  wall time to boot all: ${bootWallS}s`);
  console.log(`  host memory: ${memBefore}MB → ${memAfter}MB available (~${perVmMb}MB per live VM)`);
  for (const f of failures.slice(0, 5)) console.log(`  ✗ ${f}`);

  console.error("[density] tearing down…");
  const tDown = Date.now();
  for (const id of ids) await driver.destroy(id).catch(() => {});
  console.log(`  teardown: ${((Date.now() - tDown) / 1000).toFixed(1)}s; host available now ${hostAvailableMb()}MB`);
  rmSync(stateDir, { recursive: true, force: true });

  return failures.length === 0 && functional === booted && booted === N ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("density-bench FAILED:", err);
    process.exit(1);
  },
);
