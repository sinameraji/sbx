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

/** Metadata returned for a file or directory entry. */
export interface FileInfo {
  path: string;
  name: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string;
}

/** Options for writing a file inside a sandbox. */
export interface WriteFileOptions {
  path: string;
  content: string;
  mode?: string;
}

/** Options for reading a file from a sandbox. */
export interface ReadFileOptions {
  path: string;
}

/** Options for creating a directory inside a sandbox. */
export interface MkdirOptions {
  path: string;
  parents?: boolean;
}

/** Options for listing files inside a sandbox. */
export interface ListFilesOptions {
  path: string;
}
