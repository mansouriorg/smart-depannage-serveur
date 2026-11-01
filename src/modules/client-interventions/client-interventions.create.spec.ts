import { fakeSubServices } from '../../common/testing/catalog';
import { FakeTable } from '../../common/testing/fake-tables';
import { ClientInterventionsService } from './client-interventions.service';

process.env.FRONTEND_URL = 'https://www.example.tn';

function makeWorld(options: { eventsFail?: boolean; savedAddress?: any } = {}) {
  const interventions = new FakeTable({ defaults: () => ({ photos: [] }) });
  const order: string[] = [];
  const alerts: any[] = [];

  const prisma: any = {
    intervention: {
      create: async ({ data }: any) => {
        order.push('row');

        return { ...interventions.insert(data), client: { id: data.clientId, name: 'Sami' }, subService: null };
      },
    },
    clientAddress: { findUnique: async () => options.savedAddress ?? null },
    subService: fakeSubServices(),
  };
  const events: any = {
    create: async () => {
      order.push('event');
      if (options.eventsFail) throw new Error('events table locked');
    },
  };
  const staffAlerts: any = {
    newRequest: async (request: any) => {
      order.push('alert');
      alerts.push(request);
    },
  };

  return { service: new ClientInterventionsService(prisma, events, staffAlerts), interventions, order, alerts, catalog: prisma.subService };
}

const dto = () => ({ serviceType: 'PLOMBIER', description: 'Fuite', address: 'Tunis' }) as any;

describe('a request made by a signed-in client (P1-04)', () => {
  it('alerts the back office with the request, after the row exists', async () => {
    const w = makeWorld();

    const answer: any = await w.service.create(70, dto());

    expect(w.alerts.length).toBe(1);
    expect(w.alerts[0].id).toBe(answer.id);
    expect(w.order[0]).toBe('row');
    expect(w.order.includes('alert')).toBe(true);
  });

  it('the tracking link is absolute and built by the one function', async () => {
    const w = makeWorld();

    const answer: any = await w.service.create(70, dto());

    expect(answer.trackingUrl).toBe(`https://www.example.tn/demande/status?id=${answer.id}&token=${answer.rawTrackingToken}`);
  });

  it('a timeline line that cannot be written does not stop the alert or the answer', async () => {
    const w = makeWorld({ eventsFail: true });

    const answer: any = await w.service.create(70, dto());

    expect(w.alerts.length).toBe(1);
    expect(typeof answer.rawTrackingToken).toBe('string');
  });
});

describe('the point on the map of a request made from a saved address (P3-05)', () => {
  const saved = { id: 5, clientId: 70, latitude: 36.8, longitude: 10.18 };

  it('takes the point of the saved address when the request carries none', async () => {
    const w = makeWorld({ savedAddress: saved });

    const answer: any = await w.service.create(70, { ...dto(), savedAddressId: 5 });

    expect([answer.latitude, answer.longitude]).toEqual([36.8, 10.18]);
  });

  it('keeps the point the request itself carries, when it is a place', async () => {
    const w = makeWorld({ savedAddress: saved });

    const answer: any = await w.service.create(70, { ...dto(), savedAddressId: 5, latitude: 35.7, longitude: 10.8 });

    expect([answer.latitude, answer.longitude]).toEqual([35.7, 10.8]);
  });

  it('a point that is not a place (0, 0 from a phone with no fix) does not hide the one of the saved address', async () => {
    const w = makeWorld({ savedAddress: saved });

    const answer: any = await w.service.create(70, { ...dto(), savedAddressId: 5, latitude: 0, longitude: 0 });

    expect([answer.latitude, answer.longitude]).toEqual([36.8, 10.18]);
  });

  it('a saved address with no point, and a request with none, stay without one', async () => {
    const w = makeWorld({ savedAddress: { id: 5, clientId: 70, latitude: null, longitude: null } });

    const answer: any = await w.service.create(70, { ...dto(), savedAddressId: 5 });

    expect(answer.latitude ?? null).toBe(null);
    expect(answer.longitude ?? null).toBe(null);
  });

  it('a request with no saved address is written as before', async () => {
    const w = makeWorld({ savedAddress: saved });

    const answer: any = await w.service.create(70, { ...dto(), latitude: 36.1, longitude: 9.9 });

    expect([answer.latitude, answer.longitude]).toEqual([36.1, 9.9]);
  });
});

// P1-10: the sub-service is checked against the catalog before anything is written.
describe('the sub-service of a request made by a signed-in client (P1-10)', () => {
  const withService = (extra: Record<string, unknown>) => ({ ...dto(), ...extra }) as any;

  it('a sub-service of the trade asked for is kept on the request', async () => {
    const w = makeWorld();

    const answer: any = await w.service.create(70, withService({ subServiceId: 2 }));

    expect(answer.subServiceId).toBe(2);
    expect(w.interventions.rows.length).toBe(1);
  });

  it('a sub-service of another trade is a 400 and nothing is written, announced or alerted', async () => {
    const w = makeWorld();

    await expect(w.service.create(70, withService({ subServiceId: 4 }))).rejects.toThrow(/relève de/);

    expect(w.interventions.rows.length).toBe(0);
    expect(w.order).toEqual([]);
    expect(w.alerts.length).toBe(0);
  });

  it('a sub-service that does not exist, or is switched off, is a 400', async () => {
    const w = makeWorld();

    await expect(w.service.create(70, withService({ subServiceId: 999 }))).rejects.toThrow(/n'existe pas/);
    await expect(w.service.create(70, withService({ subServiceId: 3 }))).rejects.toThrow(/plus proposé/);

    expect(w.interventions.rows.length).toBe(0);
  });

  it('a sub-service that asks for photos is not refused for lacking them (they can only follow), and the answer says they are expected', async () => {
    const w = makeWorld();

    const needing: any = await w.service.create(70, withService({ subServiceId: 1 }));
    const plain: any = await w.service.create(70, withService({ subServiceId: 2 }));

    expect(needing.subServiceId).toBe(1);
    expect(needing.photosRequired).toBe(true);
    expect(needing.photos).toEqual([]);
    expect(plain.photosRequired).toBe(false);
    expect(w.interventions.rows.length).toBe(2);
  });

  it('the photos that come with the request are kept', async () => {
    const w = makeWorld();

    const answer: any = await w.service.create(70, withService({ subServiceId: 1, photos: ['/files/1/download'] }));

    expect(answer.photos).toEqual(['/files/1/download']);
    expect(answer.photosRequired).toBe(true);
  });

  it('a request that names no sub-service expects no photo and does not read the catalog', async () => {
    const w = makeWorld();

    const answer: any = await w.service.create(70, dto());

    expect(answer.photosRequired).toBe(false);

    expect(w.interventions.rows.length).toBe(1);
    expect(w.catalog.calls).toEqual([]);
  });
});
