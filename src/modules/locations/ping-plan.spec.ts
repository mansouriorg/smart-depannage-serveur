import { BadRequestException } from '@nestjs/common';

import { FakeTable } from '../../common/testing/fake-tables';
import { NOT_A_POSITION, ROUTE_STATUSES, planPing } from './ping-plan';

const NOW = new Date('2026-11-01T10:00:00Z');
const secondsAgo = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

function world(jobs: any[] = [], pings: any[] = []) {
  const intervention = new FakeTable({ defaults: () => ({ artisanId: null, status: 'ASSIGNED' }) });
  const artisanLocationPing = new FakeTable({ defaults: () => ({ interventionId: null }) });

  for (const job of jobs) intervention.insert(job);
  for (const ping of pings) artisanLocationPing.insert(ping);

  return { db: { intervention, artisanLocationPing }, intervention, artisanLocationPing };
}

const reading = { latitude: 36.81, longitude: 10.18 };

async function refused(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('expected a refusal');
}

describe('the plan of a position (P3-05)', () => {
  it('writes the position, the time it was sent and one row of the history', async () => {
    const w = world([{ id: 40, artisanId: 7, status: 'ARTISAN_ON_THE_WAY' }]);

    const plan = await planPing(w.db, 7, { ...reading, accuracy: 12, speed: 8.5, heading: 270 }, { now: NOW });

    expect(plan.latitude).toBe(36.81);
    expect(plan.longitude).toBe(10.18);
    expect(plan.positionAt).toBe(NOW);
    expect(plan.history).toEqual({
      artisanId: 7,
      interventionId: 40,
      latitude: 36.81,
      longitude: 10.18,
      accuracyMeters: 12,
      speedMps: 8.5,
      heading: 270,
      recordedAt: NOW,
    });
  });

  it('refuses a position that is not a place, before anything is read', async () => {
    const w = world();
    let reads = 0;
    const spy: any = { intervention: { findMany: async () => (reads += 1) }, artisanLocationPing: { findFirst: async () => (reads += 1) } };

    for (const bad of [
      { latitude: 91, longitude: 10 },
      { latitude: 36, longitude: -181 },
      { latitude: NaN, longitude: 10 },
      { latitude: '36.8', longitude: '10.1' },
      { latitude: 0, longitude: 0 },
      { latitude: null, longitude: undefined },
    ]) {
      const error = await refused(planPing(spy, 7, bad as any, { now: NOW }));

      expect(error instanceof BadRequestException).toBe(true);
      expect(error.message).toBe(NOT_A_POSITION);
    }

    expect(reads).toBe(0);
    expect(w.artisanLocationPing.rows.length).toBe(0);
  });

  it('keeps what the phone said about the reading, and nothing that is not a number in range', async () => {
    const w = world([{ id: 40, artisanId: 7, status: 'ARTISAN_ON_THE_WAY' }]);

    const odd = await planPing(w.db, 7, { ...reading, accuracy: -1, speed: 'fast', heading: 361 }, { now: NOW });
    const edge = await planPing(w.db, 7, { ...reading, accuracy: 0, speed: 200, heading: 360 }, { now: NOW });
    const absent = await planPing(w.db, 7, reading, { now: NOW });

    expect([odd.history?.accuracyMeters, odd.history?.speedMps, odd.history?.heading]).toEqual([null, null, null]);
    expect([edge.history?.accuracyMeters, edge.history?.speedMps, edge.history?.heading]).toEqual([0, 200, 360]);
    expect([absent.history?.accuracyMeters, absent.history?.speedMps, absent.history?.heading]).toEqual([null, null, null]);

    // out of range on the other side too: a speed under zero, a speed over the limit, a heading under zero or past a full turn
    for (const [name, value] of [['speed', -0.1], ['speed', 200.5], ['heading', -1], ['heading', 360.5], ['accuracy', 100_001]] as const) {
      const plan = await planPing(w.db, 7, { ...reading, [name]: value }, { now: NOW });
      const kept = name === 'speed' ? plan.history?.speedMps : name === 'heading' ? plan.history?.heading : plan.history?.accuracyMeters;

      expect(`${name} ${value}: ${kept}`).toBe(`${name} ${value}: null`);
    }
  });

  describe('which job a position belongs to', () => {
    it('the job on the way, arrived or at work, whichever of the two spellings of the status it is stored in', async () => {
      for (const status of [...ROUTE_STATUSES, 'ON_THE_WAY', 'ARRIVED', 'ARTISAN_ARRIVED']) {
        const w = world([{ id: 40, artisanId: 7, status }]);

        const plan = await planPing(w.db, 7, reading, { now: NOW });

        expect(`${status}: ${plan.history?.interventionId}`).toBe(`${status}: 40`);
      }
    });

    it('no row at all when the technician has no job at those stages: waiting, assigned, accepted, finished, cancelled', async () => {
      for (const status of ['ASSIGNED', 'ARTISAN_ACCEPTED', 'COMPLETED', 'PAID', 'CANCELLED', 'WAITING_CLIENT_VALIDATION']) {
        const w = world([{ id: 40, artisanId: 7, status }]);

        const plan = await planPing(w.db, 7, reading, { now: NOW });

        // nothing replays a position that belongs to no job, so nothing keeps it; the current position and its time are still given
        expect(`${status}: ${plan.history}`).toBe(`${status}: null`);
        expect(plan.positionAt).toBe(NOW);
        expect(plan.latitude).toBe(36.81);
      }
    });

    it('no row for a technician with no job at all, and no look at the history for it', async () => {
      let historyReads = 0;
      const db: any = { intervention: new FakeTable(), artisanLocationPing: { findFirst: async () => (historyReads += 1) } };

      expect((await planPing(db, 7, reading, { now: NOW })).history).toBe(null);
      expect(historyReads).toBe(0);
    });

    it('never the job of another technician', async () => {
      const w = world([{ id: 40, artisanId: 8, status: 'ARTISAN_ON_THE_WAY' }]);

      expect((await planPing(w.db, 7, reading, { now: NOW })).history).toBe(null);
      expect((await planPing(w.db, 7, reading, { now: NOW, interventionId: 40 })).history).toBe(null);
    });

    it('the job that was named, when it is theirs and at a stage of the route; another of theirs is not taken instead', async () => {
      const w = world([
        { id: 40, artisanId: 7, status: 'ARTISAN_ON_THE_WAY' },
        { id: 41, artisanId: 7, status: 'IN_PROGRESS' },
        { id: 42, artisanId: 7, status: 'ASSIGNED' },
      ]);

      expect((await planPing(w.db, 7, reading, { now: NOW, interventionId: 40 })).history?.interventionId).toBe(40);
      expect((await planPing(w.db, 7, reading, { now: NOW, interventionId: 41 })).history?.interventionId).toBe(41);
      // named, but not yet on the route: the position belongs to no job
      expect((await planPing(w.db, 7, reading, { now: NOW, interventionId: 42 })).history).toBe(null);
    });

    it('with no job named, the one on the way first, then the one arrived, then the one at work; the latest of equals', async () => {
      // J45 is still at work while the technician has set out for J40: the position is on the way to J40, not J45's
      const w = world([
        { id: 40, artisanId: 7, status: 'ARTISAN_ON_THE_WAY' },
        { id: 45, artisanId: 7, status: 'IN_PROGRESS' },
      ]);

      expect((await planPing(w.db, 7, reading, { now: NOW })).history?.interventionId).toBe(40);

      const arrived = world([
        { id: 40, artisanId: 7, status: 'IN_PROGRESS' },
        { id: 45, artisanId: 7, status: 'ARTISAN_ARRIVED' },
        { id: 44, artisanId: 7, status: 'ARTISAN_ARRIVED' },
      ]);

      expect((await planPing(arrived.db, 7, reading, { now: NOW })).history?.interventionId).toBe(45);

      const legacy = world([
        { id: 40, artisanId: 7, status: 'IN_PROGRESS' },
        { id: 41, artisanId: 7, status: 'ON_THE_WAY' },
      ]);

      expect((await planPing(legacy.db, 7, reading, { now: NOW })).history?.interventionId).toBe(41);
    });
  });

  describe('how often the history grows', () => {
    const onTheWay = { id: 40, artisanId: 7, status: 'ARTISAN_ON_THE_WAY' };

    it('adds a row when the last one is ten seconds old or older', async () => {
      for (const age of [10, 11, 60, 3600]) {
        const w = world([onTheWay], [{ artisanId: 7, interventionId: 40, recordedAt: secondsAgo(age), latitude: 1, longitude: 1 }]);

        expect(`${age}s: ${(await planPing(w.db, 7, reading, { now: NOW })).history ? 'row' : 'none'}`).toBe(`${age}s: row`);
      }
    });

    it('adds none when the last one is less than ten seconds old, but still gives the position and its time', async () => {
      for (const age of [0, 1, 9]) {
        const w = world([onTheWay], [{ artisanId: 7, interventionId: 40, recordedAt: secondsAgo(age), latitude: 1, longitude: 1 }]);

        const plan = await planPing(w.db, 7, reading, { now: NOW });

        expect(`${age}s: ${plan.history}`).toBe(`${age}s: null`);
        expect(plan.positionAt).toBe(NOW);
        expect(plan.latitude).toBe(36.81);
      }
    });

    it('the floor holds whatever the job: a phone that names two jobs by turns does not add a row each time', async () => {
      const w = world([onTheWay, { id: 41, artisanId: 7, status: 'IN_PROGRESS' }], [{ artisanId: 7, interventionId: 41, recordedAt: secondsAgo(2), latitude: 1, longitude: 1 }]);

      expect((await planPing(w.db, 7, reading, { now: NOW, interventionId: 40 })).history).toBe(null);
      expect((await planPing(w.db, 7, reading, { now: NOW, interventionId: 41 })).history).toBe(null);
    });

    it('a last row from the future (a clock set back) does not hold the history for ever', async () => {
      const w = world([onTheWay], [{ artisanId: 7, interventionId: 40, recordedAt: new Date(NOW.getTime() + 3_600_000), latitude: 1, longitude: 1 }]);

      expect((await planPing(w.db, 7, reading, { now: NOW })).history?.interventionId).toBe(40);
    });

    it('a row from the future does not hide the rows before it: the floor holds on the newest row that is not ahead of now', async () => {
      const w = world(
        [onTheWay],
        [
          { artisanId: 7, interventionId: 40, recordedAt: secondsAgo(2), latitude: 1, longitude: 1 },
          { artisanId: 7, interventionId: 40, recordedAt: new Date(NOW.getTime() + 3_000), latitude: 1, longitude: 1 },
        ],
      );

      expect((await planPing(w.db, 7, reading, { now: NOW })).history).toBe(null);
    });

    it('compares with the last row of this technician, not another one’s', async () => {
      const w = world([onTheWay], [{ artisanId: 8, interventionId: 41, recordedAt: secondsAgo(1), latitude: 1, longitude: 1 }]);

      expect((await planPing(w.db, 7, reading, { now: NOW })).history).not.toBe(null);
    });

    it('compares with the newest row, not the first it finds', async () => {
      const w = world(
        [onTheWay],
        [
          { artisanId: 7, interventionId: 40, recordedAt: secondsAgo(500), latitude: 1, longitude: 1 },
          { artisanId: 7, interventionId: 40, recordedAt: secondsAgo(3), latitude: 1, longitude: 1 },
          { artisanId: 7, interventionId: 40, recordedAt: secondsAgo(900), latitude: 1, longitude: 1 },
        ],
      );

      expect((await planPing(w.db, 7, reading, { now: NOW })).history).toBe(null);
    });
  });

  it('only reads: nothing is written by asking', async () => {
    const w = world([{ id: 40, artisanId: 7, status: 'ARTISAN_ON_THE_WAY' }]);

    await planPing(w.db, 7, reading, { now: NOW });

    expect(w.artisanLocationPing.rows.length).toBe(0);
    expect(w.intervention.rows.length).toBe(1);
  });
});
