/**
 * Two small helpers to keep concurrent work in order (P1-04 review). Both are
 * per process: with several server instances each one has its own, like the
 * in-memory rate limits.
 */

/**
 * Runs the jobs that share a key one after the other, in the order they came.
 * "Read how many photos there are, then add some" is only right if nobody else
 * adds some in between.
 */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(() => work());
    // The next job waits for this one to finish, whether it succeeded or not.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );

    this.tails.set(key, tail);

    try {
      return await result;
    } finally {
      // Nobody queued behind us: forget the key, so the map does not grow with every request ever seen.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  /** Keys that have work running or waiting (for tests). */
  get size(): number {
    return this.tails.size;
  }
}

/** At most `max` jobs at the same time; the others wait their turn. */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly max: number) {
    if (!Number.isInteger(max) || max < 1) throw new Error('Semaphore: max must be a positive integer.');
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active < this.max) {
      this.active++;
    } else {
      // The slot is handed over by the job that finishes: `active` stays the same.
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }

    try {
      return await work();
    } finally {
      const next = this.waiting.shift();

      if (next) next();
      else this.active--;
    }
  }
}
