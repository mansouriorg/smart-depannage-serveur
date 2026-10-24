import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { leakedTo, poisonedJob, secret } from '../../common/testing/poison';
import { GuestService } from './guest.service';

process.env.FRONTEND_URL = 'https://www.example.tn';

/**
 * P1-08: what the routes of the tracking link answer to somebody who has no account. A secret is
 * planted in every place that is not theirs; a leak names itself.
 */
function makeWorld(job: Record<string, unknown> = {}) {
  const sentQuote = () => ({
    id: 1,
    interventionId: 1,
    title: 'Devis',
    amountHT: 100,
    amountTTC: 120,
    status: 'SENT',
    createdById: secret('quote.createdById'),
    createdBy: { id: 5, email: secret('quote.createdBy.email') },
    items: [],
  });
  const prisma: any = {
    intervention: {
      findFirst: async () => poisonedJob(job),
      findUnique: async () => ({ status: 'QUOTE_SENT', artisanId: null }),
      create: async ({ data }: any) => poisonedJob({ clientId: data.clientId, ...job }),
      update: async () => poisonedJob(job),
      // The row of the job is held while a quote is answered (P2-04).
      updateMany: async () => ({ count: 1 }),
    },
    quote: {
      findUnique: async () => sentQuote(),
      findFirst: async () => ({ ...sentQuote(), status: 'ACCEPTED' }),
      update: async ({ data }: any) => ({ ...sentQuote(), ...data }),
      // The other open quotes are cancelled when one is accepted (P2-04).
      updateMany: async () => ({ count: 0 }),
    },
    // The question is kept as a message to the support (P2-04).
    message: { create: async () => ({ id: 1 }) },
    payment: {
      create: async ({ data }: any) => ({ ...poisonedJob().payments[0], ...data }),
      // No payment is open on this job (one open payment per job, P2-03).
      findMany: async () => [],
    },
    // The ways of paying the company offers, and its account for a transfer (P2-06).
    companySettings: { findFirst: async () => ({ paymentMethods: ['ONLINE', 'CASH', 'BANK_TRANSFER'], rib: '08006012345678901234' }) },
    // What is left to pay is worked out from the document and the payments (P2-03): no invoice, no cash declared.
    invoice: { findUnique: async () => null, findFirst: async () => null },
    cashLedgerEntry: { findMany: async () => [] },
    // The job is locked while its payment is asked for.
    $executeRaw: async () => 1,
    // The opinion is saved with the job in one transaction (P1-16).
    review: {
      create: async ({ data }: any) => ({ id: 1, createdAt: new Date(), updatedAt: new Date(), ...data }),
    },
    $transaction: async (work: any) => work(prisma),
  };
  const notifications: any = { notifyQuoteAccepted: async () => undefined };
  const events: any = { create: async () => undefined };
  const staffAlerts: any = { newRequest: async () => undefined };
  const service: any = new GuestService(prisma, notifications, events, new RateLimitService(), staffAlerts, {} as any, {} as any);

  // The profile and the sending of the link are other tickets' business.
  service.findOrCreateGuestProfile = async () => ({ id: 10, name: 'Salah', email: 'salah@example.tn', phone: '+21620000000' });
  service.sendTrackingLink = async () => undefined;

  return service as GuestService;
}

const guestDto = () => ({ serviceType: 'PLOMBIER', description: 'Fuite', address: 'Tunis', contactName: 'Salah', contactPhone: '+21620000000' }) as any;

describe('what the routes of the tracking link answer (P1-08)', () => {
  it('a new request: the visitor\'s copy, with the link, and no account', async () => {
    const answer: any = await makeWorld().createGuestIntervention(guestDto());

    expect(leakedTo(answer, 'tracking')).toEqual([]);
    expect(answer.intervention).not.toHaveProperty('client');
    expect(answer.intervention).not.toHaveProperty('clientId');
    expect(answer.intervention).not.toHaveProperty('trackingToken');
    expect(typeof answer.rawTrackingToken).toBe('string');
    expect(answer.trackingUrl).toContain(answer.rawTrackingToken);
  });

  it('the tracking page', async () => {
    const answer: any = await makeWorld().track(1, 'raw');

    expect(leakedTo(answer, 'tracking')).toEqual([]);
    expect(answer).not.toHaveProperty('client');
    expect(answer.events.map((event: any) => event.id)).toEqual([1]);
    expect(answer.quotes.map((quote: any) => quote.id)).toEqual([1]);
  });

  it('the quotes: the ones that were sent, with nobody\'s name on them', async () => {
    const answer: any[] = await makeWorld().getQuotes(1, 'raw');

    expect(answer.map((quote) => quote.id)).toEqual([1]);
    expect(leakedTo(answer, 'tracking')).toEqual([]);
  });

  it('accepting, refusing, asking for a change or asking a question about a quote: the quote, with nobody\'s name on it', async () => {
    const world = makeWorld();
    const dto = { note: 'ok' } as any;

    for (const answer of [
      await world.acceptQuote(1, 1, 'raw', dto),
      await world.rejectQuote(1, 1, 'raw', dto),
      await world.requestQuoteModification(1, 1, 'raw', dto),
      await world.askQuoteQuestion(1, 1, 'raw', dto),
    ]) {
      expect(leakedTo(answer, 'tracking')).toEqual([]);
      expect((answer as any).id).toBe(1);
    }
  });

  it('a payment request: the payment as the customer may read it', async () => {
    const answer: any = await makeWorld().createGuestPayment(1, 'raw', { method: 'CASH', reference: 'R' } as any);

    expect(leakedTo(answer, 'tracking')).toEqual([]);
    expect(answer.payment.amount).toBe(120);
  });

  it('a review: the visitor\'s copy', async () => {
    const answer: any = await makeWorld({ status: 'COMPLETED', review: null }).submitFeedback(1, 'raw', { rating: 5, isOnTime: true } as any);

    expect(leakedTo(answer, 'tracking')).toEqual([]);
    expect(answer).not.toHaveProperty('client');
    expect(answer).not.toHaveProperty('trackingToken');
  });
});
