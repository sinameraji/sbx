/** Normalize a thrown value to a message string (shared by all CLI commands). */
export function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Parse the resource-limit flags (`--memory <MB>`, `--cpus <n>`, `--pids <n>`). */
export function parseLimitFlags(flags: Record<string, string | boolean>): {
  memoryMb?: number;
  cpus?: number;
  pidsLimit?: number;
} {
  const num = (k: string) =>
    typeof flags[k] === "string" ? Number(flags[k]) : undefined;
  return { memoryMb: num("memory"), cpus: num("cpus"), pidsLimit: num("pids") };
}
