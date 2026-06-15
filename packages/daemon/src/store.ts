import { randomBytes } from "node:crypto";
import type {
  ExposedPort,
  ProcessInfo,
  SandboxRecord,
  SessionInfo,
} from "./types.js";

/** Where a preview route points, resolved by the proxy on each request. */
export interface RouteTarget {
  sandboxId: string;
  port: number;
  token: string | null;
}

/**
 * In-memory sandbox registry for Phase 0/1. Alongside the sandbox records it
 * tracks background processes and exposed preview ports. This is swapped for
 * embedded SQLite (with the lifecycle FSM) later so state survives restarts.
 */
export class SandboxStore {
  private byId = new Map<string, SandboxRecord>();
  // sandboxId -> procId -> process
  private procs = new Map<string, Map<string, ProcessInfo>>();
  // sandboxId -> port -> exposed port
  private exposed = new Map<string, Map<number, ExposedPort>>();
  // exposeId -> route target (O(1) lookup for the proxy)
  private routes = new Map<string, RouteTarget>();
  // sandboxId -> sessionId -> session
  private sessions = new Map<string, Map<string, SessionInfo>>();

  static newId(): string {
    return randomBytes(6).toString("hex");
  }

  static newProcId(): string {
    return randomBytes(4).toString("hex");
  }

  static newSessionId(): string {
    return randomBytes(4).toString("hex");
  }

  static newBackupId(): string {
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

  // --- processes -----------------------------------------------------------

  addProcess(sandboxId: string, proc: ProcessInfo): void {
    let map = this.procs.get(sandboxId);
    if (!map) {
      map = new Map();
      this.procs.set(sandboxId, map);
    }
    map.set(proc.procId, proc);
  }

  getProcess(sandboxId: string, procId: string): ProcessInfo | undefined {
    return this.procs.get(sandboxId)?.get(procId);
  }

  listProcesses(sandboxId: string): ProcessInfo[] {
    return [...(this.procs.get(sandboxId)?.values() ?? [])].sort((a, b) =>
      a.startedAt < b.startedAt ? 1 : -1,
    );
  }

  // --- exposed ports -------------------------------------------------------

  addExposed(sandboxId: string, exposed: ExposedPort): void {
    let map = this.exposed.get(sandboxId);
    if (!map) {
      map = new Map();
      this.exposed.set(sandboxId, map);
    }
    map.set(exposed.port, exposed);
    this.routes.set(exposed.exposeId, {
      sandboxId,
      port: exposed.port,
      token: exposed.token,
    });
  }

  removeExposed(sandboxId: string, port: number): boolean {
    const map = this.exposed.get(sandboxId);
    const exposed = map?.get(port);
    if (!map || !exposed) return false;
    map.delete(port);
    this.routes.delete(exposed.exposeId);
    return true;
  }

  listExposed(sandboxId: string): ExposedPort[] {
    return [...(this.exposed.get(sandboxId)?.values() ?? [])].sort(
      (a, b) => a.port - b.port,
    );
  }

  /** Resolve a preview route label (`<sandboxId>-<port>`) to its target. */
  resolveRoute(exposeId: string): RouteTarget | undefined {
    return this.routes.get(exposeId);
  }

  // --- sessions ------------------------------------------------------------

  addSession(sandboxId: string, session: SessionInfo): void {
    let map = this.sessions.get(sandboxId);
    if (!map) {
      map = new Map();
      this.sessions.set(sandboxId, map);
    }
    map.set(session.sessionId, session);
  }

  getSession(sandboxId: string, sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sandboxId)?.get(sessionId);
  }

  listSessions(sandboxId: string): SessionInfo[] {
    return [...(this.sessions.get(sandboxId)?.values() ?? [])].sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : -1,
    );
  }

  removeSession(sandboxId: string, sessionId: string): boolean {
    return this.sessions.get(sandboxId)?.delete(sessionId) ?? false;
  }

  /** Drop all process + exposed-port + session state for a destroyed sandbox. */
  clearSandbox(sandboxId: string): void {
    this.clearRuntimeState(sandboxId);
    this.sessions.delete(sandboxId);
  }

  /**
   * Drop the state tied to a live container — background processes and exposed
   * ports — when a sandbox is stopped. Sessions (just cwd/env strings) and the
   * sandbox record are kept so `start` resumes with them intact.
   */
  clearRuntimeState(sandboxId: string): void {
    this.procs.delete(sandboxId);
    const ports = this.exposed.get(sandboxId);
    if (ports) {
      for (const exposed of ports.values()) this.routes.delete(exposed.exposeId);
      this.exposed.delete(sandboxId);
    }
  }
}
