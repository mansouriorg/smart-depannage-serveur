import { FakeTable } from '../../common/testing/fake-tables';
import { ClientInterventionsService } from './client-interventions.service';

process.env.FRONTEND_URL = 'https://www.example.tn';

function makeWorld(options: { eventsFail?: boolean } = {}) {
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
    clientAddress: { findUnique: async () => null },
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

  return { service: new ClientInterventionsService(prisma, events, staffAlerts), interventions, order, alerts };
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
