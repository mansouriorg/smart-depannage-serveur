import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

import {
  FailureRule,
  HitResult,
  RateLimiter,
  WindowRule,
} from './rate-limiter';

/** Shared rules, so the numbers live in one place. */
export const RATE_RULES = {
  /**
   * Wrong password for one account from one client address. Locks only that
   * client: someone who types an admin's email five times must not be able to
   * lock the admin out.
   */
  loginFailuresPerClient: {
    maxFailures: 5,
    windowMs: 15 * 60_000,
    lockMs: 15 * 60_000,
  } satisfies FailureRule,

  /**
   * Wrong passwords for one account from any address. Much higher than the
   * per-client rule: it only trips when many addresses attack one account.
   */
  loginFailuresPerAccount: {
    maxFailures: 30,
    windowMs: 15 * 60_000,
    lockMs: 15 * 60_000,
  } satisfies FailureRule,

  /** Wrong one-time code for one phone / user. */
  otpFailures: {
    maxFailures: 5,
    windowMs: 10 * 60_000,
    lockMs: 15 * 60_000,
  } satisfies FailureRule,

  /** Reset links requested for one email (silent, no error is shown). */
  forgotPasswordPerEmail: {
    limit: 3,
    windowMs: 60 * 60_000,
  } satisfies WindowRule,

  /** SMS / email codes sent to one phone / user (SMS cost and spam). */
  codeSendPerTarget: {
    limit: 3,
    windowMs: 60 * 60_000,
  } satisfies WindowRule,
} as const;

@Injectable()
export class RateLimitService {
  private readonly limiter = new RateLimiter();

  /** Counts a call; throws 429 when over the limit. */
  assertWithin(key: string, rule: WindowRule): void {
    const result = this.limiter.hit(key, rule);

    if (!result.allowed) {
      this.throwTooMany(result.retryAfterMs);
    }
  }

  /** Counts a call and returns false (instead of throwing) when over the limit. */
  tryConsume(key: string, rule: WindowRule): boolean {
    return this.limiter.hit(key, rule).allowed;
  }

  /** Counts a call and returns the full result, including the time left. */
  consume(key: string, rule: WindowRule): HitResult {
    return this.limiter.hit(key, rule);
  }

  /** Throws 429 while the key is locked after repeated failures. */
  assertNotLocked(key: string): void {
    const lockedForMs = this.limiter.lockedForMs(key);

    if (lockedForMs > 0) {
      this.throwTooMany(lockedForMs);
    }
  }

  registerFailure(key: string, rule: FailureRule): void {
    this.limiter.registerFailure(key, rule);
  }

  clear(key: string): void {
    this.limiter.clear(key);
  }

  private throwTooMany(retryAfterMs: number): never {
    const retryAfterSeconds = Math.max(Math.ceil(retryAfterMs / 1000), 1);
    const minutes = Math.ceil(retryAfterSeconds / 60);

    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'Too Many Requests',
        message:
          minutes > 1
            ? `Trop de tentatives. Réessayez dans ${minutes} minutes.`
            : 'Trop de tentatives. Réessayez dans une minute.',
        retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
