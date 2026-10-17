import { KeyedLock, Semaphore } from './limits';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

describe('KeyedLock', () => {
  it('jobs with the same key run one at a time, in order', async () => {
    const lock = new KeyedLock();
    const log: string[] = [];

    const job = (name: string) => async () => {
      log.push(`${name} start`);
      await tick();
      await tick();
      log.push(`${name} end`);
    };

    await Promise.all([lock.run('a', job('1')), lock.run('a', job('2')), lock.run('a', job('3'))]);

    expect(log).toEqual(['1 start', '1 end', '2 start', '2 end', '3 start', '3 end']);
  });

  it('different keys do not wait for each other', async () => {
    const lock = new KeyedLock();
    const log: string[] = [];

    await Promise.all([
      lock.run('a', async () => {
        log.push('a start');
        await tick();
        await tick();
        log.push('a end');
      }),
      lock.run('b', async () => {
        log.push('b start');
        await tick();
        log.push('b end');
      }),
    ]);

    expect(log.slice(0, 2)).toEqual(['a start', 'b start']);
  });

  it('a job that fails passes its error on and does not block the next one', async () => {
    const lock = new KeyedLock();

    const failing = lock.run('a', async () => {
      await tick();
      throw new Error('boom');
    });
    const next = lock.run('a', async () => 'fine');

    let message = '';
    await failing.catch((error) => {
      message = error.message;
    });

    expect(message).toBe('boom');
    expect(await next).toBe('fine');
  });

  it('forgets a key once nothing is waiting on it', async () => {
    const lock = new KeyedLock();

    await Promise.all([lock.run('a', tick), lock.run('a', tick), lock.run('b', tick)]);

    expect(lock.size).toBe(0);
  });
});

describe('Semaphore', () => {
  it('never runs more jobs than its limit, and finishes them all', async () => {
    const gate = new Semaphore(2);
    let running = 0;
    let peak = 0;
    let done = 0;

    await Promise.all(
      Array.from({ length: 7 }, () =>
        gate.run(async () => {
          running++;
          peak = Math.max(peak, running);
          await tick();
          running--;
          done++;
        }),
      ),
    );

    expect(peak).toBe(2);
    expect(done).toBe(7);
  });

  it('a failing job gives its place back', async () => {
    const gate = new Semaphore(1);

    await gate.run(async () => Promise.reject(new Error('x'))).catch(() => undefined);

    expect(await gate.run(async () => 'ok')).toBe('ok');
  });

  it('refuses a limit that is not a positive whole number', () => {
    expect(() => new Semaphore(0)).toThrow(/positive integer/);
    expect(() => new Semaphore(1.5)).toThrow(/positive integer/);
  });
});
