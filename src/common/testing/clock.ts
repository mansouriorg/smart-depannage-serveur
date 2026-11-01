/**
 * Test support only: runs `work` while `new Date()` and `Date.now()` give `now`, so that a limit of the clock (a position that is exactly ten
 * minutes old) is tested to the millisecond instead of a few milliseconds beside it. Synchronous work only; the real clock comes back after.
 */
export function atInstant<T>(now: Date, work: () => T): T {
  const RealDate = Date;

  class FrozenDate extends RealDate {
    constructor(...args: any[]) {
      super(...((args.length ? args : [now.getTime()]) as [any]));
    }

    static now(): number {
      return now.getTime();
    }
  }

  (globalThis as any).Date = FrozenDate;

  try {
    return work();
  } finally {
    (globalThis as any).Date = RealDate;
  }
}
