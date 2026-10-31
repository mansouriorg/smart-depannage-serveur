import { withTimeout } from './with-timeout';

/**
 * The time limit of the audit log's database calls (P3-02). The timers are watched: a call that ends in time must leave none behind.
 */

/** Runs a test with the timers of the process recorded: which were set, which were cleared. */
async function withTimers(run: (timers: { set: unknown[]; cleared: unknown[] }) => Promise<void>): Promise<void> {
  const realSet = global.setTimeout;
  const realClear = global.clearTimeout;
  const timers = { set: [] as unknown[], cleared: [] as unknown[] };

  (global as any).setTimeout = (fn: () => void, ms?: number) => {
    const handle = realSet(fn, ms);

    timers.set.push(handle);

    return handle;
  };
  (global as any).clearTimeout = (handle: any) => {
    timers.cleared.push(handle);

    return realClear(handle);
  };

  try {
    await run(timers);
  } finally {
    global.setTimeout = realSet;
    global.clearTimeout = realClear;
  }
}

const settled = async (work: Promise<unknown>) => {
  try {
    return { ok: await work };
  } catch (error) {
    return { error: (error as Error).message };
  }
};

describe('the time limit of a database call of the audit log (P3-02)', () => {
  it('lets through what ends in time, and clears its timer', async () => {
    await withTimers(async (timers) => {
      expect(await withTimeout(Promise.resolve(7), 1000, 'the call')).toBe(7);
      expect(timers.set).toHaveLength(1);
      expect(timers.cleared).toEqual(timers.set);
    });
  });

  it('passes on the failure of what fails in time, and clears its timer', async () => {
    await withTimers(async (timers) => {
      expect(await settled(withTimeout(Promise.reject(new Error('lost connection')), 1000, 'the call'))).toEqual({ error: 'lost connection' });
      expect(timers.cleared).toEqual(timers.set);
    });
  });

  it('gives up on what takes longer, and says what and how long', async () => {
    await withTimers(async (timers) => {
      const started = Date.now();

      expect(await settled(withTimeout(new Promise(() => {}), 25, 'closing the row'))).toEqual({ error: 'closing the row took more than 25 ms' });
      expect(Date.now() - started).toBeGreaterThanOrEqual(20);
      // and not much later: the limit is in milliseconds
      expect(Date.now() - started).toBeLessThan(2000);
      expect(timers.cleared).toEqual(timers.set);
    });
  });

  it('does not make a noise when the work that was given up on fails later', async () => {
    let late: (error: Error) => void = () => {};
    const work = new Promise<never>((_, reject) => { late = reject; });

    expect(await settled(withTimeout(work, 10, 'the call'))).toEqual({ error: 'the call took more than 10 ms' });

    late(new Error('too late'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // reaching here without an unhandled rejection is the check
    expect(true).toBe(true);
  });
});
