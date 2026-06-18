/** Normalize a thrown value to a message string (shared by all CLI commands). */
export function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
