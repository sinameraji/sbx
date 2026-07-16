import type { Driver } from "./driver/types.js";
import { log } from "./logger.js";
import type { SandboxStore } from "./store.js";
import type { SandboxRecord } from "./types.js";

/**
 * Lifecycle FSM transitions and the idle reaper.
 *
 *   created ─▶ running ──(idle > sleepAfterMs, or POST /pause)──▶ paused ──(any op)──▶ running
 *                  │                                                  │
 *                  └────────────── stop (manual) ────────────────────┴──▶ stopped ──(start)──▶ running
 *
 * A `paused` sandbox has had its compute freed but keeps its workspace, so the
 * next operation transparently resumes it. Pause comes in two strengths, picked
 * automatically per sandbox: on microVM drivers that support it, pause is a
 * **memory snapshot** (guest RAM + devices saved; background processes come back
 * alive on resume — nothing is lost by pausing); otherwise it's the cold
 * stop-with-volume (workspace survives, processes don't). A `stopped` sandbox is
 * user-intent and is never auto-resumed nor auto-paused.
 */

/**
 * Pause a running sandbox, preferring a memory snapshot (fast resume, live
 * state preserved) and falling back to a cold stop. Runtime state (tracked
 * processes, exposed ports) is only dropped on a cold pause — after a snapshot
 * pause it stays valid, because resume restores those processes live.
 */
export async function pauseSandbox(
  driver: Driver,
  store: SandboxStore,
  record: SandboxRecord,
): Promise<void> {
  let hibernated = false;
  if (typeof driver.snapshot === "function" && (driver.canSnapshot?.(record.id) ?? true)) {
    try {
      await driver.snapshot(record.id);
      hibernated = true;
    } catch (err) {
      log.warn("snapshot pause failed; falling back to a cold stop", {
        sandbox: record.id,
        error: String(err),
      });
    }
  }
  if (!hibernated) {
    await driver.stop(record.id);
    store.clearRuntimeState(record.id); // processes/ports died with the compute
  }
  record.status = "paused";
  store.add(record);
}

/**
 * Resume a paused (or stopped) sandbox: recreate its container, reattaching the
 * persistent volume, and mark it running + active.
 */
export async function resumeSandbox(
  driver: Driver,
  store: SandboxStore,
  record: SandboxRecord,
): Promise<void> {
  await driver.start({
    id: record.id,
    image: record.image,
    driver: record.driver,
    env: record.env,
    labels: record.labels,
    persist: record.persist,
    limits: record.limits,
  });
  record.status = "running";
  record.lastActivityAt = new Date().toISOString();
  store.add(record);
}

/**
 * Auto-pause sandboxes that have been idle past their `sleepAfterMs`. A sandbox
 * advertising a service (an exposed port) or running a tracked background
 * process is paused only when the driver can **memory-snapshot** it — the
 * processes come back alive, and the preview proxy wakes a paused sandbox on
 * inbound traffic, so nothing is lost by hibernating. On cold-pause drivers
 * such sandboxes are skipped, since pausing would kill that work.
 * Returns the ids that were paused.
 */
export async function reapIdle(
  driver: Driver,
  store: SandboxStore,
  now: number = Date.now(),
): Promise<string[]> {
  const paused: string[] = [];
  for (const record of store.list()) {
    if (record.status !== "running") continue;
    if (!record.sleepAfterMs || record.sleepAfterMs <= 0) continue;
    const hasService = store.listExposed(record.id).length > 0;
    const hasLiveProcs = store.listProcesses(record.id).some((p) => p.status === "running");
    if ((hasService || hasLiveProcs) && !driver.canSnapshot?.(record.id)) continue;
    if (now - Date.parse(record.lastActivityAt) < record.sleepAfterMs) continue;
    try {
      await pauseSandbox(driver, store, record);
      paused.push(record.id);
    } catch (err) {
      log.warn("reaper failed to pause sandbox", { sandbox: record.id, error: String(err) });
    }
  }
  return paused;
}

/**
 * Start the periodic idle reaper. Returns the interval handle (unref'd so it
 * won't keep the process alive); pass it to `clearInterval` on shutdown.
 */
export function startReaper(opts: {
  driver: Driver;
  store: SandboxStore;
  intervalMs: number;
}): NodeJS.Timeout {
  const { driver, store, intervalMs } = opts;
  const timer = setInterval(() => {
    reapIdle(driver, store)
      .then((ids) => {
        if (ids.length) log.info("auto-paused idle sandboxes", { ids });
      })
      .catch((err) => log.error("reaper error", { error: String(err) }));
  }, intervalMs);
  timer.unref?.();
  return timer;
}
