// Shared daemon types.

export type SandboxStatus = "running" | "stopped";

export interface SandboxRecord {
  id: string;
  image: string;
  status: SandboxStatus;
  createdAt: string;
  labels: Record<string, string>;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
}

/** A single event in a streaming command execution. */
export type ExecEvent =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "exit"; exitCode: number };
