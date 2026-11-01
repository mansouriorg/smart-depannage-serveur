import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { Permission, rolesWith } from '../../common/auth/permissions';
import { DASHBOARD_PAGES } from '../../common/auth/staff-pages';
import { poisonedJob } from '../../common/testing/poison';
import { withArrival } from '../../common/views/views';
import { AdminService } from '../admin/admin.service';
import { ClientInterventionsService } from '../client-interventions/client-interventions.service';
import { GuestService } from '../guest/guest.service';
import { MatchingService } from '../matching/matching.service';
import { UsersService } from '../users/users.service';

import { routeArtisanOf } from './route-query';

process.env.FRONTEND_URL = 'https://www.example.tn';

/**
 * What the readers are told about where the technician is and for how long that has been true (P3-05): the customer and the visitor get
 * an arrival time while the technician is on the way, the dispatcher gets a flag on a technician who has gone quiet.
 */

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const NEAR = { latitude: 36.8065, longitude: 10.1815 };
// about 5.5 km north of NEAR
const DOOR = { latitude: 36.8565, longitude: 10.1815 };

const jobWith = (over: { status?: string; positionAt?: Date | null; artisan?: any; destination?: any } = {}) =>
  poisonedJob({
    status: over.status ?? 'ARTISAN_ON_THE_WAY',
    ...(over.destination ?? DOOR),
    artisan: { id: 20, name: 'Ali', phone: '+21621111111', ...NEAR, positionAt: over.positionAt === undefined ? minutesAgo(1) : over.positionAt, ...(over.artisan ?? {}) },
  });

describe('the arrival, next to the view of a job (P3-05)', () => {
  it('is told while the technician is on the way: minutes from a fresh position', () => {
    const row = jobWith();
    const view: any = withArrival({ id: 1 }, row);

    expect(view.id).toBe(1);
    expect(view.arrival.state).toBe('fresh');
    expect(view.arrival.minutes).toBe(15);
    expect(view.arrival.ageMinutes).toBe(1);
  });

  it('the silence limit is exact: ten minutes to the millisecond is stale, a millisecond less is fresh', () => {
    const NOW = new Date('2026-11-01T12:00:00Z');
    const stateAt = (silenceMs: number) => (withArrival({}, jobWith({ positionAt: new Date(NOW.getTime() - silenceMs) }), NOW) as any).arrival.state;

    expect(stateAt(10 * 60_000 - 1)).toBe('fresh');
    expect(stateAt(10 * 60_000)).toBe('stale');
    expect(stateAt(10 * 60_000 + 1)).toBe('stale');
  });

  it('has the shape the shared package types by hand (Arrival): three fields, four states', () => {
    const states = new Set<string>();

    for (const row of [jobWith(), jobWith({ positionAt: minutesAgo(40) }), jobWith({ positionAt: null }), jobWith({ destination: { latitude: null, longitude: null } })]) {
      const arrival = (withArrival({}, row) as any).arrival;

      expect(Object.keys(arrival).sort()).toEqual(['ageMinutes', 'minutes', 'state']);
      states.add(arrival.state);
    }

    expect([...states].sort()).toEqual(['fresh', 'no-destination', 'stale', 'unknown']);
  });

  it('is told at no other stage: not before, not on arrival, not at work, not after', () => {
    for (const status of ['CREATED', 'WAITING_ADMIN_REVIEW', 'ASSIGNED', 'ARTISAN_ACCEPTED', 'ARTISAN_ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'PAID', 'CANCELLED']) {
      const view: any = withArrival({ id: 1 }, jobWith({ status }));

      expect(`${status}: ${'arrival' in view}`).toBe(`${status}: false`);
    }
  });

  it('is told under the other spelling of the status too', () => {
    expect((withArrival({ id: 1 }, jobWith({ status: 'ON_THE_WAY' })) as any).arrival.state).toBe('fresh');
  });

  it('says why there are no minutes from an old position, from a position of unknown time, and for a job with no point on the map', () => {
    const stale: any = withArrival({}, jobWith({ positionAt: minutesAgo(40) }));
    const unknown: any = withArrival({}, jobWith({ positionAt: null }));
    const nowhere: any = withArrival({}, jobWith({ destination: { latitude: null, longitude: null } }));

    expect(stale.arrival).toEqual({ state: 'stale', minutes: null, ageMinutes: 40 });
    expect(unknown.arrival).toEqual({ state: 'unknown', minutes: null, ageMinutes: null });
    expect(nowhere.arrival.state).toBe('no-destination');
    expect(nowhere.arrival.minutes).toBe(null);
  });

  it('uses the silence limit of the settings', () => {
    const before = process.env.LOCATION_STALE_MINUTES;

    process.env.LOCATION_STALE_MINUTES = '30';

    try {
      expect((withArrival({}, jobWith({ positionAt: minutesAgo(25) })) as any).arrival.state).toBe('fresh');
      expect((withArrival({}, jobWith({ positionAt: minutesAgo(31) })) as any).arrival.state).toBe('stale');
    } finally {
      if (before === undefined) delete process.env.LOCATION_STALE_MINUTES;
      else process.env.LOCATION_STALE_MINUTES = before;
    }
  });

  it('adds nothing when the job has no technician, and does not touch what it was given', () => {
    const view = { id: 1 };
    const withoutArtisan = withArrival(view, { ...jobWith(), artisan: null });

    expect(withoutArtisan).toBe(view);
    expect('arrival' in withArrival(view, jobWith())).toBe(true);
    expect(Object.keys(view)).toEqual(['id']);
    expect(withArrival(null as any, jobWith())).toBe(null);
  });
});

describe('the arrival on the tracking link and on the customer’s job (P3-05)', () => {
  function guest(job: any) {
    const prisma: any = { intervention: { findFirst: async () => job } };

    return new GuestService(prisma, {} as any, {} as any, new RateLimitService(), {} as any, {} as any, {} as any);
  }

  function customer(job: any) {
    const prisma: any = { intervention: { findUnique: async () => job } };

    return new ClientInterventionsService(prisma, {} as any, {} as any);
  }

  it('the visitor with the link: an arrival while on the way, none otherwise', async () => {
    const onTheWay: any = await guest(jobWith()).track(1, 'raw');
    const arrived: any = await guest(jobWith({ status: 'ARTISAN_ARRIVED' })).track(1, 'raw');

    expect(onTheWay.arrival.minutes).toBe(15);
    expect(onTheWay.arrival.state).toBe('fresh');
    expect('arrival' in arrived).toBe(false);
  });

  it('the customer: the same', async () => {
    const onTheWay: any = await customer(jobWith()).findOneMine(10, 1);
    const stale: any = await customer(jobWith({ positionAt: minutesAgo(60) })).findOneMine(10, 1);
    const accepted: any = await customer(jobWith({ status: 'ARTISAN_ACCEPTED' })).findOneMine(10, 1);

    expect(onTheWay.arrival.minutes).toBe(15);
    expect(stale.arrival).toEqual({ state: 'stale', minutes: null, ageMinutes: 60 });
    expect('arrival' in accepted).toBe(false);
  });

  it('the tracking link does not give the time the position was sent as a field of the technician, only the arrival', async () => {
    const answer: any = await guest(jobWith()).track(1, 'raw');

    expect(answer.artisan).not.toHaveProperty('positionAt');
    expect(JSON.stringify(answer.arrival)).not.toMatch(/latitude|longitude/);
  });
});

describe('the flag on a technician who has gone quiet (P3-05)', () => {
  const user = (id: number, positionAt: Date | null) => ({ id, name: `T${id}`, email: `t${id}@example.tn`, positionAt, artisanProfile: {} });

  async function list(rows: any[]) {
    const prisma: any = {
      user: { findMany: async () => rows, count: async () => rows.length },
      intervention: { groupBy: async () => [], findMany: async () => [] },
    };

    return (await new UsersService(prisma, {} as any, {} as any).findArtisans({ where: { role: 'ARTISAN' } as any })).data as any[];
  }

  it('fresh, stale or unknown for each row of the list', async () => {
    const rows = await list([user(1, minutesAgo(2)), user(2, minutesAgo(10)), user(3, minutesAgo(600)), user(4, null)]);
    const byId = Object.fromEntries(rows.map((row) => [row.id, [row.locationState, row.locationAgeMinutes]]));

    expect(byId[1]).toEqual(['fresh', 2]);
    expect(byId[2]).toEqual(['stale', 10]);
    expect(byId[3]).toEqual(['stale', 600]);
    expect(byId[4]).toEqual(['unknown', null]);
  });

  it('the limit is the one of the settings', async () => {
    const before = process.env.LOCATION_STALE_MINUTES;

    process.env.LOCATION_STALE_MINUTES = '3';

    try {
      const rows = await list([user(1, minutesAgo(2)), user(2, minutesAgo(4))]);

      expect(rows.map((row) => row.locationState)).toEqual(['fresh', 'stale']);
    } finally {
      if (before === undefined) delete process.env.LOCATION_STALE_MINUTES;
      else process.env.LOCATION_STALE_MINUTES = before;
    }
  });

  it('the dispatcher’s call for one technician gives the time, the age and the flag', async () => {
    const service: any = Object.create(AdminService.prototype);
    const profile = (positionAt: Date | null) => ({ id: 5, userId: 9, lastSeenAt: minutesAgo(1), availabilityStatus: 'ONLINE', isAcceptingJobs: true, user: { latitude: 36.8, longitude: 10.1, positionAt } });

    service.getArtisanDetail = async () => profile(minutesAgo(45));
    const stale = await service.getArtisanLocation(5);

    expect(stale.locationState).toBe('stale');
    expect(stale.locationAgeMinutes).toBe(45);
    expect(stale.positionAt instanceof Date).toBe(true);
    // the last sign of life of any kind is a different thing and is still given
    expect(stale.lastSeenAt instanceof Date).toBe(true);

    service.getArtisanDetail = async () => profile(null);
    const unknown = await service.getArtisanLocation(5);

    expect([unknown.locationState, unknown.locationAgeMinutes, unknown.positionAt]).toEqual(['unknown', null, null]);
  });

  it('the candidates of the matching carry the flag and the score does not depend on it', async () => {
    const candidate = (id: number, positionAt: Date | null) => ({
      id,
      name: `Artisan ${id}`,
      email: `a${id}@example.tn`,
      phone: `+2162000000${id}`,
      latitude: NEAR.latitude,
      longitude: NEAR.longitude,
      positionAt,
      artisanProfile: {
        serviceTypes: ['PLOMBIER'],
        specialty: null,
        specialties: [],
        serviceZones: [],
        availability: [],
        availabilityStatus: 'ONLINE',
        isAcceptingJobs: true,
        emergencyAvailable: true,
        maxActiveJobs: 3,
        verificationStatus: 'APPROVED',
        averageRating: 4.6,
        completedJobsCount: 10,
        cancelledJobsCount: 0,
      },
      artisanInterventions: [],
      artisanAppointments: [],
      artisanTimeBlocks: [],
    });

    const users = [candidate(1, minutesAgo(1)), candidate(2, minutesAgo(90)), candidate(3, null)];
    const prisma: any = { user: { findMany: async () => users }, intervention: { findUnique: async () => null } };
    const service = new MatchingService(prisma, {} as any);
    const found: any[] = await service.findMatchingArtisans(1, 'ADMIN' as any, { serviceType: 'PLOMBIER', ...DOOR } as any);
    const byId = Object.fromEntries(found.map((row) => [row.artisanId, row]));

    expect([byId[1].locationState, byId[1].locationAgeMinutes]).toEqual(['fresh', 1]);
    expect([byId[2].locationState, byId[2].locationAgeMinutes]).toEqual(['stale', 90]);
    expect([byId[3].locationState, byId[3].locationAgeMinutes]).toEqual(['unknown', null]);
    expect(byId[2].score).toBe(byId[1].score);
    expect(byId[3].score).toBe(byId[1].score);
  });
});

describe('the call that replays a route (P3-05)', () => {
  function service(job: any = { id: 40, artisanId: 7, artisan: { id: 7, name: 'Sami' }, createdAt: new Date() }) {
    const asked: any[] = [];
    const instance: any = Object.create(AdminService.prototype);

    instance.prisma = {
      intervention: { findUnique: async (args: any) => (args.where.id === job.id ? job : null) },
      artisanLocationPing: {
        findFirst: async () => null,
        findMany: async (args: any) => {
          asked.push(args.where);

          return [];
        },
        groupBy: async () => [],
      },
      user: { findMany: async () => [] },
    };

    return { instance, asked };
  }

  it('passes the technician asked for to the route, and none when none is asked for', async () => {
    const w = service();

    expect(((await w.instance.getInterventionRoute(40, 7)) as any).artisan.id).toBe(7);
    expect(w.asked[0]).toEqual({ interventionId: 40, artisanId: 7 });
    expect(((await w.instance.getInterventionRoute(40)) as any).artisan.id).toBe(7);
  });

  it('refuses a technician number the database could not hold, and a job number the same', async () => {
    const w = service();

    for (const bad of [0, -3, 1.5, 2_147_483_648, Number.NaN]) {
      let error: any;

      try {
        await w.instance.getInterventionRoute(40, bad);
      } catch (caught) {
        error = caught;
      }

      expect(`${bad}: ${error?.message}`).toBe(`${bad}: Technicien introuvable.`);
    }

    expect(w.asked.length).toBe(0);

    let jobError: any;

    try {
      await w.instance.getInterventionRoute(2_147_483_648, 7);
    } catch (caught) {
      jobError = caught;
    }

    expect(jobError?.message).toBe('Intervention introuvable.');
  });

  it('the controller reads the technician of the query as text and lets routeArtisanOf decide', () => {
    const controller = require('fs').readFileSync(require('path').join(__dirname, '../admin/admin.controller.ts'), 'utf8');

    expect(controller).toMatch(/@Query\('artisanId'\) artisanId\?: string/);
    expect(controller).toMatch(/return this\.adminService\.getInterventionRoute\(id, routeArtisanOf\(artisanId\)\);/);
    // a number typed query that is absent becomes NaN under the global pipe and is refused by ParseIntPipe: the usual call would be a 400
    expect(controller).not.toMatch(/@Query\('artisanId'[^)]*ParseIntPipe/);
  });
});

describe('the technician named in the query of the route call (P3-05)', () => {
  it('not there, or empty: nobody is named', () => {
    expect(routeArtisanOf(undefined)).toBeNull();
    expect(routeArtisanOf(null)).toBeNull();
    expect(routeArtisanOf('')).toBeNull();
  });

  it('whole digits are a number (the service decides whether it is a technician)', () => {
    expect(routeArtisanOf('7')).toBe(7);
    expect(routeArtisanOf('007')).toBe(7);
    expect(routeArtisanOf('0')).toBe(0);
    expect(routeArtisanOf('9999999999')).toBe(9999999999);
  });

  it('anything else is a 400, not a guess', () => {
    for (const odd of ['-1', '1e3', '0x10', ' 7 ', '7 ', '1.5', '1,5', 'abc', '7abc', 'NaN', 'Infinity', '٣', '+7', ['1', '2'], 7, true, {}]) {
      expect(() => routeArtisanOf(odd)).toThrow('Technicien invalide.');
    }
  });
});

describe('who may replay a route (P3-05)', () => {
  it('the dispatcher, the support and the admins, and nobody else', () => {
    expect(Permission.LOCATION_HISTORY).toBe('location.history');
    expect([...rolesWith(Permission.LOCATION_HISTORY)].sort()).toEqual(['ADMIN', 'DISPATCHER', 'SUPER_ADMIN', 'SUPPORT']);
  });

  it('the route is behind that permission (the table of every route is checked in route-access.golden)', () => {
    const controller = require('fs').readFileSync(require('path').join(__dirname, '../admin/admin.controller.ts'), 'utf8');

    expect(controller).toMatch(/@RequirePermission\(Permission\.LOCATION_HISTORY\)\s*@Get\('interventions\/:id\/route'\)/);
  });

  it('the page of the jobs in the dashboard lists the call, and is offered to exactly the roles that may make it', () => {
    const page = DASHBOARD_PAGES.find((candidate) => candidate.id === 'interventions')!;

    expect(page.calls.filter((call) => call.method === 'GET' && call.path === '/admin/interventions/:id/route').length).toBe(1);
    // The route is shown on the case file, which every role of the page opens: a role of the page that cannot read it would meet a refusal.
    expect([...page.roles].sort()).toEqual([...rolesWith(Permission.LOCATION_HISTORY)].sort());
  });
});
