import { FakeTable } from '../../common/testing/fake-tables';
import { readSource, stripComments } from '../../common/testing/source-scan';
import { OPEN_COMPLAINT_STATUSES, PURGE_BATCH, purgeLocationHistory, purgeSlot } from './history-purge';
import { LocationHistoryPurgeService } from './history-purge.service';

const NOW = new Date('2026-11-10T12:00:00Z');
const daysAgo = (days: number, extraHours = 0) => new Date(NOW.getTime() - days * 86_400_000 - extraHours * 3_600_000);

function world(options: { pings?: any[]; complaints?: any[]; jobs?: any[] } = {}) {
  const artisanLocationPing = new FakeTable({ defaults: () => ({ interventionId: null, latitude: 36.8, longitude: 10.1 }) });
  const complaint = new FakeTable({});
  const intervention = new FakeTable({ defaults: () => ({ status: 'COMPLETED' }) });

  for (const ping of options.pings ?? []) artisanLocationPing.insert(ping);
  for (const row of options.complaints ?? []) complaint.insert(row);
  for (const row of options.jobs ?? []) intervention.insert(row);

  return { db: { artisanLocationPing, complaint, intervention }, pings: artisanLocationPing };
}

const idsLeft = (w: ReturnType<typeof world>) => w.pings.rows.map((row) => row.id).sort((a, b) => a - b);

describe('the end of the history of positions (P3-05)', () => {
  it('deletes the positions older than the days kept and keeps the others', async () => {
    const w = world({
      pings: [
        { id: 1, artisanId: 7, recordedAt: daysAgo(30) },
        { id: 2, artisanId: 7, recordedAt: daysAgo(7, 1) },
        { id: 3, artisanId: 7, recordedAt: daysAgo(6, 23) },
        { id: 4, artisanId: 7, recordedAt: daysAgo(0) },
      ],
    });

    const result = await purgeLocationHistory(w.db, 7, NOW);

    expect(result).toEqual({ deleted: 2, heldJobs: 0, cutShort: false });
    expect(idsLeft(w)).toEqual([3, 4]);
  });

  it('uses the number of days it is given', async () => {
    const pings = [
      { id: 1, artisanId: 7, recordedAt: daysAgo(2) },
      { id: 2, artisanId: 7, recordedAt: daysAgo(10) },
    ];

    const short = world({ pings });
    const long = world({ pings: pings.map((ping) => ({ ...ping })) });

    await purgeLocationHistory(short.db, 1, NOW);
    await purgeLocationHistory(long.db, 14, NOW);

    expect(idsLeft(short)).toEqual([]);
    expect(idsLeft(long)).toEqual([1, 2]);
  });

  it('a position exactly at the limit is kept: only an older one goes', async () => {
    const w = world({ pings: [{ id: 1, artisanId: 7, recordedAt: daysAgo(7) }, { id: 2, artisanId: 7, recordedAt: new Date(daysAgo(7).getTime() - 1) }] });

    await purgeLocationHistory(w.db, 7, NOW);

    expect(idsLeft(w)).toEqual([1]);
  });

  it('keeps the route of a job with a complaint that is not decided, however old', async () => {
    for (const status of OPEN_COMPLAINT_STATUSES) {
      const w = world({
        pings: [
          { id: 1, artisanId: 7, interventionId: 40, recordedAt: daysAgo(30) },
          { id: 2, artisanId: 7, interventionId: 41, recordedAt: daysAgo(30) },
        ],
        complaints: [{ id: 1, interventionId: 40, status }],
      });

      const result = await purgeLocationHistory(w.db, 7, NOW);

      expect(`${status}: ${idsLeft(w)}`).toBe(`${status}: 1`);
      expect(result).toEqual({ deleted: 1, heldJobs: 1, cutShort: false });
    }
  });

  it('lets the route go once the complaint is decided', async () => {
    for (const status of ['RESOLVED', 'REJECTED', 'REFUNDED']) {
      const w = world({
        pings: [{ id: 1, artisanId: 7, interventionId: 40, recordedAt: daysAgo(30) }],
        complaints: [{ id: 1, interventionId: 40, status }],
      });

      await purgeLocationHistory(w.db, 7, NOW);

      expect(`${status}: ${idsLeft(w).length}`).toBe(`${status}: 0`);
    }
  });

  it('keeps the route of a job whose status is disputed', async () => {
    const w = world({
      pings: [
        { id: 1, artisanId: 7, interventionId: 40, recordedAt: daysAgo(30) },
        { id: 2, artisanId: 7, interventionId: 41, recordedAt: daysAgo(30) },
      ],
      jobs: [
        { id: 40, status: 'DISPUTED' },
        { id: 41, status: 'COMPLETED' },
      ],
    });

    const result = await purgeLocationHistory(w.db, 7, NOW);

    expect(idsLeft(w)).toEqual([1]);
    expect(result.heldJobs).toBe(1);
  });

  it('a position whose job was deleted (it has no job any more) is deleted at the end of the days kept, like any other', async () => {
    const w = world({
      pings: [{ id: 1, artisanId: 7, interventionId: null, recordedAt: daysAgo(30) }],
      complaints: [{ id: 1, interventionId: 40, status: 'OPEN' }],
    });

    await purgeLocationHistory(w.db, 7, NOW);

    expect(idsLeft(w)).toEqual([]);
  });

  it('asks for the positions with no job by name: in SQL a `NOT IN` never matches a null, and they would stay for ever', async () => {
    const seen: any[] = [];
    const db: any = {
      complaint: { findMany: async () => [{ interventionId: 40 }] },
      intervention: { findMany: async () => [{ id: 41 }] },
      artisanLocationPing: {
        findMany: async (query: any) => {
          seen.push(query.where);

          return [];
        },
        deleteMany: async () => ({ count: 0 }),
      },
    };

    await purgeLocationHistory(db, 7, NOW);

    expect(seen.length).toBe(1);
    expect(seen[0].OR).toEqual([{ interventionId: null }, { interventionId: { notIn: [40, 41] } }]);
    expect(seen[0].recordedAt.lt).toEqual(daysAgo(7));
  });

  it('with no job to hold, the query has no list to leave out: `notIn: []` is not asked', async () => {
    const seen: any[] = [];
    const db: any = {
      complaint: { findMany: async () => [] },
      intervention: { findMany: async () => [] },
      artisanLocationPing: {
        findMany: async (query: any) => {
          seen.push(query.where);

          return [];
        },
        deleteMany: async () => ({ count: 0 }),
      },
    };

    await purgeLocationHistory(db, 7, NOW);

    expect(Object.keys(seen[0]).sort()).toEqual(['recordedAt']);
  });

  it('says when it stopped at its limit with positions left, and not when it finished', async () => {
    const make = (count: number) => world({ pings: Array.from({ length: count }, (_, index) => ({ id: index + 1, artisanId: 7, recordedAt: daysAgo(20) })) });

    const stopped = make(35);
    const finished = make(25);
    const exact = make(30);

    expect(await purgeLocationHistory(stopped.db, 7, NOW, { batch: 10, maxBatches: 3 })).toEqual({ deleted: 30, heldJobs: 0, cutShort: true });
    expect(idsLeft(stopped).length).toBe(5);
    expect(await purgeLocationHistory(finished.db, 7, NOW, { batch: 10, maxBatches: 3 })).toEqual({ deleted: 25, heldJobs: 0, cutShort: false });
    // exactly at the limit it cannot know that nothing is left: it says so, and the next round finds nothing
    expect((await purgeLocationHistory(exact.db, 7, NOW, { batch: 10, maxBatches: 3 })).cutShort).toBe(true);
  });

  it('a job named by two complaints is counted once', async () => {
    const w = world({
      pings: [{ id: 1, artisanId: 7, interventionId: 40, recordedAt: daysAgo(30) }],
      complaints: [
        { id: 1, interventionId: 40, status: 'OPEN' },
        { id: 2, interventionId: 40, status: 'IN_REVIEW' },
      ],
      jobs: [{ id: 40, status: 'DISPUTED' }],
    });

    expect(await purgeLocationHistory(w.db, 7, NOW)).toEqual({ deleted: 0, heldJobs: 1, cutShort: false });
  });

  it('empties a big table in pieces, and says how many it deleted', async () => {
    const pings = Array.from({ length: PURGE_BATCH * 2 + 37 }, (_, index) => ({ id: index + 1, artisanId: 7, recordedAt: daysAgo(20) }));
    const w = world({ pings: [...pings, { id: 999_999, artisanId: 7, recordedAt: daysAgo(1) }] });
    const batches: number[] = [];
    const original = w.pings.deleteMany;

    w.pings.deleteMany = (async (args: any) => {
      const answer = await original(args);

      batches.push(answer.count);

      return answer;
    }) as any;

    const result = await purgeLocationHistory(w.db, 7, NOW);

    expect(result.deleted).toBe(PURGE_BATCH * 2 + 37);
    expect(batches).toEqual([PURGE_BATCH, PURGE_BATCH, 37]);
    expect(idsLeft(w)).toEqual([999_999]);
  });

  it('does nothing, and says so, when there is nothing to delete', async () => {
    const w = world({ pings: [{ id: 1, artisanId: 7, recordedAt: daysAgo(1) }] });

    expect(await purgeLocationHistory(w.db, 7, NOW)).toEqual({ deleted: 0, heldJobs: 0, cutShort: false });
    expect(idsLeft(w)).toEqual([1]);
    expect(await purgeLocationHistory(world().db, 7, NOW)).toEqual({ deleted: 0, heldJobs: 0, cutShort: false });
  });
});

describe('the daily round (P3-05)', () => {
  const code = stripComments(readSource('modules/locations/history-purge.service.ts'));

  function service(extra: any[] = []) {
    const w = world({ pings: [{ id: 1, artisanId: 7, recordedAt: new Date('2026-10-28T10:00:00Z') }, { id: 2, artisanId: 7, recordedAt: new Date('2026-11-01T10:00:00Z') }, ...extra] });

    return { w, instance: new LocationHistoryPurgeService(w.db as any) };
  }

  async function withEnv<T>(values: Record<string, string | undefined>, work: () => Promise<T>): Promise<T> {
    const before = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));

    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }

    try {
      return await work();
    } finally {
      for (const [name, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }

  it('is asked every fifteen minutes and decides itself when to run: the zone is read when it is asked, not when the class is defined', () => {
    expect(code).toMatch(/@Cron\('\*\/15 \* \* \* \*'\)\s*async run\(\): Promise<void> \{\s*await this\.tick\(new Date\(\)\);\s*\}/);
    expect(code).not.toMatch(/timeZone:/);
    expect(code).toMatch(/purgeSlot\(now, getBusinessTimeZone\(\)\)/);
  });

  it('what the scheduler calls takes no argument and gives the time itself: an argument of the scheduler is never taken for a date', async () => {
    const { instance } = service();
    const asked: unknown[] = [];

    instance.tick = (async (when: unknown) => {
      asked.push(when);
    }) as any;

    await (instance.run as any)(() => undefined);
    await (instance.run as any)(null);
    expect(asked.length).toBe(2);
    expect(asked.every((when) => when instanceof Date && !Number.isNaN((when as Date).getTime()))).toBe(true);
    // and the method that does the work has no default of its own to be fed by accident
    expect(code).toMatch(/async tick\(now: Date\)/);
  });

  it('knows the window 03:30 to 05:59 in a zone and the local date it is then', () => {
    // Tunis is UTC+1 all year
    expect(purgeSlot(new Date('2026-11-02T02:30:00Z'), 'Africa/Tunis')).toEqual({ day: '2026-11-02', due: true });
    expect(purgeSlot(new Date('2026-11-02T02:44:59Z'), 'Africa/Tunis').due).toBe(true);
    expect(purgeSlot(new Date('2026-11-02T02:45:00Z'), 'Africa/Tunis').due).toBe(true);
    expect(purgeSlot(new Date('2026-11-02T03:00:00Z'), 'Africa/Tunis').due).toBe(true);
    expect(purgeSlot(new Date('2026-11-02T04:59:59Z'), 'Africa/Tunis').due).toBe(true);
    expect(purgeSlot(new Date('2026-11-02T05:00:00Z'), 'Africa/Tunis').due).toBe(false);
    expect(purgeSlot(new Date('2026-11-02T02:29:59Z'), 'Africa/Tunis').due).toBe(false);
    expect(purgeSlot(new Date('2026-11-02T00:00:00Z'), 'Africa/Tunis')).toEqual({ day: '2026-11-02', due: false });
    expect(purgeSlot(new Date('2026-11-01T23:30:00Z'), 'Africa/Tunis')).toEqual({ day: '2026-11-02', due: false });
    expect(purgeSlot(new Date('2026-11-02T03:30:00Z'), 'Africa/Tunis').due).toBe(true);
    // the same instant is another local time elsewhere, and the date is the local one
    expect(purgeSlot(new Date('2026-11-01T18:30:00Z'), 'Asia/Tokyo')).toEqual({ day: '2026-11-02', due: true });
    expect(purgeSlot(new Date('2026-11-01T18:30:00Z'), 'Africa/Tunis').due).toBe(false);
    // a zone the runtime does not know falls back to Tunis
    expect(purgeSlot(new Date('2026-11-02T02:30:00Z'), 'Nowhere/Land').due).toBe(true);
  });

  it('deletes at 03:30 in the zone in force, with the number of days of the setting, and not at any other time', async () => {
    await withEnv({ BUSINESS_TIMEZONE: undefined, LOCATION_HISTORY_DAYS: '3' }, async () => {
      const { w, instance } = service();

      await instance.tick(new Date('2026-11-02T01:30:00Z'));
      expect(idsLeft(w)).toEqual([1, 2]);

      await instance.tick(new Date('2026-11-02T02:30:00Z'));
      // 3 days kept (the default 7 would have kept the one of 4 November's eve)
      expect(idsLeft(w)).toEqual([2]);
    });
  });

  it('follows BUSINESS_TIMEZONE', async () => {
    await withEnv({ BUSINESS_TIMEZONE: 'Asia/Tokyo', LOCATION_HISTORY_DAYS: '3' }, async () => {
      const { w, instance } = service();

      await instance.tick(new Date('2026-11-02T02:30:00Z'));
      expect(idsLeft(w)).toEqual([1, 2]);
      await instance.tick(new Date('2026-11-01T18:30:00Z'));
      expect(idsLeft(w)).toEqual([2]);
    });
  });

  it('once a day: a second ask in the same quarter of an hour does nothing, the next day it runs again', async () => {
    await withEnv({ BUSINESS_TIMEZONE: undefined, LOCATION_HISTORY_DAYS: '3' }, async () => {
      const { w, instance } = service();
      let reads = 0;
      const original = w.db.complaint.findMany;

      w.db.complaint.findMany = (async (args: any) => {
        reads += 1;

        return original(args);
      }) as any;

      await instance.tick(new Date('2026-11-02T02:30:00Z'));
      await instance.tick(new Date('2026-11-02T02:31:00Z'));
      expect(reads).toBe(1);

      w.pings.insert({ id: 9, artisanId: 7, recordedAt: new Date('2026-10-20T10:00:00Z') });
      await instance.tick(new Date('2026-11-02T02:40:00Z'));
      expect(idsLeft(w)).toContain(9);

      await instance.tick(new Date('2026-11-03T02:30:00Z'));
      expect(reads).toBe(2);
      expect(idsLeft(w)).not.toContain(9);
    });
  });

  it('two asks at once run one round', async () => {
    await withEnv({ BUSINESS_TIMEZONE: undefined }, async () => {
      const { w, instance } = service();
      let reads = 0;
      const original = w.db.complaint.findMany;

      w.db.complaint.findMany = (async (args: any) => {
        reads += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));

        return original(args);
      }) as any;

      await Promise.all([instance.tick(new Date('2026-11-02T02:30:00Z')), instance.tick(new Date('2026-11-02T02:30:30Z'))]);
      expect(reads).toBe(1);
    });
  });

  it('a round that is still going when the next day comes is not started a second time', async () => {
    await withEnv({ BUSINESS_TIMEZONE: undefined }, async () => {
      const { w, instance } = service();
      let reads = 0;
      let release: () => void = () => undefined;
      const original = w.db.complaint.findMany;

      w.db.complaint.findMany = (async (args: any) => {
        reads += 1;
        if (reads === 1) await new Promise<void>((resolve) => { release = resolve; });

        return original(args);
      }) as any;

      const first = instance.tick(new Date('2026-11-02T02:30:00Z'));

      // the next day, the first round has not ended: the lock of the day is a different one, only the running round stops this ask
      await instance.tick(new Date('2026-11-03T02:30:00Z'));
      expect(reads).toBe(1);
      release();
      await first;

      // the round has ended: the next day's ask is not turned away for ever
      await instance.tick(new Date('2026-11-03T02:40:00Z'));
      expect(reads).toBe(2);
    });
  });

  it('a round that fails is written down, does not throw, and is tried again at the next ask of the window; once it succeeded it is not run again that day', async () => {
    await withEnv({ BUSINESS_TIMEZONE: undefined, LOCATION_HISTORY_DAYS: '3' }, async () => {
      const { w, instance } = service();
      let reads = 0;
      const original = w.db.complaint.findMany;

      w.db.complaint.findMany = (async (args: any) => {
        reads += 1;
        if (reads === 1) throw new Error('the database is away');

        return original(args);
      }) as any;

      await instance.tick(new Date('2026-11-02T02:30:00Z'));
      expect(reads).toBe(1);
      expect(idsLeft(w)).toEqual([1, 2]);

      await instance.tick(new Date('2026-11-02T02:45:00Z'));
      expect(reads).toBe(2);
      expect(idsLeft(w)).toEqual([2]);

      await instance.tick(new Date('2026-11-02T03:00:00Z'));
      expect(reads).toBe(2);
    });
  });

  it('a server that was away at 03:30 still runs the round when it is back inside the window', async () => {
    await withEnv({ BUSINESS_TIMEZONE: undefined, LOCATION_HISTORY_DAYS: '3' }, async () => {
      const { w, instance } = service();

      await instance.tick(new Date('2026-11-02T02:15:00Z'));
      expect(idsLeft(w)).toEqual([1, 2]);

      // restarted: the first ask it hears is at 04:15 local
      await instance.tick(new Date('2026-11-02T03:15:00Z'));
      expect(idsLeft(w)).toEqual([2]);
    });
  });

  it('does not run before 03:30 or from 06:00, and runs again the next day', async () => {
    await withEnv({ BUSINESS_TIMEZONE: undefined, LOCATION_HISTORY_DAYS: '3' }, async () => {
      const { w, instance } = service();

      await instance.tick(new Date('2026-11-02T02:29:59Z'));
      expect(idsLeft(w)).toEqual([1, 2]);
      await instance.tick(new Date('2026-11-02T05:00:00Z'));
      expect(idsLeft(w)).toEqual([1, 2]);
      await instance.tick(new Date('2026-11-02T10:00:00Z'));
      expect(idsLeft(w)).toEqual([1, 2]);
    });
  });

  it('warns when a round stopped at its limit', () => {
    expect(code).toMatch(/if \(cutShort\) \{\s*this\.logger\.warn\(/);
  });
});
