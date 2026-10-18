import { InterventionsService } from './interventions.service';
import { fakeSubServices } from '../../common/testing/catalog';

/**
 * PATCH /interventions/:id can still say `serviceType`. A request that names a sub-service of
 * the catalog keeps the trade of that sub-service (P1-10): the change is checked like a new
 * request, so a plumbing request cannot be turned into a locksmith one with the plumbing
 * sub-service still on it.
 */

function makeWorld(stored: { serviceType: string; subServiceId: number | null }) {
  const subService = fakeSubServices();
  const updates: any[] = [];
  const row: any = {
    id: 8,
    status: 'WAITING_ADMIN_REVIEW',
    artisanId: null,
    clientId: 2,
    ...stored,
    client: { id: 2, name: 'Client', phone: null },
    artisan: null,
  };

  const prisma: any = {
    subService,
    intervention: {
      findUnique: async () => ({ ...row }),
      update: async ({ data }: any) => {
        updates.push(data);
        Object.assign(row, data);

        return { ...row };
      },
    },
  };
  const gateway: any = { sendInterventionStatus: () => undefined };
  const notifications: any = { sendSms: async () => undefined };

  return {
    service: new InterventionsService(prisma, gateway, notifications, {} as any, {} as any, {} as any, {} as any),
    updates,
    subService,
    row,
  };
}

async function failure(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('expected a failure');
}

describe('changing the service type of a request that has a sub-service (P1-10)', () => {
  it('another trade than the one of the sub-service is a 400 and nothing is written', async () => {
    const w = makeWorld({ serviceType: 'PLOMBIER', subServiceId: 2 });

    const error = await failure(w.service.update(8, { serviceType: 'SERRURIER' } as any));

    expect(error.getStatus()).toBe(400);
    expect(error.message).toMatch(/relève de/);
    expect(w.updates).toEqual([]);
    expect(w.row.serviceType).toBe('PLOMBIER');
  });

  it('the trade of the sub-service is let through', async () => {
    const w = makeWorld({ serviceType: 'PLOMBIER', subServiceId: 2 });

    await w.service.update(8, { serviceType: 'PLOMBIER', description: 'Fuite sous l’évier' } as any);

    expect(w.updates.length).toBe(1);
    expect(w.updates[0].description).toBe('Fuite sous l’évier');
  });

  it('a request with no sub-service can change trade, and the catalog is not read', async () => {
    const w = makeWorld({ serviceType: 'PLOMBIER', subServiceId: null });

    await w.service.update(8, { serviceType: 'SERRURIER' } as any);

    expect(w.updates.length).toBe(1);
    expect(w.updates[0].serviceType).toBe('SERRURIER');
    expect(w.subService.calls).toEqual([]);
  });

  it('an update that does not touch the service type does not read the catalog', async () => {
    const w = makeWorld({ serviceType: 'PLOMBIER', subServiceId: 2 });

    await w.service.update(8, { description: 'Nouvelle description' } as any);

    expect(w.updates.length).toBe(1);
    expect(w.subService.calls).toEqual([]);
  });
});
