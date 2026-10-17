import { RateLimiter } from './rate-limiter';

describe('RateLimiter', () => {
  let nowMs: number;
  let limiter: RateLimiter;

  const MINUTE = 60_000;

  beforeEach(() => {
    nowMs = 1_000_000;
    limiter = new RateLimiter(() => nowMs);
  });

  describe('hit (window counter)', () => {
    const rule = { limit: 3, windowMs: 10 * MINUTE };

    it('allows calls up to the limit then blocks', () => {
      expect(limiter.hit('k', rule).allowed).toBe(true);
      expect(limiter.hit('k', rule).allowed).toBe(true);
      expect(limiter.hit('k', rule).allowed).toBe(true);

      const blocked = limiter.hit('k', rule);

      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfterMs).toBe(10 * MINUTE);
    });

    it('reports the time left until the window resets', () => {
      for (let i = 0; i < 4; i += 1) limiter.hit('k', rule);

      nowMs += 4 * MINUTE;

      expect(limiter.hit('k', rule).retryAfterMs).toBe(6 * MINUTE);
    });

    it('starts a fresh window once the previous one ended', () => {
      for (let i = 0; i < 4; i += 1) limiter.hit('k', rule);

      nowMs += 10 * MINUTE;

      expect(limiter.hit('k', rule).allowed).toBe(true);
    });

    it('keeps keys independent', () => {
      for (let i = 0; i < 4; i += 1) limiter.hit('a', rule);

      expect(limiter.hit('b', rule).allowed).toBe(true);
    });
  });

  describe('registerFailure (lockout)', () => {
    const rule = { maxFailures: 3, windowMs: 15 * MINUTE, lockMs: 15 * MINUTE };

    it('locks after maxFailures failures', () => {
      expect(limiter.registerFailure('acct', rule)).toBe(0);
      expect(limiter.registerFailure('acct', rule)).toBe(0);
      expect(limiter.lockedForMs('acct')).toBe(0);

      expect(limiter.registerFailure('acct', rule)).toBe(15 * MINUTE);
      expect(limiter.lockedForMs('acct')).toBe(15 * MINUTE);
    });

    it('unlocks after lockMs', () => {
      for (let i = 0; i < 3; i += 1) limiter.registerFailure('acct', rule);

      nowMs += 15 * MINUTE;

      expect(limiter.lockedForMs('acct')).toBe(0);
    });

    it('needs a full set of failures again after the lock', () => {
      for (let i = 0; i < 3; i += 1) limiter.registerFailure('acct', rule);

      nowMs += 15 * MINUTE;

      limiter.registerFailure('acct', rule);
      limiter.registerFailure('acct', rule);

      expect(limiter.lockedForMs('acct')).toBe(0);
    });

    it('forgets old failures once the window ended', () => {
      limiter.registerFailure('acct', rule);
      limiter.registerFailure('acct', rule);

      nowMs += 15 * MINUTE;

      limiter.registerFailure('acct', rule);

      expect(limiter.lockedForMs('acct')).toBe(0);
    });

    it('clear() resets the counter after a success', () => {
      limiter.registerFailure('acct', rule);
      limiter.registerFailure('acct', rule);
      limiter.clear('acct');
      limiter.registerFailure('acct', rule);
      limiter.registerFailure('acct', rule);

      expect(limiter.lockedForMs('acct')).toBe(0);
    });
  });

  describe('memory', () => {
    it('removes expired entries on the periodic sweep', () => {
      const rule = { limit: 1, windowMs: MINUTE };

      for (let i = 0; i < 50; i += 1) limiter.hit(`k${i}`, rule);

      expect(limiter.size).toBe(50);

      nowMs += 2 * MINUTE;
      limiter.hit('trigger', rule);

      expect(limiter.size).toBe(1);
    });
  });
});
