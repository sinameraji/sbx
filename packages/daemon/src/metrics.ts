import type { Driver } from "./driver/types.js";
import type { SandboxStore } from "./store.js";
import type { SandboxUsage } from "./types.js";

/**
 * In-process metrics sampler — the cAdvisor-style collection the plan calls for,
 * minus a per-sandbox sidecar. On each tick it snapshots every running sandbox's
 * stats and integrates cumulative usage:
 *   - CPU: the delta of the container's cumulative CPU-ns (reset-safe — a drop
 *     means the container was recreated, so the new total is counted from zero).
 *   - Memory: current resident bytes × wall-clock seconds since the last sample.
 * Totals are persisted via `store.setUsage`, so they survive a daemon restart.
 */
export async function sampleUsage(
  driver: Driver,
  store: SandboxStore,
  now: number = Date.now(),
): Promise<void> {
  for (const record of store.list()) {
    if (record.status !== "running") continue;
    try {
      const s = await driver.stats(record.id);
      const prev = record.usage;

      let cpuDeltaNs = s.cpuTotalUsageNs - prev.lastCpuTotalNs;
      if (cpuDeltaNs < 0) cpuDeltaNs = s.cpuTotalUsageNs; // container recreated

      const lastMs = prev.lastSampledAt ? Date.parse(prev.lastSampledAt) : now;
      const dtSeconds = Math.max(0, (now - lastMs) / 1000);

      const next: SandboxUsage = {
        cpuSeconds: prev.cpuSeconds + cpuDeltaNs / 1e9,
        memByteSeconds: prev.memByteSeconds + s.memBytes * dtSeconds,
        lastCpuTotalNs: s.cpuTotalUsageNs,
        lastSampledAt: new Date(now).toISOString(),
      };
      store.setUsage(record.id, next);
    } catch (err) {
      // A sandbox can race a stop/destroy mid-tick; skip it and move on.
      console.error(`[sbd] metrics sample failed for ${record.id}: ${String(err)}`);
    }
  }
}

/**
 * Start the periodic metrics sampler. Returns the interval handle (unref'd so it
 * won't keep the process alive); pass it to `clearInterval` on shutdown.
 */
export function startSampler(opts: {
  driver: Driver;
  store: SandboxStore;
  intervalMs: number;
}): NodeJS.Timeout {
  const { driver, store, intervalMs } = opts;
  const timer = setInterval(() => {
    sampleUsage(driver, store).catch((err) =>
      console.error(`[sbd] sampler error: ${String(err)}`),
    );
  }, intervalMs);
  timer.unref?.();
  return timer;
}
