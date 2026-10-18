import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { matchesWhere } from '../../common/testing/fake-tables';
import { leaked, leakedTo, nestedJob, poisonedQuote, secret } from '../../common/testing/poison';
import { QuotesController } from './quotes.controller';
import { QuotesService } from './quotes.service';

/**
 * P1-08: what the routes of the quotes answer to the customer and to the artisan. A secret is
 * planted in the writer of the quote, in the job inside it and in every column of the job that
 * the reader may not have; a leak names itself.
 */
function makeWorld() {
  const asked: Record<string, any[]> = { findMany: [], findUnique: [] };
  const quotes = () => [
    poisonedQuote({ id: 1 }),
    poisonedQuote({ id: 2, status: 'DRAFT', title: secret('quote.draft.title') }),
    poisonedQuote({ id: 3, status: 'DRAFT', createdById: 20, title: 'Mon brouillon' }),
  ];

  const prisma: any = {
    quote: {
      findUnique: async (args: any) => {
        asked.findUnique.push(args);

        return quotes().find((quote) => quote.id === args.where.id) ?? null;
      },
      findMany: async (args: any) => {
        asked.findMany.push(args);

        return quotes().filter((quote) => matchesWhere(quote, args.where));
      },
      update: async ({ where, data }: any) => ({ ...quotes().find((quote) => quote.id === where.id), ...data }),
      updateMany: async () => ({ count: 0 }),
    },
    quoteItem: { deleteMany: async () => ({ count: 0 }) },
    intervention: {
      findUnique: async () => ({ ...nestedJob(), status: 'QUOTE_SENT' }),
      update: async ({ data }: any) => ({ ...nestedJob(), ...data }),
    },
    user: { findUnique: async ({ where }: any) => ({ role: where.id === 20 ? 'ARTISAN' : 'SUPPORT' }) },
    message: { create: async () => ({ id: 1 }) },
    $transaction: async (work: any) => work(prisma),
  };
  const events: any = { create: async () => ({}) };
  const notifications: any = { notifyQuoteAccepted: async () => undefined };

  return { service: new QuotesService(prisma, events, notifications), asked };
}

describe('the quotes a customer reads (P1-08)', () => {
  it('the list of a job: the quotes that were sent, with nobody\'s name on them, and the database is not asked for drafts', async () => {
    const world = makeWorld();
    const answer: any[] = await world.service.findForClient(10, 1);

    expect(answer.map((quote) => quote.id)).toEqual([1]);
    expect(leakedTo(answer, 'client')).toEqual([]);
    expect(world.asked.findMany[0].where.status).toEqual({ not: 'DRAFT' });
    expect(world.asked.findMany[0].include).not.toHaveProperty('createdBy');
  });

  it('somebody else\'s job is not listed', async () => {
    await expect(makeWorld().service.findForClient(99, 1)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('accepting, refusing, asking for a change, asking a question: the quote, and the job inside it, are the customer\'s copy', async () => {
    const world = makeWorld();

    for (const answer of [
      await world.service.accept(10, 1, { note: 'ok' } as any),
      await world.service.reject(10, 1, { note: 'non' } as any),
      await world.service.requestModification(10, 1, { note: 'moins cher ?' } as any),
      await world.service.askQuestion(10, 1, { note: 'quand ?' } as any),
    ] as any[]) {
      expect(leakedTo(answer, 'client')).toEqual([]);
      expect(answer.id).toBe(1);
      expect(answer).not.toHaveProperty('createdBy');
      expect(answer).not.toHaveProperty('createdById');
      expect(answer.items.length).toBe(1);
      expect(answer.intervention).not.toHaveProperty('trackingToken');
      expect(answer.intervention.artisan).toEqual({ id: 20, name: 'Ali', phone: '+21621111111' });
    }
  });

  it('the download: the quote in the customer\'s copy, and a draft is not there to download', async () => {
    const world = makeWorld();
    const answer: any = await world.service.downloadForClient(10, 1);

    expect(leakedTo(answer, 'client')).toEqual([]);
    expect(answer.quote.id).toBe(1);
    await expect(world.service.downloadForClient(10, 2)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('the quotes an artisan reads (P1-08)', () => {
  it('the quote of one of their jobs: nobody\'s name on it, the job inside it is theirs', async () => {
    const answer: any = await makeWorld().service.findOne(1, { id: 20, role: 'ARTISAN' as any });

    expect(leakedTo(answer, 'artisan')).toEqual([]);
    expect(answer).not.toHaveProperty('createdBy');
    expect(answer.intervention.client.phone).toBe('+21620000000');
  });

  it('a draft that somebody else wrote is not shown to them; their own is', async () => {
    const world = makeWorld();

    await expect(world.service.findOne(2, { id: 20, role: 'ARTISAN' as any })).rejects.toBeInstanceOf(NotFoundException);
    expect((await world.service.findOne(3, { id: 20, role: 'ARTISAN' as any }) as any).title).toBe('Mon brouillon');
  });

  it('a job that is not theirs shows nothing', async () => {
    await expect(makeWorld().service.findOne(1, { id: 21, role: 'ARTISAN' as any })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('the back office reads the row as it is, with the name of the writer', async () => {
    const answer: any = await makeWorld().service.findOne(2, { id: 5, role: 'SUPPORT' as any });

    expect(answer.createdBy.email).toBe(secret('quote.createdBy.email'));
    expect(leaked(answer)).toContain('quote.draft.title');
  });
});

describe('the answers of the controller to the artisan and to the back office (P1-08)', () => {
  function makeController() {
    const row = () => poisonedQuote();
    const service: any = {
      createForIntervention: async () => row(),
      createDraftForIntervention: async () => row(),
      updateQuote: async () => row(),
      sendQuote: async () => row(),
      cancelQuote: async () => row(),
      setPdfUrl: async () => row(),
    };

    return new QuotesController(service);
  }

  it('every route an artisan may use gives the artisan\'s copy', async () => {
    const controller = makeController();
    const artisan = 'ARTISAN' as any;

    for (const answer of [
      await controller.createForIntervention(20, artisan, 1, {} as any),
      await controller.createDraftForIntervention(20, artisan, 1, {} as any),
      await controller.updateQuote(20, artisan, 1, {} as any),
      await controller.sendQuote(20, artisan, 1),
      await controller.cancelQuote(20, artisan, 1, {} as any),
      await controller.setPdfUrl(20, artisan, 1, 'https://x'),
    ] as any[]) {
      expect(leakedTo(answer, 'artisan')).toEqual([]);
      expect(answer).not.toHaveProperty('createdBy');
    }
  });

  it('the back office gets the row, whatever its role', async () => {
    const controller = makeController();

    for (const role of ['ADMIN', 'SUPER_ADMIN', 'SUPPORT', 'DISPATCHER'] as any[]) {
      const answer: any = await controller.sendQuote(5, role, 1);

      expect(answer.createdBy.email).toBe(secret('quote.createdBy.email'));
    }
  });
});
