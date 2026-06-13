import { randomBytes } from "node:crypto";
import type { SandboxRecord } from "./types.js";

/**
 * In-memory sandbox registry for Phase 0. This is swapped for embedded SQLite
 * (with the lifecycle FSM) in Phase 1 so state survives daemon restarts.
 */
export class SandboxStore {
  private byId = new Map<string, SandboxRecord>();

  static newId(): string {
    return randomBytes(6).toString("hex");
  }

  add(record: SandboxRecord): void {
    this.byId.set(record.id, record);
  }

  get(id: string): SandboxRecord | undefined {
    return this.byId.get(id);
  }

  remove(id: string): boolean {
    return this.byId.delete(id);
  }

  list(): SandboxRecord[] {
    return [...this.byId.values()].sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : -1,
    );
  }
}
