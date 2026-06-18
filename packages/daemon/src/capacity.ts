import type { Config } from "./config.js";
import type { HostInfo } from "./driver/types.js";
import type { SandboxStore } from "./store.js";

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

/**
 * Capacity meter + admission control. Each running sandbox reserves its memory
 * cap (or `defaultReservationMb` when uncapped); a new sandbox is admitted only
 * if it fits within the host's memory budget × overcommit. This is what keeps
 * "launch many sandboxes" from over-subscribing the host into OOM. Memory is the
 * hard gate (OOM kills); CPU is reported but not gated (it's throttled, not fatal).
 */
export class Capacity {
  /** Effective memory budget (MiB) after overcommit; 0 = unknown → admission off. */
  private readonly budgetMemMb: number;
  private readonly budgetCpus: number;

  constructor(
    private readonly store: SandboxStore,
    private readonly config: Config,
    host: HostInfo | null,
  ) {
    const baseMem = config.hostMemoryMb > 0 ? config.hostMemoryMb : (host?.memoryMb ?? 0);
    this.budgetMemMb = Math.floor(baseMem * (config.overcommit || 1));
    this.budgetCpus = config.hostCpus > 0 ? config.hostCpus : (host?.cpus ?? 0);
  }

  /** Admission is active only when enabled AND the budget is known. */
  get enforced(): boolean {
    return this.config.admission === "enforce" && this.budgetMemMb > 0;
  }

  /** Memory a sandbox reserves: its cap if set, else the default reservation. */
  private reservationMb(memoryMb?: number): number {
    return memoryMb && memoryMb > 0 ? memoryMb : this.config.defaultReservationMb;
  }

  private committed(): { mem: number; cpu: number } {
    let mem = 0;
    let cpu = 0;
    for (const r of this.store.list()) {
      if (r.status !== "running") continue; // paused/stopped free their compute
      mem += this.reservationMb(r.limits.memoryMb);
      cpu += r.limits.cpus && r.limits.cpus > 0 ? r.limits.cpus : 0;
    }
    return { mem, cpu };
  }

  /** Decide whether a new sandbox with `requestMemoryMb` can be admitted. */
  admit(requestMemoryMb?: number): { ok: true } | { ok: false; reason: string } {
    if (!this.enforced) return { ok: true };
    const { mem } = this.committed();
    const req = this.reservationMb(requestMemoryMb);
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
