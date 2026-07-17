import type { Config } from "./config.js";
import type { HostInfo } from "./driver/types.js";
import type { MetricsHistory } from "./metrics.js";
import type { SandboxStore } from "./store.js";

const MIB = 1024 * 1024;

/** Host capacity + what's currently committed by running sandboxes. */
export interface CapacitySnapshot {
  /** Whether admission control is actively rejecting over-budget creates. */
  enforced: boolean;
  overcommit: number;
  defaultReservationMb: number;
  memory: { budgetMb: number; committedMb: number; availableMb: number };
  cpu: { budget: number; committed: number; available: number };
  running: number;
  /** Approx. number of additional default-reservation sandboxes that still fit. */
  fits: number;
}

/** An admission refusal, thrown by gated paths (resume/start) so callers can 503. */
export class CapacityError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
  }
}

/**
 * Capacity meter + admission control — **usage-based**, so light and heavy
 * sandboxes size themselves without anyone declaring a tier:
 *   - a **capped** sandbox reserves its hard cap (exact, kernel-enforced ceiling);
 *   - an **uncapped** sandbox reserves `max(its most-recent sampled RSS, floor)` —
 *     measured, not guessed, so an idle box packs many while a busy box admits few.
 * The `floor` (`SBX_DEFAULT_RESERVATION_MB`) covers a just-started sandbox that
 * hasn't grown (or been sampled) yet. A new sandbox is admitted only if it fits
 * within the host memory budget × overcommit. Memory is the hard gate (OOM kills);
 * CPU is reported but not gated (throttled, not fatal). Without a metrics history
 * (e.g. tests) it falls back to floor-only accounting.
 */
export class Capacity {
  /** Effective memory budget (MiB) after overcommit; 0 = unknown → admission off. */
  private readonly budgetMemMb: number;
  private readonly budgetCpus: number;
  /** MiB reserved by in-flight admissions (create/resume) not yet `running`. */
  private pendingMb = 0;

  constructor(
    private readonly store: SandboxStore,
    private readonly config: Config,
    host: HostInfo | null,
    private readonly history?: MetricsHistory,
  ) {
    const baseMem = config.hostMemoryMb > 0 ? config.hostMemoryMb : (host?.memoryMb ?? 0);
    this.budgetMemMb = Math.floor(baseMem * (config.overcommit || 1));
    this.budgetCpus = config.hostCpus > 0 ? config.hostCpus : (host?.cpus ?? 0);
  }

  /** Admission is active only when enabled AND the budget is known. */
  get enforced(): boolean {
    return this.config.admission === "enforce" && this.budgetMemMb > 0;
  }

  /** The floor counted for an uncapped/just-started sandbox. */
  private get floorMb(): number {
    return this.config.defaultReservationMb;
  }

  /**
   * Memory an existing running sandbox is charged: its hard cap when set
   * (the guaranteed ceiling), else `max(measured RSS, floor)`.
   */
  private reservationFor(id: string, memoryCapMb?: number): number {
    if (memoryCapMb && memoryCapMb > 0) return memoryCapMb;
    const rssBytes = this.history?.latestMemBytes(id) ?? 0;
    return Math.max(Math.round(rssBytes / MIB), this.floorMb);
  }

  private committed(): { mem: number; cpu: number } {
    let mem = 0;
    let cpu = 0;
    for (const r of this.store.list()) {
      if (r.status !== "running") continue; // paused/stopped free their compute
      mem += this.reservationFor(r.id, r.limits.memoryMb);
      cpu += r.limits.cpus && r.limits.cpus > 0 ? r.limits.cpus : 0;
    }
    return { mem, cpu };
  }

  /** Decide whether a new sandbox with `requestMemoryMb` can be admitted. */
  admit(requestMemoryMb?: number): { ok: true } | { ok: false; reason: string } {
    if (!this.enforced) return { ok: true };
    const { mem } = this.committed();
    // A new sandbox hasn't run yet: charge its cap if set, else the floor.
    const req = requestMemoryMb && requestMemoryMb > 0 ? requestMemoryMb : this.floorMb;
    if (mem + req > this.budgetMemMb) {
      return {
        ok: false,
        reason:
          `host memory budget exhausted: ${mem}/${this.budgetMemMb} MiB committed, ` +
          `this sandbox needs ${req} MiB. Free a sandbox, set a smaller --memory, ` +
          `or raise SBX_OVERCOMMIT / SBX_HOST_MEMORY_MB.`,
      };
    }
    return { ok: true };
  }

  /**
   * `admit()` plus a pending reservation: the request is counted against the
   * budget until `release()` is called, so concurrent admissions can't all pass
   * the same check before any of them shows up as `running`. Call `release()`
   * once the sandbox's record is written as running (it's then counted by
   * `committed()`) or when the start fails.
   */
  admitAndReserve(
    requestMemoryMb?: number,
  ): { ok: true; release: () => void } | { ok: false; reason: string } {
    if (!this.enforced) return { ok: true, release: () => {} };
    const { mem } = this.committed();
    // A new sandbox hasn't run yet: charge its cap if set, else the floor.
    const req = requestMemoryMb && requestMemoryMb > 0 ? requestMemoryMb : this.floorMb;
    if (mem + this.pendingMb + req > this.budgetMemMb) {
      return {
        ok: false,
        reason:
          `host memory budget exhausted: ${mem + this.pendingMb}/${this.budgetMemMb} MiB committed, ` +
          `this sandbox needs ${req} MiB. Free a sandbox, set a smaller --memory, ` +
          `or raise SBX_OVERCOMMIT / SBX_HOST_MEMORY_MB.`,
      };
    }
    this.pendingMb += req;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.pendingMb -= req;
      },
    };
  }

  snapshot(): CapacitySnapshot {
    const { mem, cpu } = this.committed();
    const availableMb = Math.max(0, this.budgetMemMb - mem);
    return {
      enforced: this.enforced,
      overcommit: this.config.overcommit || 1,
      defaultReservationMb: this.config.defaultReservationMb,
      memory: { budgetMb: this.budgetMemMb, committedMb: mem, availableMb },
      cpu: {
        budget: this.budgetCpus,
        committed: Math.round(cpu * 100) / 100,
        available: Math.max(0, Math.round((this.budgetCpus - cpu) * 100) / 100),
      },
      running: this.store.list().filter((r) => r.status === "running").length,
      fits:
        this.config.defaultReservationMb > 0
          ? Math.floor(availableMb / this.config.defaultReservationMb)
          : 0,
    };
  }
}
