import { BadRequestException } from '@nestjs/common';
import { ArtisansService } from './artisans.service';

/** The weekly hours an artisan sends are checked before anything is written (P1-05). */
function makeService() {
  const writes: any[] = [];
  const tx: any = {
    artisanProfile: { update: async ({ data }: any) => ({ id: 1, userId: 4, ...data }) },
    artisanAvailabilitySlot: {
      deleteMany: async () => writes.push('delete'),
      createMany: async ({ data }: any) => writes.push(...data),
    },
  };
  const prisma: any = {
    artisanProfile: { findUnique: async () => ({ id: 1, userId: 4, availability: [] }) },
    $transaction: async (work: any) => work(tx),
  };

  return { service: new ArtisansService(prisma, {} as any, {} as any, {} as any, {} as any), writes };
}

async function failure(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('expected a failure');
}

describe('ArtisansService.updateAvailability', () => {
  it('writes slots that are in order', async () => {
    const w = makeService();

    await w.service.updateAvailability(4, { slots: [{ dayOfWeek: 'MONDAY', startTime: '08:00', endTime: '17:00' }] } as any);

    expect(w.writes.length).toBe(2); // the old ones deleted, the new one created
  });

  it('refuses a slot that ends before it starts, and writes nothing (not even the old slots deleted)', async () => {
    const w = makeService();

    const error = await failure(
      w.service.updateAvailability(4, {
        isAcceptingJobs: true,
        slots: [
          { dayOfWeek: 'MONDAY', startTime: '08:00', endTime: '17:00' },
          { dayOfWeek: 'TUESDAY', startTime: '17:00', endTime: '08:00' },
        ],
      } as any),
    );

    expect(error instanceof BadRequestException).toBe(true);
    expect(w.writes).toEqual([]);
  });

  it('a change that has no slots is not held up by them', async () => {
    const w = makeService();

    await w.service.updateAvailability(4, { isAcceptingJobs: false } as any);

    expect(w.writes).toEqual([]);
  });
});
