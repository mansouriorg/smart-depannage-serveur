import { NotFoundException } from '@nestjs/common';

import { FakeTable } from '../../common/testing/fake-tables';
import { ARRIVAL_WINDOW_MINUTES, MAX_ROUTE_POINTS, ROUTE_MOMENTS, routeOfJob, summarizeRoute } from './route-of-job';

const NOW = new Date('2026-11-01T12:00:00Z');
const at = (minutes: number) => new Date(Date.UTC(2026, 10, 1, 10, 0, 0) + minutes * 60_000);

// About 1.11 km per 0.01 degree of latitude. The door of the job is at 36.9, 10.2.
const DOOR = { latitude: 36.9, longitude: 10.2 };

const COLUMN_OF: Record<string, string> = {
  ARTISAN_ON_THE_WAY: 'artisanOnTheWayAt',
  ARTISAN_ARRIVED: 'artisanArrivedAt',
  WORK_STARTED: 'workStartedAt',
  WORK_COMPLETED: 'workCompletedAt',
};

// The moments are the dates of the job itself: `events` here are written as the columns they are in the job.
function world(options: { job?: any; pings?: any[]; events?: any[]; users?: any[] } = {}) {
  const intervention = new FakeTable({});
  const artisanLocationPing = new FakeTable({});
  const user = new FakeTable({});

  for (const person of options.users ?? []) user.insert(person);

  if (options.job !== null) {
    const columns: Record<string, Date> = {};

    for (const item of options.events ?? []) if (COLUMN_OF[item.type]) columns[COLUMN_OF[item.type]] = item.createdAt;

    intervention.insert({
      id: 40,
      address: '12 rue de Marseille, Tunis',
      ...DOOR,
      artisanId: 7,
      artisan: { id: 7, name: 'Sami', phone: '2000', email: 'sami@example.tn' },
      ...columns,
      ...options.job,
    });
  }

  for (const ping of options.pings ?? []) artisanLocationPing.insert({ interventionId: 40, artisanId: 7, ...ping });

  return { db: { intervention, artisanLocationPing, user }, artisanLocationPing };
}

const ping = (minutes: number, latitude: number, longitude = 10.2, extra: any = {}) => ({ recordedAt: at(minutes), latitude, longitude, ...extra });
const event = (type: string, minutes: number) => ({ type, createdAt: at(minutes) });

describe('the route of a job (P3-05)', () => {
  it('lists the positions of the job in the order they were sent, with what the phone said about each', async () => {
    const w = world({
      pings: [ping(10, 36.85, 10.2, { speedMps: 8, accuracyMeters: 12, heading: 90 }), ping(0, 36.8), ping(5, 36.83)],
    });

    const route = await routeOfJob(w.db, 40, NOW);

    expect(route.points.map((point) => point.latitude)).toEqual([36.8, 36.83, 36.85]);
    expect(route.points[2]).toEqual({ at: at(10), latitude: 36.85, longitude: 10.2, accuracyMeters: 12, speedMps: 8, heading: 90 });
    expect(route.points[0].accuracyMeters).toBe(null);
  });

  it('has the shape the shared package types by hand (JobRoute): a change here is a change there', async () => {
    const route = await routeOfJob(
      world({ pings: [ping(0, 36.8)], events: [event('ARTISAN_ON_THE_WAY', -1), event('ARTISAN_ARRIVED', 1)] }).db,
      40,
      NOW,
    );

    expect(Object.keys(route).sort()).toEqual(['artisan', 'cut', 'destination', 'historyDays', 'interventionId', 'mayBeIncomplete', 'moments', 'others', 'points', 'summary']);
    expect(Object.keys(route.points[0]).sort()).toEqual(['accuracyMeters', 'at', 'heading', 'latitude', 'longitude', 'speedMps']);
    expect(Object.keys(route.moments[0]).sort()).toEqual(['at', 'type']);
    expect(Object.keys(route.summary).sort()).toEqual(['atArrival', 'closest', 'firstAt', 'lastAt', 'pathKm', 'pointCount']);
    expect(Object.keys(route.destination!).sort()).toEqual(['address', 'latitude', 'longitude']);
    expect(Object.keys(route.artisan!).sort()).toEqual(['current', 'id', 'name']);
    expect(Object.keys(route.summary.closest!).sort()).toEqual(['at', 'meters']);
    expect(Object.keys(route.summary.atArrival!).sort()).toEqual(['arrivedAt', 'at', 'meters']);
    expect([...ROUTE_MOMENTS]).toEqual(['ARTISAN_ON_THE_WAY', 'ARTISAN_ARRIVED', 'WORK_STARTED', 'WORK_COMPLETED']);
  });

  it('is the route of this job only', async () => {
    const w = world({ pings: [ping(0, 36.8), { ...ping(1, 36.81), interventionId: 41 }, { ...ping(2, 36.82), interventionId: null }] });

    expect((await routeOfJob(w.db, 40, NOW)).points.length).toBe(1);
  });

  it('names the technician (an id and a name, no phone or e-mail) and the address point of the job', async () => {
    const route = await routeOfJob(world().db, 40, NOW);

    expect(route.artisan).toEqual({ id: 7, name: 'Sami', current: true });
    expect(route.destination).toEqual({ latitude: 36.9, longitude: 10.2, address: '12 rue de Marseille, Tunis' });
    expect(route.interventionId).toBe(40);
  });

  it('has no technician and no address point when the job has none', async () => {
    const route = await routeOfJob(world({ job: { artisanId: null, artisan: null, latitude: null, longitude: null } }).db, 40, NOW);

    expect(route.artisan).toBe(null);
    expect(route.destination).toBe(null);
    expect(route.summary.closest).toBe(null);
  });

  it('does not take 0,0 for an address point', async () => {
    const route = await routeOfJob(world({ job: { latitude: 0, longitude: 0 }, pings: [ping(0, 36.8)] }).db, 40, NOW);

    expect(route.destination).toBe(null);
  });

  it('gives the moments of the job that frame a route, in order, and no other', async () => {
    const w = world({
      job: {
        artisanArrivedAt: at(30),
        assignedAt: at(-60),
        artisanOnTheWayAt: at(0),
        workCompletedAt: at(90),
        workStartedAt: at(35),
        createdAt: at(-120),
        updatedAt: at(95),
      },
    });

    const route = await routeOfJob(w.db, 40, NOW);

    expect(route.moments).toEqual([
      { type: 'ARTISAN_ON_THE_WAY', at: at(0) },
      { type: 'ARTISAN_ARRIVED', at: at(30) },
      { type: 'WORK_STARTED', at: at(35) },
      { type: 'WORK_COMPLETED', at: at(90) },
    ]);
    expect([...ROUTE_MOMENTS]).toEqual(['ARTISAN_ON_THE_WAY', 'ARTISAN_ARRIVED', 'WORK_STARTED', 'WORK_COMPLETED']);
  });

  it('has a moment only when the job has the date: a job that never set out has no "set out"', async () => {
    const route = await routeOfJob(world({ job: { workStartedAt: at(10) } }).db, 40, NOW);

    expect(route.moments).toEqual([{ type: 'WORK_STARTED', at: at(10) }]);
  });

  it('is an empty route, not an error, for a job whose technician sent nothing', async () => {
    const route = await routeOfJob(world().db, 40, NOW);

    expect(route.points).toEqual([]);
    expect(route.summary).toEqual({ pointCount: 0, firstAt: null, lastAt: null, pathKm: 0, closest: null, atArrival: null });
  });

  it('refuses a job that does not exist', async () => {
    let error: any;

    try {
      await routeOfJob(world({ job: null }).db, 99, NOW);
    } catch (caught) {
      error = caught;
    }

    expect(error instanceof NotFoundException).toBe(true);
    expect(error.message).toBe('Intervention introuvable.');
  });

  describe('may be incomplete, cut', () => {
    it('may be incomplete when the technician set out longer ago than the history is kept', async () => {
      const old = new Date(NOW.getTime() - 8 * 86_400_000);
      const recent = new Date(NOW.getTime() - 6 * 86_400_000);

      expect((await routeOfJob(world({ events: [{ type: 'ARTISAN_ON_THE_WAY', createdAt: old }] }).db, 40, NOW)).mayBeIncomplete).toBe(true);
      expect((await routeOfJob(world({ events: [{ type: 'ARTISAN_ON_THE_WAY', createdAt: recent }] }).db, 40, NOW)).mayBeIncomplete).toBe(false);
      expect((await routeOfJob(world().db, 40, NOW)).mayBeIncomplete).toBe(false);
    });

    it('counts from the first moment there is: a job that went straight to work has no "set out"', async () => {
      const old = new Date(NOW.getTime() - 9 * 86_400_000);

      expect((await routeOfJob(world({ events: [{ type: 'WORK_STARTED', createdAt: old }] }).db, 40, NOW)).mayBeIncomplete).toBe(true);
    });

    it('says how many days are kept', async () => {
      expect((await routeOfJob(world().db, 40, NOW)).historyDays).toBe(7);
    });

    it('is cut at the most one answer carries, and says so; nothing is cut below that', async () => {
      const many = Array.from({ length: MAX_ROUTE_POINTS + 5 }, (_, index) => ping(index / 10, 36.8));
      const cut = await routeOfJob(world({ pings: many }).db, 40, NOW);
      const exact = await routeOfJob(world({ pings: many.slice(0, MAX_ROUTE_POINTS) }).db, 40, NOW);

      expect(cut.points.length).toBe(MAX_ROUTE_POINTS);
      expect(cut.cut).toBe(true);
      // what is kept is the beginning of the road, in order: the latest positions are the ones left out
      const marked = Array.from({ length: MAX_ROUTE_POINTS + 5 }, (_, index) => ping(index / 10, 36 + index / 100_000));
      const kept = (await routeOfJob(world({ pings: marked }).db, 40, NOW)).points;

      expect(kept[0].latitude).toBe(36);
      expect(kept[MAX_ROUTE_POINTS - 1].latitude).toBe(36 + (MAX_ROUTE_POINTS - 1) / 100_000);
      expect(exact.points.length).toBe(MAX_ROUTE_POINTS);
      expect(exact.cut).toBe(false);
    });
  });
});

describe('a job that changed hands (P3-05)', () => {
  const people = [{ id: 7, name: 'Sami' }, { id: 8, name: 'Nour' }];
  const mine = (minutes: number, latitude: number) => ping(minutes, latitude, 10.2, { artisanId: 8 });
  const sami = (minutes: number, latitude: number) => ping(minutes, latitude, 10.2, { artisanId: 7 });

  it('draws the positions of the technician who holds the job, not the ones of the technician before', async () => {
    // Nour (8) held it first and set out from far away, gave it back; Sami (7) took it. Both sent positions.
    const w = world({ users: people, pings: [mine(0, 36.1), mine(5, 36.2), sami(30, 36.8), sami(40, 36.85)] });

    const route = await routeOfJob(w.db, 40, NOW);

    expect(route.artisan).toEqual({ id: 7, name: 'Sami', current: true });
    expect(route.points.map((point) => point.latitude)).toEqual([36.8, 36.85]);
    // the line is Sami's alone: no jump from Nour's last position to Sami's first
    expect(route.summary.pathKm).toBe(5.56);
    expect(route.summary.closest?.meters).toBe(5560);
  });

  it('says that the other technician sent positions too, with how many and when, without drawing them', async () => {
    const w = world({ users: people, pings: [mine(0, 36.1), mine(5, 36.2), mine(2, 36.15), sami(30, 36.8)] });

    const route = await routeOfJob(w.db, 40, NOW);

    expect(route.others).toEqual([{ artisan: { id: 8, name: 'Nour' }, pointCount: 3, firstAt: at(0), lastAt: at(5) }]);
    expect(route.points.length).toBe(1);
  });

  it('reads the route of the other technician when they are named', async () => {
    const w = world({ users: people, pings: [mine(0, 36.1), mine(5, 36.2), sami(30, 36.8)] });

    const route = await routeOfJob(w.db, 40, NOW, 8);

    expect(route.artisan).toEqual({ id: 8, name: 'Nour', current: false });
    expect(route.points.map((point) => point.latitude)).toEqual([36.1, 36.2]);
    expect(route.others.map((other) => other.artisan.id)).toEqual([7]);
    // the dates of the job are the ones of the technician who holds it: they are not put on the route of the one who gave it back
    expect(route.moments).toEqual([]);
  });

  it('keeps the moments with the technician who holds the job', async () => {
    const w = world({ users: people, pings: [mine(0, 36.1), sami(30, 36.8)], events: [event('ARTISAN_ON_THE_WAY', 20)] });

    expect((await routeOfJob(w.db, 40, NOW)).moments).toEqual([{ type: 'ARTISAN_ON_THE_WAY', at: at(20) }]);
    expect((await routeOfJob(w.db, 40, NOW, 8)).moments).toEqual([]);
    expect((await routeOfJob(w.db, 40, NOW, 7)).moments).toEqual([{ type: 'ARTISAN_ON_THE_WAY', at: at(20) }]);
  });

  it('after the technician gave the job back, the route is still there: the one who sent the latest positions', async () => {
    const w = world({ users: people, job: { artisanId: null, artisan: null }, pings: [mine(0, 36.1), mine(5, 36.2), sami(30, 36.8)] });

    const route = await routeOfJob(w.db, 40, NOW);

    expect(route.artisan).toEqual({ id: 7, name: 'Sami', current: false });
    expect(route.points.length).toBe(1);
    expect(route.others.map((other) => other.artisan.id)).toEqual([8]);
    expect(route.moments).toEqual([]);
  });

  it('a technician who holds the job and has sent nothing yet: an empty route, and the earlier technician listed', async () => {
    const w = world({ users: people, pings: [mine(0, 36.1)] });

    const route = await routeOfJob(w.db, 40, NOW);

    expect(route.artisan).toEqual({ id: 7, name: 'Sami', current: true });
    expect(route.points).toEqual([]);
    expect(route.others.length).toBe(1);
  });

  it('refuses a number that is neither the technician of the job nor anywhere in its positions: one that does not exist, and the number of any other account', async () => {
    // 51 is a customer and 52 a member of the staff: they exist, and their names must not come back as a route
    const accounts = [...people, { id: 51, name: 'Un client' }, { id: 52, name: 'Un régulateur' }, { id: 9, name: 'Ali, technicien d’une autre demande' }];

    for (const stranger of [999, 51, 52, 9]) {
      let error: any;

      try {
        await routeOfJob(world({ users: accounts, pings: [sami(0, 36.8)] }).db, 40, NOW, stranger);
      } catch (caught) {
        error = caught;
      }

      expect(`${stranger}: ${error instanceof NotFoundException}`).toBe(`${stranger}: true`);
      expect(error.message).toBe('Technicien introuvable.');
    }
  });

  it('accepts the technician of the job even before they sent anything, and one who only sent positions on it', async () => {
    const accounts = [...people, { id: 51, name: 'Un client' }];

    expect((await routeOfJob(world({ users: accounts }).db, 40, NOW, 7)).artisan).toEqual({ id: 7, name: 'Sami', current: true });
    expect((await routeOfJob(world({ users: accounts, pings: [mine(0, 36.1)] }).db, 40, NOW, 8)).artisan).toEqual({ id: 8, name: 'Nour', current: false });
  });

  it('counts the positions of the others in the database: a former holder with more than one answer carries is counted whole', async () => {
    const long = Array.from({ length: MAX_ROUTE_POINTS + 50 }, (_, index) => mine(index / 10, 36.1));
    const w = world({ users: people, pings: [...long, sami(10_000, 36.8)] });

    const route = await routeOfJob(w.db, 40, NOW);

    expect(route.others).toEqual([{ artisan: { id: 8, name: 'Nour' }, pointCount: MAX_ROUTE_POINTS + 50, firstAt: at(0), lastAt: at((MAX_ROUTE_POINTS + 49) / 10) }]);
  });

  it('lists the others in the order they began, and a later technician too', async () => {
    const w = world({ users: [...people, { id: 9, name: 'Ali' }], pings: [ping(50, 36.3, 10.2, { artisanId: 9 }), mine(0, 36.1), sami(60, 36.8)] });

    expect((await routeOfJob(w.db, 40, NOW)).others.map((other) => other.artisan.id)).toEqual([8, 9]);
  });

  describe('a job the staff handed over (the dates of the technician before stay on the job)', () => {
    const handOver = { assignedAt: at(25) };

    it('shows the moments from the hand-over on, and not the ones of the technician before', async () => {
      // Nour set out at minute 5 and arrived at minute 15; at minute 25 the staff gave the job to Sami, who set out at minute 30
      const w = world({
        users: people,
        job: handOver,
        pings: [mine(5, 36.1), sami(30, 36.8)],
        events: [event('ARTISAN_ON_THE_WAY', 5), event('ARTISAN_ARRIVED', 15)],
      });

      const route = await routeOfJob(w.db, 40, NOW);

      expect(route.moments).toEqual([]);

      w.db.intervention.rows[0].artisanOnTheWayAt = at(30);
      expect((await routeOfJob(w.db, 40, NOW)).moments).toEqual([{ type: 'ARTISAN_ON_THE_WAY', at: at(30) }]);
    });

    it('a moment exactly at the hand-over is the holder’s', async () => {
      const w = world({ job: handOver, events: [event('ARTISAN_ON_THE_WAY', 25)] });

      expect((await routeOfJob(w.db, 40, NOW)).moments).toEqual([{ type: 'ARTISAN_ON_THE_WAY', at: at(25) }]);
    });

    it('the figure “distance at the declared arrival” is not built on the arrival of the technician before', async () => {
      const w = world({ users: people, job: handOver, pings: [mine(15, 36.9), sami(30, 36.5)], events: [event('ARTISAN_ARRIVED', 15)] });

      expect((await routeOfJob(w.db, 40, NOW)).summary.atArrival).toBe(null);
    });

    it('a job with no hand-over date keeps every moment', async () => {
      const w = world({ job: { assignedAt: null }, events: [event('ARTISAN_ON_THE_WAY', 5), event('ARTISAN_ARRIVED', 15)] });

      expect((await routeOfJob(w.db, 40, NOW)).moments.length).toBe(2);
    });
  });

  describe('may be incomplete when the route is not the holder’s', () => {
    const long = (days: number) => ({ createdAt: new Date(NOW.getTime() - days * 86_400_000) });

    it('a technician who gave the job back: counted from the day the job was made, since the day they set out is not known', async () => {
      const gaveBack = { artisanId: null, artisan: null };

      expect((await routeOfJob(world({ users: people, job: { ...gaveBack, ...long(9) }, pings: [sami(0, 36.8)] }).db, 40, NOW)).mayBeIncomplete).toBe(true);
      expect((await routeOfJob(world({ users: people, job: { ...gaveBack, ...long(2) }, pings: [sami(0, 36.8)] }).db, 40, NOW)).mayBeIncomplete).toBe(false);
    });

    it('a former holder asked for by number, the same', async () => {
      expect((await routeOfJob(world({ users: people, job: long(9), pings: [mine(0, 36.1)] }).db, 40, NOW, 8)).mayBeIncomplete).toBe(true);
      expect((await routeOfJob(world({ users: people, job: long(2), pings: [mine(0, 36.1)] }).db, 40, NOW, 8)).mayBeIncomplete).toBe(false);
    });

    it('no position at all on an old job: the answer does not read as “nobody ever sent one”', async () => {
      expect((await routeOfJob(world({ job: { artisanId: null, artisan: null, ...long(30) } }).db, 40, NOW)).mayBeIncomplete).toBe(true);
    });
  });

  it('has no other technicians when there is only one', async () => {
    expect((await routeOfJob(world({ pings: [sami(0, 36.8)] }).db, 40, NOW)).others).toEqual([]);
  });
});

describe('what a dispute asks of a route (P3-05)', () => {
  const point = (minutes: number, latitude: number, longitude = 10.2) => ({ at: at(minutes), latitude, longitude, accuracyMeters: null, speedMps: null, heading: null });

  it('the length of the line through the positions', () => {
    // 0.1 degree of latitude twice: about 11.1 km each
    const summary = summarizeRoute([point(0, 36.7), point(10, 36.8), point(20, 36.9)], DOOR, []);

    expect(summary.pathKm).toBeGreaterThan(22.1);
    expect(summary.pathKm).toBeLessThan(22.4);
    expect(summarizeRoute([point(0, 36.7)], DOOR, []).pathKm).toBe(0);
    // told to the hundredth of a kilometre, not with the digits of the arithmetic
    for (const odd of [summarizeRoute([point(0, 36.7123), point(10, 36.8456, 10.2371), point(20, 36.9031, 10.1987)], DOOR, []).pathKm, summary.pathKm]) {
      expect(odd).toBe(Math.round(odd * 100) / 100);
    }
    expect(summarizeRoute([point(0, 36.7123), point(10, 36.8456, 10.2371), point(20, 36.9031, 10.1987)], DOOR, []).pathKm).not.toBe(0);
    expect(summary.pointCount).toBe(3);
    expect(summary.firstAt).toEqual(at(0));
    expect(summary.lastAt).toEqual(at(20));
  });

  it('the nearest the technician came to the address, in metres, and when', () => {
    const summary = summarizeRoute([point(0, 36.7), point(10, 36.899), point(20, 36.85)], DOOR, []);

    expect(summary.closest).toEqual({ meters: 111, at: at(10) });
  });

  it('is nothing for the nearest when there is no address point, and nothing for the arrival with no moment of arrival', () => {
    expect(summarizeRoute([point(0, 36.7)], null, []).closest).toBe(null);
    expect(summarizeRoute([point(0, 36.7)], null, [{ type: 'ARTISAN_ARRIVED', at: at(0) }]).atArrival).toBe(null);
    expect(summarizeRoute([point(0, 36.7)], DOOR, [{ type: 'ARTISAN_ON_THE_WAY', at: at(0) }]).atArrival).toBe(null);
  });

  it('how far from the address the position nearest in time to "arrived" was', () => {
    const summary = summarizeRoute(
      [point(0, 36.7), point(20, 36.88), point(31, 36.899), point(60, 36.9)],
      DOOR,
      [{ type: 'ARTISAN_ARRIVED', at: at(30) }],
    );

    expect(summary.atArrival).toEqual({ meters: 111, at: at(31), arrivedAt: at(30) });
  });

  it('takes the position just before "arrived" as well as just after', () => {
    const summary = summarizeRoute([point(28, 36.89), point(34, 36.9)], DOOR, [{ type: 'ARTISAN_ARRIVED', at: at(30) }]);

    expect(summary.atArrival?.at).toEqual(at(28));
    expect(summary.atArrival?.meters).toBe(1112);
  });

  it('has none when no position was sent within five minutes of "arrived"', () => {
    expect(ARRIVAL_WINDOW_MINUTES).toBe(5);
    expect(summarizeRoute([point(0, 36.7), point(40, 36.9)], DOOR, [{ type: 'ARTISAN_ARRIVED', at: at(30) }]).atArrival).toBe(null);
    // exactly five minutes is inside
    expect(summarizeRoute([point(25, 36.9)], DOOR, [{ type: 'ARTISAN_ARRIVED', at: at(30) }]).atArrival?.meters).toBe(0);
    expect(summarizeRoute([point(24.9, 36.9)], DOOR, [{ type: 'ARTISAN_ARRIVED', at: at(30) }]).atArrival).toBe(null);
  });

  it('takes the first moment of arrival when there are two', () => {
    const summary = summarizeRoute([point(10, 36.9), point(50, 36.7)], DOOR, [
      { type: 'ARTISAN_ARRIVED', at: at(10) },
      { type: 'ARTISAN_ARRIVED', at: at(50) },
    ]);

    expect(summary.atArrival?.arrivedAt).toEqual(at(10));
  });
});
