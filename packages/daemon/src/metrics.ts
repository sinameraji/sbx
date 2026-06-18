import type { Driver } from "./driver/types.js";
import { log } from "./logger.js";
import type { SandboxStore } from "./store.js";
import type { SandboxUsage } from "./types.js";

/** One point in a sandbox's live-metrics history (for dashboard sparklines). */
export interface MetricSample {
  at: string;
  cpuPercent: number;
  memBytes: number;
  netRxBytes: number;
  netTxBytes: number;
  pids: number;
}

/**
 * In-memory ring of recent live samples per sandbox — backs the dashboard's CPU
 * and memory sparklines (`GET /sandboxes/:id/metrics/history`). Deliberately not
 * persisted: it's a short rolling window, cheap to rebuild after a restart.
 */
export class MetricsHistory {
  private readonly byId = new Map<string, MetricSample[]>();

  constructor(private readonly cap = 60) {}

  record(id: string, sample: MetricSample): void {
    let arr = this.byId.get(id);
    if (!arr) {
      arr = [];
      this.byId.set(id, arr);
    }
    arr.push(sample);
    while (arr.length > this.cap) arr.shift();
  }

  get(id: string): MetricSample[] {
    return this.byId.get(id) ?? [];
  }

  /** Most-recently-sampled resident memory (bytes) for a sandbox, if any. */
  latestMemBytes(id: string): number | undefined {
    const arr = this.byId.get(id);
    return arr && arr.length ? arr[arr.length - 1].memBytes : undefined;
  }

  clear(id: string): void {
    this.byId.delete(id);
  }
}

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
  history?: MetricsHistory,
  now: number = Date.now(),
): Promise<void> {
  for (const record of store.list()) {
    if (record.status !== "running") continue;
    try {
      const s = await driver.stats(record.id);
      const prev = record.usage;

      history?.record(record.id, {
        at: new Date(now).toISOString(),
        cpuPercent: s.cpuPercent,
        memBytes: s.memBytes,
        netRxBytes: s.netRxBytes,
        netTxBytes: s.netTxBytes,
        pids: s.pids,
      });

      let cpuDeltaNs = s.cpuTotalUsageNs - prev.lastCpuTotalNs;
      if (cpuDeltaNs < 0) cpuDeltaNs = s.cpuTotalUsageNs; // container recreated

      const lastMs = prev.lastSampledAt ? Date.parse(prev.lastSampledAt) : now;
      const dtSeconds = Math.max(0, (now - lastMs) / 1000);

      const next: SandboxUsage = {
        // egress + provider counters are metered by the proxies, not the sampler.
        ...prev,
        cpuSeconds: prev.cpuSeconds + cpuDeltaNs / 1e9,
        memByteSeconds: prev.memByteSeconds + s.memBytes * dtSeconds,
        lastCpuTotalNs: s.cpuTotalUsageNs,
        lastSampledAt: new Date(now).toISOString(),
      };
      store.setUsage(record.id, next);
    } catch (err) {
      // A sandbox can race a stop/destroy mid-tick; skip it and move on.
      log.debug("metrics sample failed", { sandbox: record.id, error: String(err) });
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
  history?: MetricsHistory;
}): NodeJS.Timeout {
  const { driver, store, intervalMs, history } = opts;
  const timer = setInterval(() => {
    sampleUsage(driver, store, history).catch((err) =>
      log.error("sampler error", { error: String(err) }),
    );
  }, intervalMs);
  timer.unref?.();
  return timer;
}
