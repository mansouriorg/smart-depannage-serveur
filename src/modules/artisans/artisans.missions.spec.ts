import { matchesWhere } from '../../common/testing/fake-tables';
import { ArtisansService } from './artisans.service';

/**
 * The four actions of an artisan on a mission (accept, give back, on the way, arrived) live in
 * MissionActionsService (P1-06); the artisans service only hands them over, and the board
 * does not offer a mission the artisan refused.
 */
function makeService(profile: Record<string, any> = { specialties: ['PLOMBIER'] }) {
  const calls: Array<{ name: string; input: any }> = [];
  const queries: any[] = [];

  const record = (name: string) => async (input: any) => {
    calls.push({ name, input });

    return { from: name };
  };

  const missionActions: any = {
    accept: record('accept'),
    decline: record('decline'),
    onTheWay: record('onTheWay'),
    arrived: record('arrived'),
  };

  const prisma: any = {
    artisanProfile: {
      findUnique: async () => ({ id: 7, userId: 4, verificationStatus: 'APPROVED', availability: [], ...profile }),
    },
    intervention: {
      findMany: async (args: any) => {
        queries.push(args);

        return [];
      },
    },
  };

  return {
    service: new ArtisansService(prisma, {} as any, {} as any, {} as any, missionActions),
    calls,
    queries,
  };
}

describe('the artisan\'s routes hand the mission actions to MissionActionsService', () => {
  it('accept', async () => {
    const w = makeService();

    expect(await w.service.acceptMission(4, 12)).toEqual({ from: 'accept' });
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0].input.userId).toBe(4);
    expect(w.calls[0].input.interventionId).toBe(12);
    expect('client' in w.calls[0].input.include).toBe(true); // the mission as the app reads it
  });

  it('on the way and arrived', async () => {
    const w = makeService();

    expect(await w.service.markOnTheWay(4, 12)).toEqual({ from: 'onTheWay' });
    expect(await w.service.markArrived(4, 13)).toEqual({ from: 'arrived' });
    expect(w.calls.map((c) => [c.name, c.input.userId, c.input.interventionId])).toEqual([
      ['onTheWay', 4, 12],
      ['arrived', 4, 13],
    ]);
    expect(w.calls.every((c) => 'client' in c.input.include)).toBe(true);
  });

  it('give back: the reason and the note travel with it', async () => {
    const w = makeService();

    await w.service.rejectMission(4, 12, { reason: 'TOO_FAR', note: 'À 80 km' } as any);

    expect(w.calls).toEqual([
      { name: 'decline', input: { userId: 4, interventionId: 12, reason: 'TOO_FAR', note: 'À 80 km' } },
    ]);
  });
});

describe('the board of missions', () => {
  it('does not offer again a mission this artisan refused or gave back', async () => {
    const w = makeService();

    await w.service.getMissionBoard(4);

    const open = w.queries.find((q) => q.where.artisanId === null);

    expect(open.where.missionRejections).toEqual({ none: { artisanProfileId: 7 } });
    expect(open.where.serviceType).toEqual({ in: ['PLOMBIER'] }); // the other conditions stay
  });

  // P1-10: the words of the profile used to be handed to the database as service types, so a profile
  // that said "Plombier" (what every form writes) made the board fail.
  describe('the jobs of the artisan\'s trades (P1-10)', () => {
    const openJobs = async (profile: Record<string, any>) => {
      const w = makeService(profile);

      await w.service.getMissionBoard(4);

      return w.queries.find((q) => q.where.artisanId === null).where;
    };

    it('reads the words as the forms write them', async () => {
      const where = await openJobs({ specialty: 'Plombier', specialties: ['Plombier', 'Climatisation'], serviceTypes: [] });

      expect(where.serviceType).toEqual({ in: ['PLOMBIER', 'CLIMATICIEN'] });
    });

    it('reads the service types written on the profile', async () => {
      const where = await openJobs({ specialty: null, specialties: [], serviceTypes: ['VITRIER', 'CHAUFFAGISTE'] });

      expect(where.serviceType).toEqual({ in: ['VITRIER', 'CHAUFFAGISTE'] });
    });

    it('a word that names no trade shows the jobs of "Autre", instead of failing', async () => {
      const where = await openJobs({ specialty: 'Maçon', specialties: ['Maçon'], serviceTypes: [] });

      expect(where.serviceType).toEqual({ in: ['AUTRE'] });
    });

    it('a profile that names no trade at all is offered every job, as before', async () => {
      const where = await openJobs({ specialty: null, specialties: [], serviceTypes: [] });

      expect('serviceType' in where).toBe(false);
    });
  });

  it('the missions already given to the artisan are not filtered', async () => {
    const w = makeService();

    await w.service.getMissionBoard(4);

    const theirs = w.queries.filter((q) => q.where.artisanId === 4);

    expect(theirs.length > 0).toBe(true);
    expect(theirs.every((q) => !('missionRejections' in q.where))).toBe(true);
  });
});

// ----------------------------------------------------------
// What the independent review of P1-06 found
// ----------------------------------------------------------

const DAY = 24 * 3600_000;

const secrets = {
  adminInternalNotes: 'client difficile',
  adminReviewStartedAt: new Date(5),
  trackingToken: 'hash-of-the-link',
  cancelledById: 9,
};

/** A service whose database holds a few jobs, visits and refusals. */
function makeBoard(data: {
  jobs: any[];
  visits?: any[];
  refusals?: any[];
}) {
  const visitQueries: any[] = [];
  const lookups: any[] = [];

  const prisma: any = {
    artisanProfile: {
      findUnique: async () => ({ id: 7, userId: 4, verificationStatus: 'APPROVED', specialties: [], availability: [] }),
    },
    user: { findUnique: async () => ({ latitude: null, longitude: null }) },
    intervention: {
      findMany: async (args: any) =>
        data.jobs.filter((job) => {
          if (args.where.artisanId === null) return job.artisanId === null;
          if (typeof args.where.artisanId === 'number') return job.artisanId === args.where.artisanId;

          return false;
        }),
      findUnique: async (args: any) => {
        lookups.push(args);

        const job = data.jobs.find((row) => row.id === args.where.id);

        return job ? { ...job, ...('events' in (args.include ?? {}) ? { events: [{ id: 1 }] } : {}), ...('messages' in (args.include ?? {}) ? { messages: [{ id: 1, content: 'bonjour', audience: 'CLIENT_ARTISAN' }] } : {}) } : null;
      },
    },
    appointment: {
      findMany: async (args: any) => {
        visitQueries.push(args);

        // The conditions the service asked for are applied as written.
        return (data.visits ?? []).filter((visit) => matchesWhere(visit, args.where));
      },
    },
    artisanMissionRejection: {
      findFirst: async (args: any) =>
        (data.refusals ?? []).find(
          (row) => row.artisanProfileId === args.where.artisanProfileId && row.interventionId === args.where.interventionId,
        ) ?? null,
    },
  };

  return { service: new ArtisansService(prisma, {} as any, {} as any, {} as any, {} as any), visitQueries, lookups };
}

const job = (id: number, fields: Record<string, unknown> = {}) => ({
  id,
  artisanId: null,
  status: 'PENDING',
  address: 'Rue de Marseille, Tunis',
  latitude: null,
  longitude: null,
  ...secrets,
  ...fields,
});

describe('the board does not offer what the artisan cannot take', () => {
  it('a job with a visit still to come goes through the dispatcher: not offered', async () => {
    const w = makeBoard({
      jobs: [job(1), job(2), job(3)],
      visits: [
        { interventionId: 2, status: 'SCHEDULED', startsAt: new Date(Date.now() + DAY), endsAt: new Date(Date.now() + DAY + 3600_000) },
      ],
    });

    const board = await w.service.getMissionBoard(4);

    expect(board.availableJobs.map((row: any) => row.id)).toEqual([1, 3]);
    expect(w.visitQueries).toHaveLength(1);
  });

  it('a visit that is over or cancelled does not hide the job', async () => {
    const w = makeBoard({
      jobs: [job(1), job(2)],
      visits: [
        { interventionId: 1, status: 'SCHEDULED', startsAt: new Date(Date.now() - 3 * DAY), endsAt: new Date(Date.now() - 2 * DAY) },
        { interventionId: 2, status: 'CANCELLED', startsAt: new Date(Date.now() + DAY), endsAt: new Date(Date.now() + 2 * DAY) },
      ],
    });

    expect((await w.service.getMissionBoard(4)).availableJobs.map((row: any) => row.id)).toEqual([1, 2]);
  });

  it('with no open job there is nothing to look up', async () => {
    const w = makeBoard({ jobs: [] });

    await w.service.getMissionBoard(4);

    expect(w.visitQueries).toEqual([]);
  });
});

describe('the board and the details of a mission never carry the notes of the back office', () => {
  it('every list of the board', async () => {
    const w = makeBoard({
      jobs: [
        job(1),
        job(2, { artisanId: 4, status: 'ASSIGNED' }),
        job(3, { artisanId: 4, status: 'ACCEPTED' }),
        job(4, { artisanId: 4, status: 'IN_PROGRESS' }),
      ],
    });

    const board = await w.service.getMissionBoard(4);

    for (const list of [
      board.availableJobs,
      board.assignedJobs,
      board.acceptedJobs,
      board.activeJobs,
      board.completedJobs,
      board.cancelledJobs,
    ]) {
      expect(list.length > 0).toBe(true);

      for (const row of list as any[]) {
        for (const key of Object.keys(secrets)) expect(key in row).toBe(false);
        expect(row.address).toBe('Rue de Marseille, Tunis');
      }
    }
  });

  it('the details of a mission', async () => {
    const w = makeBoard({ jobs: [job(2, { artisanId: 4, status: 'ASSIGNED' })] });

    const row: any = await w.service.getMissionDetails(4, 2);

    for (const key of Object.keys(secrets)) expect(key in row).toBe(false);
  });
});

describe('the details of a mission that nobody has', () => {
  it('have no conversation and no timeline (they belong to the people on the job), in the shape the app reads', async () => {
    const w = makeBoard({ jobs: [job(1)] });

    const row: any = await w.service.getMissionDetails(4, 1);

    expect(row.events).toEqual([]);
    expect(row.messages).toEqual([]);
    expect(row.address).toBe('Rue de Marseille, Tunis');
    // They are not even read: asking for them and hiding them afterwards would be one mistake away.
    expect(w.lookups.every((lookup) => !('events' in (lookup.include ?? {})) && !('messages' in (lookup.include ?? {})))).toBe(true);
  });

  it('the mission of the artisan keeps its conversation and its timeline', async () => {
    const w = makeBoard({ jobs: [job(2, { artisanId: 4, status: 'ASSIGNED' })] });

    const row: any = await w.service.getMissionDetails(4, 2);

    expect(row.events).toEqual([{ id: 1 }]);
    expect(row.messages).toEqual([{ id: 1, content: 'bonjour', audience: 'CLIENT_ARTISAN' }]);
  });

  it('an artisan who refused or gave it back is not shown it again', async () => {
    const w = makeBoard({ jobs: [job(1)], refusals: [{ artisanProfileId: 7, interventionId: 1 }] });

    const error: any = await w.service.getMissionDetails(4, 1).catch((e: any) => e);

    expect(error.getStatus()).toBe(403);
  });

  it('the refusal of another artisan does not matter', async () => {
    const w = makeBoard({ jobs: [job(1)], refusals: [{ artisanProfileId: 99, interventionId: 1 }] });

    expect((await w.service.getMissionDetails(4, 1) as any).id).toBe(1);
  });

  it('a mission that is another artisan\'s is still a 403', async () => {
    const w = makeBoard({ jobs: [job(5, { artisanId: 9, status: 'ASSIGNED' })] });

    const error: any = await w.service.getMissionDetails(4, 5).catch((e: any) => e);

    expect(error.getStatus()).toBe(403);
  });
});

// ----------------------------------------------------------
// What the second independent review of P1-06 found
// ----------------------------------------------------------

const withContact = (id: number, fields: Record<string, unknown> = {}) =>
  job(id, {
    clientId: 1,
    contactName: 'Sami Ben Ali',
    contactPhone: '+21620111222',
    contactEmail: 'sami@mail.tn',
    client: { id: 1, name: 'Sami', phone: '+21620111222', email: 'sami@mail.tn' },
    payments: [{ id: 5, amount: 40 }],
    invoice: { id: 8 },
    quotes: [{ id: 3, amountTTC: 120 }],
    ...fields,
  });

const REACH = ['contactName', 'contactPhone', 'contactEmail'];

function assertNoWayToReachTheClient(row: any) {
  for (const key of REACH) expect(key in row).toBe(false);

  expect(row.client).toEqual({ name: 'Sami' }); // a first name to say hello, no phone, no e-mail, no id
  expect(JSON.stringify(row)).not.toMatch(/\+216|@mail\.tn/);
  expect(row.payments).toEqual([]);
  expect(row.invoice).toBe(null);
}

describe('an open mission shows no way to reach the client (the rule of the older list of open jobs)', () => {
  it('on the board', async () => {
    const w = makeBoard({ jobs: [withContact(1)] });

    const [open]: any[] = (await w.service.getMissionBoard(4)).availableJobs;

    assertNoWayToReachTheClient(open);
    expect(open.address).toBe('Rue de Marseille, Tunis'); // what the job is and where stays
    expect(open.quotes).toEqual([{ id: 3, amountTTC: 120 }]);
    expect('distanceKm' in open && 'navigationUrl' in open).toBe(true);
  });

  it('in the details', async () => {
    const w = makeBoard({ jobs: [withContact(1)] });

    assertNoWayToReachTheClient(await w.service.getMissionDetails(4, 1));
  });

  it('the mission of the artisan keeps the client\'s phone: they need to call', async () => {
    const w = makeBoard({ jobs: [withContact(2, { artisanId: 4, status: 'ASSIGNED' })] });

    const row: any = await w.service.getMissionDetails(4, 2);

    expect(row.client.phone).toBe('+21620111222');
    expect(row.contactPhone).toBe('+21620111222');
    expect(row.payments).toEqual([{ id: 5, amount: 40 }]);
  });

  it('a job of the artisan that is finished or cancelled is still theirs: the whole details', async () => {
    for (const status of ['COMPLETED', 'PAID', 'CANCELLED', 'PAYMENT_PENDING']) {
      const w = makeBoard({ jobs: [withContact(2, { artisanId: 4, status })] });

      const row: any = await w.service.getMissionDetails(4, 2);

      expect(row.client.phone).toBe('+21620111222');
      expect(row.events).toEqual([{ id: 1 }]);
      expect(row.messages).toHaveLength(1);
    }
  });
});

describe('a job that waits in the queue with the id of an artisan it was taken from', () => {
  const queued = (id: number, artisan: number, status = 'ADMIN_REVIEW') => withContact(id, { artisanId: artisan, status });

  it('is an open mission for that artisan too: no conversation, no timeline, no way to reach the client', async () => {
    const w = makeBoard({ jobs: [queued(1, 4)] });

    const row: any = await w.service.getMissionDetails(4, 1);

    assertNoWayToReachTheClient(row);
    expect(row.events).toEqual([]);
    expect(row.messages).toEqual([]);
    expect(w.lookups.every((lookup) => !('events' in (lookup.include ?? {})) && !('messages' in (lookup.include ?? {})))).toBe(true);
  });

  it('and for the others: they can look at it like at any open mission (it was a 403)', async () => {
    const w = makeBoard({ jobs: [queued(1, 9)] });

    const row: any = await w.service.getMissionDetails(4, 1);

    assertNoWayToReachTheClient(row);
    expect(row.id).toBe(1);
  });

  it('unless the artisan refused it', async () => {
    const w = makeBoard({ jobs: [queued(1, 9)], refusals: [{ artisanProfileId: 7, interventionId: 1 }] });

    expect(((await w.service.getMissionDetails(4, 1).catch((e: any) => e)) as any).getStatus()).toBe(403);
  });

  it('a job in the hands of another artisan is still not for anybody to look at', async () => {
    for (const status of ['ASSIGNED', 'ACCEPTED', 'ON_THE_WAY', 'IN_PROGRESS', 'COMPLETED']) {
      const w = makeBoard({ jobs: [queued(1, 9, status)] });

      expect(((await w.service.getMissionDetails(4, 1).catch((e: any) => e)) as any).getStatus()).toBe(403);
    }
  });
});

describe('what the other routes of the artisan answer carries no column of the back office', () => {
  function makeRoutes() {
    const row = { id: 2, artisanId: 4, status: 'ACCEPTED', ...secrets };
    const prisma: any = {
      artisanProfile: { findUnique: async () => ({ id: 7, userId: 4, verificationStatus: 'APPROVED' }) },
      intervention: {
        findUnique: async () => ({ id: 2, artisanId: 4, status: 'ACCEPTED' }),
        update: async () => ({ ...row }),
      },
    };

    return new ArtisansService(prisma, {} as any, {} as any, {} as any, {} as any);
  }

  it('the diagnostic and the materials', async () => {
    const service = makeRoutes();

    for (const answer of [
      await service.addDiagnostic(4, 2, { diagnosticNotes: 'Joint à changer' } as any),
      await service.addMaterialUsed(4, 2, { items: [{ name: 'Joint', quantity: 1 }] } as any),
    ] as any[]) {
      for (const key of Object.keys(secrets)) expect(key in answer).toBe(false);
      expect(answer.id).toBe(2);
    }
  });
});
