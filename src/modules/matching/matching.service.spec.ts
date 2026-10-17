import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { MatchingService } from './matching.service';
import { ACTIVE_APPOINTMENT_STATUSES, ACTIVE_JOB_STATUSES } from '../assignment/artisan-availability';

/**
 * The matching proposes artisans and assigns one through the assignment path
 * (P1-05). It reads availability with the same rule as the assignment, so a name
 * it lists as free is never refused by the assignment for another reason.
 */

const MONDAY = '2026-10-19'; // Africa/Tunis is UTC+1 all year

function artisan(id: number, over: { profile?: any; jobs?: any[]; appointments?: any[]; blocks?: any[] } = {}) {
  return {
    id,
    name: `Artisan ${id}`,
    email: `a${id}@example.tn`,
    phone: `+2162000000${id}`,
    latitude: null,
    longitude: null,
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
      ...over.profile,
    },
    artisanInterventions: over.jobs ?? [],
    artisanAppointments: over.appointments ?? [],
    artisanTimeBlocks: over.blocks ?? [],
  };
}

const slot = (dayOfWeek: string, startTime: string, endTime: string, isAvailable = true) => ({
  dayOfWeek,
  startTime,
  endTime,
  isAvailable,
});

function makeWorld(users: any[], interventions: any[] = [], assignImpl?: (input: any) => Promise<any>) {
  const queries: any[] = [];
  const assigned: any[] = [];

  const prisma: any = {
    user: {
      findMany: async (args: any) => {
        queries.push(args);
        const ids = args.where.id?.in;
        return users.filter((user) => !ids || ids.includes(user.id));
      },
    },
    intervention: {
      findUnique: async ({ where }: any) => interventions.find((row) => row.id === where.id) ?? null,
    },
  };
  const assignment: any = {
    assign:
      assignImpl ??
      (async (input: any) => {
        assigned.push(input);
        return { intervention: { id: input.interventionId, status: 'ASSIGNED', artisanId: input.artisanId } };
      }),
  };

  return { service: new MatchingService(prisma, assignment), queries, assigned };
}

const job = (over: any = {}) => ({
  id: 8,
  serviceType: 'PLOMBIER',
  urgency: 'NORMAL',
  latitude: null,
  longitude: null,
  clientId: 2,
  status: 'WAITING_ADMIN_REVIEW',
  preferredDate: null,
  preferredStartTime: null,
  preferredEndTime: null,
  subService: null,
  appointment: null,
  ...over,
});

const at = (day: string, time: string) => `${day}T${time}:00.000Z`;

async function list(world: ReturnType<typeof makeWorld>, query: any) {
  return world.service.findMatchingArtisans(1, 'ADMIN' as any, { serviceType: 'PLOMBIER', ...query });
}

async function failure(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('expected a failure');
}

describe('the matching reads the availability with the shared rule', () => {
  it('an artisan with no schedule is free at any hour, a weekly schedule is the list of the hours', async () => {
    const world = makeWorld([
      artisan(1),
      artisan(2, { profile: { availability: [slot('MONDAY', '08:00', '17:00')] } }),
    ]);

    // Monday 09:00-10:00 in Tunis
    const monday = await list(world, { startsAt: at(MONDAY, '08:00'), endsAt: at(MONDAY, '09:00') });
    expect(monday.map((m: any) => [m.artisanId, m.isAvailable]).sort()).toEqual([[1, true], [2, true]]);

    // Sunday: the first has no schedule, the second works on Mondays only (the two services used to disagree here)
    const sunday = await list(world, { startsAt: at('2026-10-18', '08:00'), endsAt: at('2026-10-18', '09:00') });
    const byId = Object.fromEntries(sunday.map((m: any) => [m.artisanId, m]));

    expect(byId[1].isAvailable).toBe(true);
    expect(byId[2].isAvailable).toBe(false);
    expect(byId[2].hardIssues).toEqual(['Pas disponible sur ce créneau hebdomadaire.']);
  });

  it('the hours of the schedule are the hours on the wall in Tunis, not on the UTC clock', async () => {
    const world = makeWorld([artisan(2, { profile: { availability: [slot('MONDAY', '08:00', '17:00')] } })]);

    // 07:30-08:30 UTC is 08:30-09:30 in Tunis: inside
    const inside = await list(world, { startsAt: at(MONDAY, '07:30'), endsAt: at(MONDAY, '08:30') });
    // 06:30-07:30 UTC is 07:30-08:30 in Tunis: starts before the artisan does
    const outside = await list(world, { startsAt: at(MONDAY, '06:30'), endsAt: at(MONDAY, '07:30') });

    expect(inside[0].isAvailable).toBe(true);
    expect(outside[0].isAvailable).toBe(false);
  });

  it('slots that are all marked unavailable mean "never", not "no schedule"', async () => {
    const world = makeWorld([artisan(2, { profile: { availability: [slot('MONDAY', '08:00', '17:00', false)] } })]);

    const [match] = await list(world, { startsAt: at(MONDAY, '08:00'), endsAt: at(MONDAY, '09:00') });

    expect(match.isAvailable).toBe(false);
  });

  it('the other reasons to be refused are the assignment\'s sentences, in the same order', async () => {
    const world = makeWorld([
      artisan(1, {
        profile: { isAcceptingJobs: false, emergencyAvailable: false, maxActiveJobs: 1 },
        jobs: [{ id: 50, status: 'ASSIGNED' }],
        appointments: [{ id: 1 }],
        blocks: [{ id: 1 }],
      }),
    ]);

    const [match] = await list(world, {
      startsAt: at(MONDAY, '08:00'),
      endsAt: at(MONDAY, '09:00'),
      emergency: true,
    });

    expect(match.isAvailable).toBe(false);
    expect(match.hardIssues).toEqual([
      'Artisan déjà réservé sur ce créneau.',
      'Artisan indisponible sur ce créneau.',
      'Artisan ne prend pas de missions.',
      'Artisan non disponible pour urgence.',
      'Artisan au maximum de missions actives.',
    ]);
  });

  it('without a time, only the profile counts: accepting jobs, emergency, load', async () => {
    const world = makeWorld([
      artisan(1, { profile: { availability: [slot('MONDAY', '08:00', '09:00')] } }),
      artisan(2, { profile: { isAcceptingJobs: false } }),
      artisan(3, { jobs: [{ id: 1 }, { id: 2 }, { id: 3 }] }),
    ]);

    const matches = await list(world, {});
    const byId = Object.fromEntries(matches.map((m: any) => [m.artisanId, m]));

    expect(byId[1].isAvailable).toBe(true);
    expect(byId[2].hardIssues).toEqual(['Artisan ne prend pas de missions.']);
    expect(byId[3].hardIssues).toEqual(['Artisan au maximum de missions actives.']);
  });

  it('onlyAvailable drops the ones with an issue', async () => {
    const world = makeWorld([artisan(1), artisan(2, { profile: { isAcceptingJobs: false } })]);

    const matches = await list(world, { onlyAvailable: true });

    expect(matches.map((m: any) => m.artisanId)).toEqual([1]);
  });

  it('a kind of work the artisan does not do is not a fit, whatever the time', async () => {
    const world = makeWorld([artisan(1, { profile: { serviceTypes: ['ELECTRICIEN'] } })]);

    const [match] = await list(world, {});

    expect(match.serviceFit).toBe(false);
    expect(match.isAvailable).toBe(false);
  });
});

describe('what the matching asks the database', () => {
  it('only approved, active artisans are ever looked at', async () => {
    const world = makeWorld([artisan(1)]);

    await list(world, {});

    const where = world.queries[0].where;

    expect(where.role).toBe('ARTISAN');
    expect(where.isActive).toBe(true);
    expect(where.deletedAt).toBe(null);
    expect(where.artisanProfile).toEqual({ is: { verificationStatus: 'APPROVED' } });
  });

  it('the appointments that hold time and the jobs that count are the shared lists', async () => {
    const world = makeWorld([artisan(1)]);

    await list(world, { startsAt: at(MONDAY, '08:00'), endsAt: at(MONDAY, '09:00') });

    const include = world.queries[0].include;

    expect(include.artisanAppointments.where.status.in).toEqual(ACTIVE_APPOINTMENT_STATUSES);
    expect(include.artisanInterventions.where.status.in).toEqual(ACTIVE_JOB_STATUSES);
  });

  it('for a job, its own appointment and its own place in the load do not count against the artisan', async () => {
    const world = makeWorld([artisan(1)], [job()]);

    await world.service.findMatchingArtisansForIntervention(1, 'ADMIN' as any, 8, {
      startsAt: at(MONDAY, '08:00'),
      endsAt: at(MONDAY, '09:00'),
    } as any);

    const include = world.queries[0].include;

    expect(include.artisanAppointments.where.interventionId).toEqual({ not: 8 });
    expect(include.artisanInterventions.where.id).toEqual({ not: 8 });
  });

  it('a search without a job excludes nothing', async () => {
    const world = makeWorld([artisan(1)]);

    await list(world, { startsAt: at(MONDAY, '08:00'), endsAt: at(MONDAY, '09:00') });

    const include = world.queries[0].include;

    expect('interventionId' in include.artisanAppointments.where).toBe(false);
    expect('id' in include.artisanInterventions.where).toBe(false);
  });

  it('the hours a client prefers are read on the clock of Tunis (09:00 there is 08:00 UTC)', async () => {
    const world = makeWorld(
      [artisan(1)],
      [job({ preferredDate: new Date(`${MONDAY}T00:00:00.000Z`), preferredStartTime: '09:00', preferredEndTime: '10:00' })],
    );

    const result: any = await world.service.findMatchingArtisansForIntervention(1, 'ADMIN' as any, 8, {} as any);

    expect(new Date(result.requestedSlot.startsAt).toISOString()).toBe(`${MONDAY}T08:00:00.000Z`);
    expect(new Date(result.requestedSlot.endsAt).toISOString()).toBe(`${MONDAY}T09:00:00.000Z`);
  });

  it('the time asked for wins over the booked one, which wins over the preferred one', async () => {
    const booked = { startsAt: new Date(at(MONDAY, '12:00')), endsAt: new Date(at(MONDAY, '13:00')) };
    const world = makeWorld(
      [artisan(1)],
      [job({ appointment: booked, preferredDate: new Date(`${MONDAY}T00:00:00.000Z`), preferredStartTime: '09:00', preferredEndTime: '10:00' })],
    );

    const fromBooking: any = await world.service.findMatchingArtisansForIntervention(1, 'ADMIN' as any, 8, {} as any);
    const fromQuery: any = await world.service.findMatchingArtisansForIntervention(1, 'ADMIN' as any, 8, {
      startsAt: at(MONDAY, '14:00'),
      endsAt: at(MONDAY, '15:00'),
    } as any);

    expect(new Date(fromBooking.requestedSlot.startsAt).toISOString()).toBe(at(MONDAY, '12:00'));
    expect(new Date(fromQuery.requestedSlot.startsAt).toISOString()).toBe(at(MONDAY, '14:00'));
  });
});

describe('MatchingService.assignArtisan goes through the assignment path', () => {
  const dto = { startsAt: at(MONDAY, '08:00'), endsAt: at(MONDAY, '09:00'), adminNote: 'Code 1234' };

  it('only staff', async () => {
    const world = makeWorld([artisan(4)], [job()]);

    for (const role of ['CLIENT', 'ARTISAN']) {
      const error = await failure(world.service.assignArtisan(1, role as any, 8, 4, dto));

      expect(error instanceof ForbiddenException).toBe(true);
    }

    expect(world.assigned).toEqual([]);
  });

  it('an unknown job is a 404', async () => {
    const world = makeWorld([artisan(4)], []);

    const error = await failure(world.service.assignArtisan(1, 'ADMIN' as any, 8, 4, dto));

    expect(error instanceof NotFoundException).toBe(true);
    expect(world.assigned).toEqual([]);
  });

  it('an artisan who is not approved (or not an artisan, or disabled) is looked for as approved only, and is a 404', async () => {
    const world = makeWorld([], [job()]);

    const error = await failure(world.service.assignArtisan(1, 'ADMIN' as any, 8, 4, dto));

    expect(error instanceof NotFoundException).toBe(true);
    expect(world.assigned).toEqual([]);
    expect(world.queries[0].where.id).toEqual({ in: [4] });
    expect(world.queries[0].where.artisanProfile).toEqual({ is: { verificationStatus: 'APPROVED' } });
    expect(world.queries[0].where.isActive).toBe(true);
  });

  it('an artisan who does not do this work is a 400, with or without a time (it used to be checked only with one)', async () => {
    const world = makeWorld([artisan(4, { profile: { serviceTypes: ['ELECTRICIEN'] } })], [job()]);

    for (const body of [dto, {}]) {
      const error = await failure(world.service.assignArtisan(1, 'ADMIN' as any, 8, 4, body as any));

      expect(error instanceof BadRequestException).toBe(true);
      expect(error.message).toBe('Cet artisan ne correspond pas à cette intervention.');
    }

    expect(world.assigned).toEqual([]);
  });

  it('a fitting artisan is assigned by the assignment, with the time, the note and the staff member', async () => {
    const world = makeWorld([artisan(4)], [job()]);

    const result: any = await world.service.assignArtisan(1, 'ADMIN' as any, 8, 4, dto);

    expect(world.assigned.length).toBe(1);
    expect(world.assigned[0].interventionId).toBe(8);
    expect(world.assigned[0].artisanId).toBe(4);
    expect(world.assigned[0].actorId).toBe(1);
    expect(world.assigned[0].startsAt).toBe(dto.startsAt);
    expect(world.assigned[0].endsAt).toBe(dto.endsAt);
    expect(world.assigned[0].adminNote).toBe('Code 1234');
    expect(Object.keys(world.assigned[0].include).sort()).toEqual(['artisan', 'client']);
    expect(result.status).toBe('ASSIGNED');
  });

  it('whether the artisan is busy is the assignment\'s call, and its refusal comes back as it is', async () => {
    const refusal = new BadRequestException({ message: 'Cet artisan n’est pas disponible.', issues: ['Artisan déjà réservé sur ce créneau.'] });
    const world = makeWorld(
      [artisan(4, { appointments: [{ id: 1 }] })],
      [job()],
      async () => {
        throw refusal;
      },
    );

    const error = await failure(world.service.assignArtisan(1, 'ADMIN' as any, 8, 4, dto));

    expect(error).toBe(refusal);
  });

  it('a busy artisan who fits is not refused by the matching itself: a job that is theirs already must be re-assignable', async () => {
    const world = makeWorld([artisan(4, { jobs: [{ id: 1 }, { id: 2 }, { id: 3 }] })], [job()]);

    await world.service.assignArtisan(1, 'ADMIN' as any, 8, 4, dto);

    expect(world.assigned.length).toBe(1);
  });

  it('the live event is the assignment\'s: the matching no longer sends a second one', () => {
    const service: any = makeWorld([]).service;

    expect(service.realtime).toBe(undefined);
  });
});

describe('MatchingService.assignBestArtisan', () => {
  it('assigns the best artisan who is free', async () => {
    const world = makeWorld(
      [
        artisan(1, { profile: { isAcceptingJobs: false, averageRating: 5 } }),
        artisan(2, { profile: { averageRating: 4.0 } }),
        artisan(3, { profile: { averageRating: 4.9 } }),
      ],
      [job()],
    );

    await world.service.assignBestArtisan(1, 'ADMIN' as any, 8, {});

    expect(world.assigned.map((a) => a.artisanId)).toEqual([3]);
  });

  it('refuses when nobody is free', async () => {
    const world = makeWorld([artisan(1, { profile: { isAcceptingJobs: false } })], [job()]);

    const error = await failure(world.service.assignBestArtisan(1, 'ADMIN' as any, 8, {}));

    expect(error instanceof BadRequestException).toBe(true);
    expect(world.assigned).toEqual([]);
  });
});
