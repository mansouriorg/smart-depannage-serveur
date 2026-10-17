/**
 * In-memory rate limiter and failure lockout (P0-07).
 *
 * Pure TypeScript with no framework dependency so it can be unit tested on
 * its own. State lives in the process: that is correct for the current
 * single-instance deployment. If the API is ever scaled to several instances,
 * swap the Map for Redis behind the same methods.
 */

export type WindowRule = {
  /** Number of calls allowed per window. */
  limit: number;
  windowMs: number;
};

export type FailureRule = {
  /** Failures allowed inside the window before the key is locked. */
  maxFailures: number;
  windowMs: number;
  /** How long the key stays locked once maxFailures is reached. */
  lockMs: number;
};

export type HitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
};

type Entry = {
  count: number;
  windowEndsAt: number;
  lockedUntil: number;
};

const SWEEP_INTERVAL_MS = 60_000;

export class RateLimiter {
  private readonly entries = new Map<string, Entry>();
  private lastSweepAt = 0;

  constructor(private readonly now: () => number = Date.now) {}

  // ----------------------------------------------------------
  // Window counter: counts every call (per IP, per target, ...)
  // ----------------------------------------------------------

  hit(key: string, rule: WindowRule): HitResult {
    const now = this.now();
    this.sweep(now);

    let entry = this.entries.get(key);

    if (!entry || entry.windowEndsAt <= now) {
      entry = { count: 0, windowEndsAt: now + rule.windowMs, lockedUntil: 0 };
      this.entries.set(key, entry);
    }

    entry.count += 1;

    if (entry.count > rule.limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(entry.windowEndsAt - now, 0),
      };
    }

    return {
      allowed: true,
      remaining: rule.limit - entry.count,
      retryAfterMs: 0,
    };
  }

  // ----------------------------------------------------------
  // Failure lockout: counts only failed attempts (login, OTP)
  // ----------------------------------------------------------

  /** Milliseconds the key is still locked, 0 when it is not locked. */
  lockedForMs(key: string): number {
    const now = this.now();
    const entry = this.entries.get(key);

    if (!entry || entry.lockedUntil <= now) return 0;

    return entry.lockedUntil - now;
  }

  /** Records a failed attempt. Returns the lock duration if it just locked. */
  registerFailure(key: string, rule: FailureRule): number {
    const now = this.now();
    this.sweep(now);

    let entry = this.entries.get(key);

    if (!entry || (entry.windowEndsAt <= now && entry.lockedUntil <= now)) {
      entry = { count: 0, windowEndsAt: now + rule.windowMs, lockedUntil: 0 };
      this.entries.set(key, entry);
    }

    entry.count += 1;

    if (entry.count >= rule.maxFailures) {
      entry.lockedUntil = now + rule.lockMs;
      // The lock replaces the counting window; counting restarts after it.
      entry.windowEndsAt = entry.lockedUntil;
      entry.count = 0;
      return rule.lockMs;
    }

    return 0;
  }

  /** Forget a key, e.g. after a successful login. */
  clear(key: string): void {
    this.entries.delete(key);
  }

  // ----------------------------------------------------------

  /** Number of tracked keys (for tests and monitoring). */
  get size(): number {
    return this.entries.size;
  }

  private sweep(now: number): void {
    if (now - this.lastSweepAt < SWEEP_INTERVAL_MS) return;

    this.lastSweepAt = now;

    for (const [key, entry] of this.entries) {
      if (entry.windowEndsAt <= now && entry.lockedUntil <= now) {
        this.entries.delete(key);
      }
    }
  }
}
