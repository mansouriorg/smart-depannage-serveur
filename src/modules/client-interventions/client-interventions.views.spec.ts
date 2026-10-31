import { leakedTo, poisonedJob } from '../../common/testing/poison';
import { chatsOf } from '../../common/views/views';
import { ClientInterventionsService } from './client-interventions.service';

process.env.FRONTEND_URL = 'https://www.example.tn';

/**
 * P1-08: what the customer's routes answer, with a secret planted in every place a customer may not
 * read. A leak names itself ("SECRET<payment.adminNote>").
 */
function makeWorld(job: Record<string, unknown> = {}) {
  const asked: Record<string, any> = {};
  const prisma: any = {
    intervention: {
      create: async (args: any) => {
        asked.create = args;

        return poisonedJob({ clientId: args.data.clientId, ...job });
      },
      findMany: async (args: any) => {
        asked.findMany = args;

        return [poisonedJob(job), poisonedJob({ id: 2, ...job })];
      },
      findUnique: async (args: any) => {
        asked.findUnique = args;

        // transitionStatus first asks for the status and the artisan only.
        if (args.select) return { status: 'CREATED', artisanId: null };

        return poisonedJob(job);
      },
      findFirst: async (args: any) => {
        asked.findFirst = args;

        return poisonedJob(job);
      },
      update: async (args: any) => {
        asked.update = args;

        return poisonedJob({ ...job, status: 'CANCELLED' });
      },
    },
    clientAddress: { findUnique: async () => null },
    // the customer's cancel writes the job and its visit together
    $transaction: async (work: any) => work(prisma),
    $executeRaw: async () => 0,
    appointment: { findUnique: async () => null },
  };
  const events: any = { create: async () => undefined };
  const staffAlerts: any = { newRequest: async () => undefined };

  return { service: new ClientInterventionsService(prisma, events, staffAlerts), asked };
}

const dto = () => ({ serviceType: 'PLOMBIER', description: 'Fuite', address: 'Tunis' }) as any;

describe('what the customer\'s routes answer (P1-08)', () => {
  it('a new request: the customer\'s copy and the link, once; not the hash of the link', async () => {
    const w = makeWorld();
    const answer: any = await w.service.create(10, dto());

    expect(leakedTo(answer, 'client')).toEqual([]);
    expect(answer).not.toHaveProperty('trackingToken');
    expect(typeof answer.rawTrackingToken).toBe('string');
    expect(answer.trackingUrl).toContain(answer.rawTrackingToken);
  });

  it('my requests: each one clean, none with the conversation or the artisan\'s e-mail', async () => {
    const w = makeWorld();
    const answer: any[] = await w.service.findMine(10);

    expect(answer.length).toBe(2);

    for (const job of answer) {
      expect(leakedTo(job, 'client')).toEqual([]);
      expect(job.artisan).toEqual({ id: 20, name: 'Ali', phone: '+21621111111' });
    }

    // asked for the customer's own, and for the newest quote they have been sent (a draft is not theirs yet)
    expect(w.asked.findMany.where).toEqual({ clientId: 10 });
    expect(w.asked.findMany.include.quotes.where).toEqual({ status: { not: 'DRAFT' } });
  });

  it('one request: clean, with the conversation of my two chats only', async () => {
    const w = makeWorld();
    const answer: any = await w.service.findOneMine(10, 1);

    expect(leakedTo(answer, 'client')).toEqual([]);
    expect(answer.messages.map((message: any) => message.id)).toEqual([1, 2]);
    expect(answer.events.map((event: any) => event.id)).toEqual([1]);
    expect(answer.quotes.map((quote: any) => quote.id)).toEqual([1]);
  });

  it('asks the database for my two chats only, and not for a deleted message', async () => {
    const w = makeWorld();

    await w.service.findOneMine(10, 1);

    const messages = w.asked.findUnique.include.messages;

    expect(messages.where.deletedAt).toBeNull();
    expect(messages.where.audience.in).toEqual(chatsOf('client'));
    expect(messages.where.audience.in).not.toContain('INTERNAL_ADMIN');
    expect(messages.include.sender.select).toEqual({ id: true, name: true, role: true });
  });

  it('the tracking route of a signed-in customer is the same answer', async () => {
    const w = makeWorld();

    expect(leakedTo(await w.service.tracking(10, 1), 'client')).toEqual([]);
  });

  it('somebody else\'s request is refused, and nothing is answered', async () => {
    const w = makeWorld();

    await expect(w.service.findOneMine(99, 1)).rejects.toBeDefined();
  });

  it('cancelling: the customer\'s copy', async () => {
    const w = makeWorld();
    const answer: any = await w.service.cancel(10, 1);

    expect(leakedTo(answer, 'client')).toEqual([]);
    expect(answer.status).toBe('CANCELLED');
  });
});
