/** Normalize a thrown value to a message string (shared by all CLI commands). */
export function formatError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // The SDK tags an unreachable-daemon error; add the concrete next step.
  if ((err as { code?: string })?.code === "DAEMON_UNREACHABLE") {
    return `${msg}\n  → start it: hotcell start`;
  }
  return msg;
}

/**
 * Quote a value for copy-paste into a POSIX shell. Values made of safe
 * characters pass through untouched (typical URLs/images/branches stay
 * readable); anything else is single-quoted, with embedded single quotes
 * escaped via the `'\''` idiom.
 */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9@%_+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
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
