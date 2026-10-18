import { NotFoundException } from '@nestjs/common';

import { matchesWhere } from '../../common/testing/fake-tables';
import { leakedTo, poisonedJob, secret } from '../../common/testing/poison';
import { InterventionsService } from './interventions.service';

/**
 * P1-08: what the older routes of the interventions answer to a customer, a visitor with the link,
 * an artisan with the job and an artisan on the board. Secrets are planted in every place that
 * is not theirs; a leak names itself.
 */
function makeWorld(job: Record<string, unknown> = {}, others = false) {
  const issues: any[] = [];
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
    // a visitor with no account: nobody has the number, a guest profile is made
    user: {
      findMany: async () => [],
      count: async () => 0,
      create: async () => ({ id: 30, email: 'guest_x@guest.smart-depannage.local', phone: '55 111 222', isGuest: true }),
    },
  };
  const gateway: any = { sendInterventionIssue: (payload: any) => issues.push(payload), sendInterventionStatus: () => undefined };
  const staffAlerts: any = { newRequest: async () => undefined };
  const service = new InterventionsService(prisma, gateway, {} as any, staffAlerts, {} as any, {} as any, {} as any);

  return { service, issues, asked };
}

const open = { artisanId: null, status: 'CREATED' };

describe('what the interventions routes answer (P1-08)', () => {
  it('a request made by a signed-in customer: the customer\'s copy and the link, once', async () => {
    const answer: any = await makeWorld().service.create(10, { serviceType: 'PLOMBIER', description: 'Fuite', address: 'Tunis' } as any);

    expect(leakedTo(answer, 'client')).toEqual([]);
    expect(answer).not.toHaveProperty('trackingToken');
    expect(typeof answer.rawTrackingToken).toBe('string');
  });

  it('a request made by a visitor with no account: the visitor\'s copy and the link, no profile behind it', async () => {
    const answer: any = await makeWorld().service.create(null, { contactPhone: '55 111 222', contactName: 'Sami', serviceType: 'PLOMBIER', description: 'Fuite', address: 'Tunis' } as any);

    expect(leakedTo(answer, 'tracking')).toEqual([]);
    expect(answer).not.toHaveProperty('client');
    expect(answer).not.toHaveProperty('clientId');
    expect(answer).not.toHaveProperty('trackingToken');
    expect(typeof answer.rawTrackingToken).toBe('string');
  });

  it('my requests', async () => {
    const answer: any[] = await makeWorld().service.findByUser(10);

    expect(answer.length).toBe(2);
    for (const job of answer) expect(leakedTo(job, 'client')).toEqual([]);
  });

  it('one request, read by its customer: the customer\'s copy', async () => {
    const answer: any = await makeWorld().service.findOneForActor(1, { id: 10, role: 'CLIENT' } as any);

    expect(leakedTo(answer, 'client')).toEqual([]);
  });

  it('one request, read by the artisan who has it: the artisan\'s copy, with the customer to call', async () => {
    const answer: any = await makeWorld().service.findOneForActor(1, { id: 20, role: 'ARTISAN' } as any);

    expect(leakedTo(answer, 'artisan')).toEqual([]);
    expect(answer.client.phone).toBe('+21620000000');
  });

  it('one request, read by an artisan who does not have it: the board\'s copy of an open job, nothing for a taken one', async () => {
    const board: any = await makeWorld(open).service.findOneForActor(1, { id: 21, role: 'ARTISAN' } as any);

    expect(leakedTo(board, 'board')).toEqual([]);
    expect(board.client).toEqual({ name: 'Salah' });
    for (const column of ['contactPhone', 'contactEmail', 'contactName', 'accessInstructions', 'apartmentCode', 'clientId']) {
      expect(board).not.toHaveProperty(column);
    }

    await expect(makeWorld().service.findOneForActor(1, { id: 21, role: 'ARTISAN' } as any)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a customer who is not the owner finds nothing', async () => {
    await expect(makeWorld().service.findOneForActor(1, { id: 99, role: 'CLIENT' } as any)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('the board: no way to reach the customer, no door code, on any job', async () => {
    const answer: any[] = await makeWorld(open).service.findAllPending(21);

    expect(answer.length).toBe(2);

    for (const job of answer) {
      expect(leakedTo(job, 'board')).toEqual([]);
      expect(JSON.stringify(job)).not.toContain('+21620000000');
      expect(JSON.stringify(job)).not.toContain('salah@example.tn');
      expect(JSON.stringify(job)).not.toContain('4B-1234');
      expect(job.client).toEqual({ name: 'Salah' });
    }
  });

  it('my missions (artisan): the artisan\'s copy', async () => {
    const answer: any[] = await makeWorld().service.findByArtisan(20);

    for (const job of answer) expect(leakedTo(job, 'artisan')).toEqual([]);
  });

  it('my requests are asked of the database for the customer, so another customer\'s never leave it', async () => {
    const world = makeWorld({}, true);
    const answer: any[] = await world.service.findByUser(10);

    expect(world.asked.findMany.where).toEqual({ clientId: 10 });
    expect(answer.map((job) => job.id)).toEqual([1, 2]);
    expect(JSON.stringify(answer)).not.toContain('other.job.description');
  });

  it('my missions are asked of the database for the artisan', async () => {
    const world = makeWorld({}, true);
    const answer: any[] = await world.service.findByArtisan(20);

    expect(world.asked.findMany.where).toEqual({ artisanId: 20 });
    expect(answer.map((job) => job.id)).toEqual([1, 2]);
    expect(JSON.stringify(answer)).not.toContain('other.job.description');
  });

  it('the board asks for open jobs only', async () => {
    const world = makeWorld({ status: 'CREATED', artisanId: null }, true);

    await world.service.findAllPending(21);

    expect(JSON.stringify(world.asked.findMany.where.status)).toContain('CREATED');
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

  it('the tracking link, the review and the report of a problem: the visitor\'s copy', async () => {
    const world = makeWorld({ status: 'COMPLETED' });
    const tracking: any = await world.service.findByTrackingToken(1, 'raw');
    const review: any = await world.service.submitFeedback(1, 'raw', { rating: 5, isOnTime: true } as any);
    const issue: any = await makeWorld({ status: 'IN_PROGRESS', feedbackNotes: null }).service.reportActiveIssue(1, 'raw', 'La fuite continue');

    for (const answer of [tracking, review, issue]) {
      expect(leakedTo(answer, 'tracking')).toEqual([]);
      expect(answer).not.toHaveProperty('client');
      expect(answer).not.toHaveProperty('trackingToken');
    }
  });
});
