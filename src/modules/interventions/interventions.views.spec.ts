import { matchesWhere } from '../../common/testing/fake-tables';
import { leakedTo, poisonedJob, secret } from '../../common/testing/poison';
import { InterventionsService } from './interventions.service';

/**
 * P1-08: what the routes of the interventions answer to a customer and to an artisan with the job. Secrets are planted in
 * every place that is not theirs; a leak names itself. (P3-03 deleted the older routes that answered a visitor with the
 * link, the artisan on the board and one job read by its customer: `/guest/...`, `/client/interventions` and the case file
 * answer those, and their specs plant the same secrets.)
 */
function makeWorld(job: Record<string, unknown> = {}, others = false) {
  const asked: Record<string, any> = {};
  // With `others`, the table also holds a job of another customer and another artisan: the
  // queries have to ask for the reader's own, the fake does not hand over the table.
  const rows = () => [
    poisonedJob({ id: 1, ...job }),
    poisonedJob({ id: 2, ...job }),
    ...(others ? [poisonedJob({ id: 3, ...job, clientId: 11, artisanId: 21, description: secret('other.job.description') })] : []),
  ];
  const prisma: any = {
    intervention: {
      create: async (args: any) => poisonedJob({ clientId: args.data.client.connect.id, ...job }),
      findUnique: async () => poisonedJob(job),
      findFirst: async () => poisonedJob(job),
      findMany: async (args: any) => {
        asked.findMany = args;

        return rows().filter((row) => matchesWhere(row, args.where));
      },
      update: async () => poisonedJob(job),
    },
    artisanProfile: { findUnique: async () => ({ id: 7 }) },
  };
  const gateway: any = { sendInterventionStatus: () => undefined };
  const staffAlerts: any = { newRequest: async () => undefined };
  const service = new InterventionsService(prisma, gateway, {} as any, staffAlerts, {} as any);

  return { service, asked };
}

describe('what the interventions routes answer (P1-08)', () => {
  it('a request made by a signed-in customer: the customer\'s copy and the link, once', async () => {
    const answer: any = await makeWorld().service.create(10, { serviceType: 'PLOMBIER', description: 'Fuite', address: 'Tunis' } as any);

    expect(leakedTo(answer, 'client')).toEqual([]);
    expect(answer).not.toHaveProperty('trackingToken');
    expect(typeof answer.rawTrackingToken).toBe('string');
  });

  it('my missions (artisan): the artisan\'s copy', async () => {
    const answer: any[] = await makeWorld().service.findByArtisan(20);

    for (const job of answer) expect(leakedTo(job, 'artisan')).toEqual([]);
  });

  it('my missions are asked of the database for the artisan', async () => {
    const world = makeWorld({}, true);
    const answer: any[] = await world.service.findByArtisan(20);

    expect(world.asked.findMany.where).toEqual({ artisanId: 20 });
    expect(answer.map((job) => job.id)).toEqual([1, 2]);
    expect(JSON.stringify(answer)).not.toContain('other.job.description');
  });

  it('a request filed through the secure route by somebody of the back office: the row, as it is', async () => {
    const dto = { serviceType: 'PLOMBIER', description: 'Fuite', address: 'Tunis' } as any;
    const staff: any = await makeWorld().service.create(5, dto, 'SUPPORT');
    const customer: any = await makeWorld().service.create(10, dto, 'CLIENT');

    expect(staff.trackingToken).toBe(secret('job.trackingToken'));
    expect(customer).not.toHaveProperty('trackingToken');
    expect(typeof staff.rawTrackingToken).toBe('string');
    expect(typeof customer.rawTrackingToken).toBe('string');
  });
});
