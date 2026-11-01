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

/**
 * The same for work that waits (a service call): the clock stays at `now` until the promise ends. Nothing else may run at the same time in the
 * same test, since the clock is the whole process's.
 */
export async function atInstantAsync<T>(now: Date, work: () => Promise<T>): Promise<T> {
  const RealDate = Date;

  class FrozenDate extends RealDate {
    constructor(...args: any[]) {
      super(...((args.length ? args : [now.getTime()]) as [any]));
    }

    static now(): number {
      return now.getTime();
    }

    // A date made before the clock was frozen is still a date: the in-memory database copies what it holds with `instanceof Date`, and would
    // turn every such date into an empty object while the clock is frozen.
    static [Symbol.hasInstance](value: unknown): boolean {
      return value instanceof RealDate;
    }
  }

  (globalThis as any).Date = FrozenDate;

  try {
    return await work();
  } finally {
    (globalThis as any).Date = RealDate;
  }
}
