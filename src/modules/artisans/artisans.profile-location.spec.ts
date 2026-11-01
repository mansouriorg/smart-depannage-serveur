import { ARTISAN_DONE_STATUSES } from './artisan-done';
import { ArtisansService } from './artisans.service';

/** The artisan's own profile and position, as the mobile app uses them (P1-15). */
function makeService(profile: any = {}, completedCount = 0) {
  const profileWrites: any[] = [];
  const userWrites: any[] = [];
  const counts: any[] = [];

  const row = { id: 1, userId: 4, availabilityStatus: 'OFFLINE', isAcceptingJobs: false, ...profile };

  const prisma: any = {
    artisanProfile: {
      findUnique: async () => row,
      update: async ({ data }: any) => {
        profileWrites.push(data);
        return { ...row, ...data };
      },
    },
    user: {
      update: async ({ data }: any) => {
        userWrites.push(data);
        return { id: 4, ...data };
      },
    },
    intervention: {
      count: async (args: any) => {
        counts.push(args);
        return completedCount;
      },
      // The jobs the technician is on, to tell which one a position belongs to (P3-05): none here.
      findMany: async () => [],
    },
    artisanLocationPing: {
      findFirst: async () => null,
      create: async ({ data }: any) => data,
    },
    $transaction: async (list: Promise<unknown>[]) => Promise.all(list),
  };

  return {
    service: new ArtisansService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any),
    profileWrites,
    userWrites,
    counts,
  };
}

describe('ArtisansService.updateLocation (P1-15)', () => {
  it('saves the position and the last time the artisan was seen', async () => {
    const w = makeService();

    await w.service.updateLocation(4, { latitude: 36.8, longitude: 10.18 } as any);

    expect(w.userWrites[0].latitude).toBe(36.8);
    expect(w.userWrites[0].longitude).toBe(10.18);
    expect(w.profileWrites[0].lastSeenAt instanceof Date).toBe(true);
  });

  it('an artisan who is offline stays offline when the phone reports its position', async () => {
    const w = makeService({ availabilityStatus: 'OFFLINE', isAcceptingJobs: false });

    await w.service.updateLocation(4, { latitude: 36.8, longitude: 10.18 } as any);

    // Nothing about availability is written, so nothing can change it.
    expect(w.profileWrites[0].availabilityStatus).toBeUndefined();
    expect(w.profileWrites[0].isAcceptingJobs).toBeUndefined();
    expect('lastSeenAt' in w.profileWrites[0]).toBe(true);
  });

  it('an artisan who is busy stays busy, and one who is online stays online', async () => {
    const busy = makeService({ availabilityStatus: 'BUSY', isAcceptingJobs: true });
    await busy.service.updateLocation(4, { latitude: 1, longitude: 2 } as any);
    expect(busy.profileWrites[0].availabilityStatus).toBeUndefined();

    const online = makeService({ availabilityStatus: 'ONLINE', isAcceptingJobs: true });
    await online.service.updateLocation(4, { latitude: 1, longitude: 2 } as any);
    expect(online.profileWrites[0].availabilityStatus).toBeUndefined();
    expect(online.profileWrites[0].isAcceptingJobs).toBeUndefined();
  });

  it('a status that is sent is still obeyed', async () => {
    const w = makeService({ availabilityStatus: 'OFFLINE' });

    await w.service.updateLocation(4, { latitude: 1, longitude: 2, availabilityStatus: 'ONLINE', isAcceptingJobs: true } as any);

    expect(w.profileWrites[0].availabilityStatus).toBe('ONLINE');
    expect(w.profileWrites[0].isAcceptingJobs).toBe(true);
  });
});

describe('ArtisansService.getMyProfile (P1-15)', () => {
  it('adds the number of jobs this artisan really closed, whatever the stored counter says', async () => {
    const w = makeService({ completedJobsCount: 0, specialty: 'Plombier' }, 12);

    const profile: any = await w.service.getMyProfile(4);

    expect(profile.completedMissions).toBe(12);
    expect(profile.completedJobsCount).toBe(0);
    expect(profile.specialty).toBe('Plombier');
  });

  it('counts the jobs of this artisan only, with the old spellings of the statuses', async () => {
    const w = makeService({}, 3);

    await w.service.getMyProfile(4);

    expect(w.counts.length).toBe(1);
    expect(w.counts[0].where.artisanId).toBe(4);

    const statuses: string[] = w.counts[0].where.status.in;

    expect(statuses.includes('COMPLETED')).toBe(true);
    expect(statuses.includes('IN_PROGRESS')).toBe(false);
    expect(statuses.includes('CANCELLED')).toBe(false);
  });

  it('counts a job as soon as the work is over: waiting for the customer, for the payment, paid, invoiced', async () => {
    const w = makeService({}, 3);

    await w.service.getMyProfile(4);

    const statuses: string[] = w.counts[0].where.status.in;

    for (const status of ['WAITING_CLIENT_VALIDATION', 'COMPLETED', 'PAYMENT_PENDING', 'PAID', 'INVOICE_SENT']) {
      expect(statuses.includes(status)).toBe(true);
    }

    for (const status of ['ASSIGNED', 'ARTISAN_ACCEPTED', 'ARTISAN_ON_THE_WAY', 'ARTISAN_ARRIVED', 'IN_PROGRESS', 'CANCELLED', 'DISPUTED', 'CREATED']) {
      expect(statuses.includes(status)).toBe(false);
    }
  });

  it('the statuses counted are the ones of the phone app\'s finished pile', () => {
    expect([...ARTISAN_DONE_STATUSES].sort()).toEqual(
      ['COMPLETED', 'INVOICE_SENT', 'PAID', 'PAYMENT_PENDING', 'WAITING_CLIENT_VALIDATION'],
    );
  });
});
