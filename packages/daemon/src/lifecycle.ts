import type { Driver } from "./driver/types.js";
import { log } from "./logger.js";
import type { SandboxStore } from "./store.js";
import type { SandboxRecord } from "./types.js";

/**
 * Lifecycle FSM transitions and the idle reaper.
 *
 *   created ─▶ running ──(idle > sleepAfterMs)──▶ paused ──(any op)──▶ running
 *                  │                                  │
 *                  └────────── stop (manual) ─────────┴──▶ stopped ──(start)──▶ running
 *
 * A `paused` sandbox has had its container removed (compute freed) but keeps its
 * workspace volume, so the next operation transparently resumes it. A `stopped`
 * sandbox is user-intent and is never auto-resumed nor auto-paused.
 */

/**
 * Pause a running sandbox: stop its container (keeping the workspace volume) and
 * drop now-dead runtime state, marking it `paused` so the next operation
 * auto-resumes it.
 */
export async function pauseSandbox(
  driver: Driver,
  store: SandboxStore,
  record: SandboxRecord,
): Promise<void> {
  await driver.stop(record.id);
  store.clearRuntimeState(record.id);
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
    env: record.env,
    labels: record.labels,
    persist: record.persist,
  });
  record.status = "running";
  record.lastActivityAt = new Date().toISOString();
  store.add(record);
}

/**
 * Auto-pause sandboxes that have been idle past their `sleepAfterMs`. Sandboxes
 * advertising a service (an exposed port) or running a tracked background
 * process are skipped — pausing would kill that work, and the activity that
 * matters there flows through the proxy/process, not the control-plane API.
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
    if (store.listExposed(record.id).length > 0) continue;
    if (store.listProcesses(record.id).some((p) => p.status === "running")) continue;
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
