/**
 * In-memory sliding-window rate limiter, keyed by egress token. Tracks two
 * independent budgets per window: provider **calls** and billed **tokens**. The
 * gateway records a call's start before forwarding (calls budget) and its token
 * usage after the response completes (tokens budget), so token accounting lags by
 * at most one in-flight call — standard for a metered gateway.
 *
 * State is per-process and resets on daemon restart; it is intentionally not
 * persisted (a token bucket is ephemeral) and is not cluster-safe — a shared
 * store is the multi-daemon follow-up. Memory is bounded by pruning empty windows
 * lazily on access and dropping a token's state on revoke via `forget`.
 */

interface Window {
  /** Timestamps (ms) of recent calls within the window. */
  calls: number[];
  /** `{ at, tokens }` entries of recent billed-token events within the window. */
  tokens: { at: number; n: number }[];
}

export interface RateSpec {
  calls?: number;
  tokens?: number;
  windowMs: number;
}

export class RateLimiter {
  private windows = new Map<string, Window>();

  /**
   * Check whether a new call is allowed under the token's call budget, and if so
   * record it. Returns `{ ok: true }` or `{ ok: false, retryAfterMs }`. A spec
   * without a `calls` cap always passes (token-only limits are checked in `note`).
   */
  allow(token: string, spec: RateSpec, now: number): { ok: true } | { ok: false; retryAfterMs: number } {
    if (spec.calls === undefined) return { ok: true };
    const w = this.windowFor(token, spec.windowMs, now);
    if (w.calls.length >= spec.calls) {
      const oldest = w.calls[0]!;
      return { ok: false, retryAfterMs: Math.max(1, oldest + spec.windowMs - now) };
    }
    w.calls.push(now);
    return { ok: true };
  }

  /**
   * Pre-flight check of the token budget for the *next* call, against usage
   * already recorded in the window. Returns not-ok when the window is already at
   * or over the token cap (the previous call pushed it over). Does not record
   * anything — call `note` after the response to add this call's tokens.
   */
  checkTokens(
    token: string,
    spec: RateSpec,
    now: number,
  ): { ok: true } | { ok: false; retryAfterMs: number } {
    if (spec.tokens === undefined) return { ok: true };
    const w = this.windowFor(token, spec.windowMs, now);
    const used = w.tokens.reduce((s, e) => s + e.n, 0);
    if (used >= spec.tokens) {
      const oldest = w.tokens[0]?.at ?? now;
      return { ok: false, retryAfterMs: Math.max(1, oldest + spec.windowMs - now) };
    }
    return { ok: true };
  }

  /** Record billed tokens for a completed call (feeds the next `checkTokens`). */
  note(token: string, spec: RateSpec, billedTokens: number, now: number): void {
    if (spec.tokens === undefined || billedTokens <= 0) return;
    const w = this.windowFor(token, spec.windowMs, now);
    w.tokens.push({ at: now, n: billedTokens });
  }

  /** Drop a token's window state (call on revoke/destroy). */
  forget(token: string): void {
    this.windows.delete(token);
  }

  /** Get-or-create the token's window, pruning entries older than `windowMs`. */
  private windowFor(token: string, windowMs: number, now: number): Window {
    let w = this.windows.get(token);
    if (!w) {
      w = { calls: [], tokens: [] };
      this.windows.set(token, w);
    }
    const cutoff = now - windowMs;
    while (w.calls.length && w.calls[0]! <= cutoff) w.calls.shift();
    while (w.tokens.length && w.tokens[0]!.at <= cutoff) w.tokens.shift();
    return w;
  }
}
