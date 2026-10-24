import { World, emptyWorld } from '../../common/testing/world';
import { resetLocale } from '../../common/locale/locale';
import { Decimal } from '../../common/testing/decimal-double';
import { COLLECT_CASH_IN, COLLECT_CASH_WORDS, foreignCurrencyWords, openPaymentWords } from './cash-ledger.types';
import { CashLedgerController } from './cash-ledger.controller';
import { reverseCollectionsOfPayment } from './cash-ledger-ops';
import { describeAmount } from '../payments/open-payment';
import { TICKET_STAFF_ROLES } from '../../common/auth/role-policy';
import { routeKey, scanController } from '../../common/testing/route-roles';
import { readSource } from '../../common/testing/source-scan';

/**
 * What is left to take on a job, for the artisan who holds it (P2-05): the figures and the reason of the cash screen of the app.
 * Run on the real service and a database that answers DECIMAL columns as Decimal objects.
 */
function desk(options: { quote?: number | null; status?: string } = {}) {
  const world = emptyWorld();
  const make = (role: string, name: string) => world.memory.plant('user', { role, name });
  const admin = make('ADMIN', 'Admin');
  const client = make('CLIENT', 'Client');
  const artisan = make('ARTISAN', 'Artisan');
  const other = make('ARTISAN', 'Autre artisan');
  const pending = make('ARTISAN', 'Artisan en attente');

  world.memory.plant('artisanProfile', { userId: artisan.id, verificationStatus: 'APPROVED' });
  world.memory.plant('artisanProfile', { userId: other.id, verificationStatus: 'APPROVED' });
  world.memory.plant('artisanProfile', { userId: pending.id, verificationStatus: 'PENDING_REVIEW' });

  const job = world.memory.plant('intervention', { clientId: client.id, artisanId: artisan.id, status: options.status ?? 'IN_PROGRESS', serviceType: 'PLOMBIER' });
  const amount = options.quote === undefined ? 119 : options.quote;
  const quote = amount === null ? null : world.memory.plant('quote', { interventionId: job.id, createdById: artisan.id, status: 'ACCEPTED', amountHT: amount, taxAmount: 0, amountTTC: amount });

  return { world, admin, client, artisan, other, pending, job, quote };
}

interface Refusal {
  status: number;
  message: string;
}

async function refusal(work: () => Promise<unknown>): Promise<Refusal | null> {
  try {
    await work();
  } catch (error) {
    const known = error as { getStatus?: () => number; message?: string };

    return { status: typeof known.getStatus === 'function' ? known.getStatus() : 500, message: String(known.message) };
  }

  return null;
}

const ARTISAN = 'ARTISAN';
const rowsOf = (world: World, model: string) => world.memory.rows(model);
const positionOf = (world: World, userId: number, jobId: number) => world.svc.cashLedger.getCashPosition(userId, ARTISAN as any, jobId);

let taps = 0;
const collect = (world: World, userId: number, jobId: number, amount: number) =>
  world.svc.cashLedger.collectCash(userId, ARTISAN as any, jobId, { amount, requestKey: `pos-tap-${(taps += 1)}-abcdef` } as any);

describe('what is left to take on a job, for its artisan (P2-05)', () => {
  beforeEach(() => resetLocale());

  it('says what the accepted quote asks, that nothing was received, and that the artisan may take it', async () => {
    const { world, artisan, job } = desk();

    expect(await positionOf(world, artisan.id, job.id)).toEqual({
      interventionId: job.id,
      currency: 'TND',
      document: 'QUOTE',
      total: 119,
      received: 0,
      remaining: 119,
      collected: 0,
      canCollect: true,
      reason: null,
    });
  });

  it('answers plain numbers, not the Decimal objects of the columns', async () => {
    const { world, artisan, job } = desk({ quote: 12.345 });
    const answer = await positionOf(world, artisan.id, job.id);

    expect(rowsOf(world, 'quote')[0].amountTTC).toBeInstanceOf(Decimal);
    expect(typeof answer.total).toBe('number');
    expect(typeof answer.received).toBe('number');
    expect(typeof answer.remaining).toBe('number');
    expect(typeof answer.collected).toBe('number');
    expect(answer.total).toBe(12.345);
  });

  it('takes off what the artisan declared, and says how much of it is theirs', async () => {
    const { world, artisan, job } = desk();

    await collect(world, artisan.id, job.id, 50.5);

    const answer = await positionOf(world, artisan.id, job.id);

    expect(answer.received).toBe(50.5);
    expect(answer.remaining).toBe(68.5);
    expect(answer.collected).toBe(50.5);
    expect(answer.canCollect).toBe(true);
  });

  it('is exact to the millime: 119 - 0.001 - 0.002 is 118.997', async () => {
    const { world, artisan, job } = desk();

    await collect(world, artisan.id, job.id, 0.001);
    await collect(world, artisan.id, job.id, 0.002);

    const answer = await positionOf(world, artisan.id, job.id);

    expect(answer.remaining).toBe(118.997);
    expect(answer.collected).toBe(0.003);
  });

  it('shows no cash as taken once the collection was taken back (the payment failed)', async () => {
    const { world, admin, artisan, job } = desk();
    const taken = await collect(world, artisan.id, job.id, 40);

    expect((await positionOf(world, artisan.id, job.id)).collected).toBe(40);

    await world.prisma.$transaction((tx: any) => reverseCollectionsOfPayment(tx, taken.payment.id, { userId: admin.id, reason: 'Échec' }));

    const answer = await positionOf(world, artisan.id, job.id);

    expect(answer.collected).toBe(0);
    expect(answer.received).toBe(0);
    expect(answer.remaining).toBe(119);
  });

  it('counts the payments that were paid, net of what was refunded, and not the ones that wait', async () => {
    const { world, client, artisan, job } = desk();

    world.memory.plant('payment', { interventionId: job.id, method: 'ONLINE', status: 'PAID', amount: 30, amountRefunded: 0, createdById: client.id });
    world.memory.plant('payment', { interventionId: job.id, method: 'ONLINE', status: 'PARTIALLY_REFUNDED', amount: 20, amountRefunded: 5, createdById: client.id });
    world.memory.plant('payment', { interventionId: job.id, method: 'ONLINE', status: 'PENDING', amount: 50, createdById: client.id });
    world.memory.plant('payment', { interventionId: job.id, method: 'CASH', provider: 'CASH', status: 'AWAITING_CONFIRMATION', amount: 40, createdById: client.id });
    world.memory.plant('payment', { interventionId: job.id, method: 'ONLINE', status: 'FAILED', amount: 9, createdById: client.id });

    const answer = await positionOf(world, artisan.id, job.id);

    expect(answer.received).toBe(45);
    expect(answer.remaining).toBe(74);
    expect(answer.collected).toBe(0);
  });

  it('uses the invoice, not the quote, when the job has an invoice that stands; a cancelled invoice is ignored', async () => {
    const { world, artisan, job } = desk();
    world.memory.plant('invoice', { interventionId: job.id, status: 'ISSUED', amountHT: 130, taxAmount: 0, amountTTC: 130 });

    const withInvoice = await positionOf(world, artisan.id, job.id);

    expect([withInvoice.document, withInvoice.total, withInvoice.remaining]).toEqual(['INVOICE', 130, 130]);

    rowsOf(world, 'invoice')[0].status = 'CANCELLED';

    const without = await positionOf(world, artisan.id, job.id);

    expect([without.document, without.total, without.remaining]).toEqual(['QUOTE', 119, 119]);
  });

  it('takes the latest accepted quote when the job has two', async () => {
    const { world, artisan, job } = desk();

    world.memory.plant('quote', { interventionId: job.id, createdById: artisan.id, status: 'ACCEPTED', amountHT: 200, taxAmount: 0, amountTTC: 200, createdAt: new Date('2099-01-01T00:00:00.000Z') });

    expect((await positionOf(world, artisan.id, job.id)).total).toBe(200);
  });

  it('a quote that was only sent is nothing to pay', async () => {
    const { world, artisan, job } = desk();

    rowsOf(world, 'quote')[0].status = 'SENT';

    expect(await positionOf(world, artisan.id, job.id)).toEqual({
      interventionId: job.id,
      currency: 'TND',
      document: null,
      total: null,
      received: 0,
      remaining: null,
      collected: 0,
      canCollect: false,
      reason: COLLECT_CASH_WORDS.noDocument,
    });
  });

  it('says there is nothing to collect on a job with no quote and no invoice', async () => {
    const { world, artisan, job } = desk({ quote: null });
    const answer = await positionOf(world, artisan.id, job.id);

    expect(answer.document).toBeNull();
    expect(answer.total).toBeNull();
    expect(answer.remaining).toBeNull();
    expect(answer.canCollect).toBe(false);
    expect(answer.reason).toBe('Aucun devis accepté ni facture: il n’y a pas de montant à encaisser.');
  });

  it('says a job that is paid in full has nothing left', async () => {
    const { world, client, artisan, job } = desk();

    world.memory.plant('payment', { interventionId: job.id, method: 'ONLINE', status: 'PAID', amount: 119, amountRefunded: 0, createdById: client.id });

    const answer = await positionOf(world, artisan.id, job.id);

    expect(answer.remaining).toBe(0);
    expect(answer.canCollect).toBe(false);
    expect(answer.reason).toBe('Cette mission est déjà payée.');
  });

  it('a job paid more than it asked shows a negative rest and no button', async () => {
    const { world, client, artisan, job } = desk();

    world.memory.plant('payment', { interventionId: job.id, method: 'ONLINE', status: 'PAID', amount: 120, amountRefunded: 0, createdById: client.id });

    const answer = await positionOf(world, artisan.id, job.id);

    expect(answer.remaining).toBe(-1);
    expect(answer.canCollect).toBe(false);
  });

  it('says the cash of a job in another currency than the ledger is not taken here', async () => {
    const { world, artisan, job } = desk();

    rowsOf(world, 'quote')[0].currency = 'EUR';

    const answer = await positionOf(world, artisan.id, job.id);

    expect(answer.currency).toBe('EUR');
    expect(answer.canCollect).toBe(false);
    expect(answer.reason).toBe('Cette mission est facturée en EUR, le registre est tenu en TND.');
    expect(answer.reason).toBe(foreignCurrencyWords('EUR', 'TND'));
  });

  it('says a job that a payout already paid takes no more cash, and only that one', async () => {
    const { world, client, artisan, job } = desk();
    const financials = (interventionId: number) => world.memory.plant('interventionFinancials', { interventionId, totalPrice: 119, platformCommission: 0, artisanPayout: 119, netRevenue: 0, companyMargin: 0 });
    const payout = world.memory.plant('artisanPayout', { artisanId: artisan.id, status: 'PAID', periodStart: new Date('2026-10-01T00:00:00.000Z'), periodEnd: new Date('2026-10-31T00:00:00.000Z') });
    const elsewhere = world.memory.plant('intervention', { clientId: client.id, artisanId: artisan.id, status: 'PAID', serviceType: 'PLOMBIER' });

    world.memory.plant('artisanPayoutItem', { payoutId: payout.id, financialId: financials(elsewhere.id).id, interventionId: elsewhere.id, amount: 119 });
    expect((await positionOf(world, artisan.id, job.id)).canCollect).toBe(true);

    world.memory.plant('artisanPayoutItem', { payoutId: payout.id, financialId: financials(job.id).id, interventionId: job.id, amount: 119 });

    const answer = await positionOf(world, artisan.id, job.id);

    expect(answer.canCollect).toBe(false);
    expect(answer.reason).toBe(COLLECT_CASH_WORDS.inPaidPayout);

    // a payout that is not paid yet is made again: it does not stop the cash
    rowsOf(world, 'artisanPayout')[0].status = 'READY';
    expect((await positionOf(world, artisan.id, job.id)).canCollect).toBe(true);
  });

  it('offers the cash only in the statuses where the collection takes it', async () => {
    const outcomes: string[] = [];

    for (const status of ['ASSIGNED', 'ARTISAN_ACCEPTED', 'ARTISAN_ON_THE_WAY', 'ARTISAN_ARRIVED', 'IN_PROGRESS', 'WAITING_CLIENT_VALIDATION', 'COMPLETED', 'PAYMENT_PENDING', 'PAID', 'INVOICE_SENT', 'CANCELLED', 'DISPUTED', 'WAITING_ADMIN_REVIEW']) {
      const { world, artisan, job } = desk({ status });
      const answer = await positionOf(world, artisan.id, job.id);

      outcomes.push(`${status}: ${answer.canCollect ? 'yes' : answer.reason}`);
    }

    const no = COLLECT_CASH_WORDS.wrongStatus;

    expect(outcomes).toEqual([
      `ASSIGNED: ${no}`,
      `ARTISAN_ACCEPTED: ${no}`,
      `ARTISAN_ON_THE_WAY: ${no}`,
      'ARTISAN_ARRIVED: yes',
      'IN_PROGRESS: yes',
      'WAITING_CLIENT_VALIDATION: yes',
      'COMPLETED: yes',
      'PAYMENT_PENDING: yes',
      'PAID: yes',
      'INVOICE_SENT: yes',
      `CANCELLED: ${no}`,
      `DISPUTED: ${no}`,
      `WAITING_ADMIN_REVIEW: ${no}`,
    ]);
    expect([...COLLECT_CASH_IN].sort()).toEqual(['ARTISAN_ARRIVED', 'COMPLETED', 'INVOICE_SENT', 'IN_PROGRESS', 'PAID', 'PAYMENT_PENDING', 'WAITING_CLIENT_VALIDATION']);
  });

  it('reads a status in its old spelling too', async () => {
    const { world, artisan, job } = desk({ status: 'ARRIVED' });

    expect((await positionOf(world, artisan.id, job.id)).canCollect).toBe(true);

    rowsOf(world, 'intervention')[0].status = 'NOT_A_STATUS';

    expect((await positionOf(world, artisan.id, job.id)).reason).toBe(COLLECT_CASH_WORDS.wrongStatus);
  });

  it('names the wrong status first, before the missing document', async () => {
    const { world, artisan, job } = desk({ quote: null, status: 'ASSIGNED' });

    expect((await positionOf(world, artisan.id, job.id)).reason).toBe(COLLECT_CASH_WORDS.wrongStatus);
  });

  it('says what the collection says: the reason is the refusal, and no reason means the rest can be taken', async () => {
    const cases: Array<() => ReturnType<typeof desk>> = [
      () => desk(),
      () => desk({ status: 'ASSIGNED' }),
      () => desk({ quote: null }),
      () => {
        const d = desk();

        rowsOf(d.world, 'quote')[0].currency = 'EUR';

        return d;
      },
      () => {
        const d = desk();

        d.world.memory.plant('payment', { interventionId: d.job.id, method: 'ONLINE', status: 'PAID', amount: 119, amountRefunded: 0, createdById: d.client.id });

        return d;
      },
      () => {
        const d = desk();
        const financials = d.world.memory.plant('interventionFinancials', { interventionId: d.job.id, totalPrice: 119, platformCommission: 0, artisanPayout: 119, netRevenue: 0, companyMargin: 0 });
        const payout = d.world.memory.plant('artisanPayout', { artisanId: d.artisan.id, status: 'PAID', periodStart: new Date('2026-10-01T00:00:00.000Z'), periodEnd: new Date('2026-10-31T00:00:00.000Z') });

        d.world.memory.plant('artisanPayoutItem', { payoutId: payout.id, financialId: financials.id, interventionId: d.job.id, amount: 119 });

        return d;
      },
    ];

    const told: string[] = [];

    for (const make of cases) {
      const { world, artisan, job } = make();
      const position = await positionOf(world, artisan.id, job.id);
      const answer = await refusal(() => collect(world, artisan.id, job.id, position.remaining !== null && position.remaining > 0 ? position.remaining : 1));

      told.push(position.canCollect ? `yes -> ${answer === null ? 'taken' : answer.message}` : `${position.reason} -> ${answer === null ? 'taken' : answer.message}`);
    }

    expect(told).toEqual([
      'yes -> taken',
      `${COLLECT_CASH_WORDS.wrongStatus} -> ${COLLECT_CASH_WORDS.wrongStatus}`,
      `${COLLECT_CASH_WORDS.noDocument} -> ${COLLECT_CASH_WORDS.noDocument}`,
      `${foreignCurrencyWords('EUR', 'TND')} -> ${foreignCurrencyWords('EUR', 'TND')}`,
      `${COLLECT_CASH_WORDS.alreadyPaid} -> ${COLLECT_CASH_WORDS.alreadyPaid}`,
      `${COLLECT_CASH_WORDS.inPaidPayout} -> ${COLLECT_CASH_WORDS.inPaidPayout}`,
    ]);
  });

  it('writes nothing', async () => {
    const { world, artisan, job } = desk();

    await collect(world, artisan.id, job.id, 10);

    const before = ['payment', 'cashLedgerEntry', 'quote', 'intervention', 'interventionEvent'].map((model) => JSON.stringify(rowsOf(world, model)));

    await positionOf(world, artisan.id, job.id);
    await positionOf(world, artisan.id, job.id);

    expect(['payment', 'cashLedgerEntry', 'quote', 'intervention', 'interventionEvent'].map((model) => JSON.stringify(rowsOf(world, model)))).toEqual(before);
  });

  it('does not tell a mission of another artisan from one that does not exist', async () => {
    const { world, other, job } = desk();
    const mine = await refusal(() => positionOf(world, other.id, job.id));
    const none = await refusal(() => positionOf(world, other.id, 999_999));

    expect(mine).toEqual({ status: 404, message: 'Mission introuvable.' });
    expect(none).toEqual(mine);
  });

  it('turns away a job that nobody holds, and a number that is no row', async () => {
    const { world, artisan, job } = desk();

    rowsOf(world, 'intervention')[0].artisanId = null;

    expect((await refusal(() => positionOf(world, artisan.id, job.id)))?.status).toBe(404);

    for (const bad of [0, -1, 1.5, Number.NaN, 2_147_483_648, '3' as unknown as number]) {
      expect(`${String(bad)}: ${(await refusal(() => positionOf(world, artisan.id, bad)))?.status}`).toBe(`${String(bad)}: 404`);
    }
  });

  it('is for artisans whose profile is approved, and for no one else', async () => {
    const { world, admin, client, pending, job } = desk();

    for (const [role, id] of [['CLIENT', client.id], ['ADMIN', admin.id], ['ACCOUNTANT', admin.id], ['DISPATCHER', admin.id], ['SUPPORT', admin.id]] as const) {
      expect(`${role}: ${(await refusal(() => world.svc.cashLedger.getCashPosition(id, role as any, job.id)))?.status}`).toBe(`${role}: 403`);
    }

    expect(await refusal(() => positionOf(world, pending.id, job.id))).toEqual({ status: 403, message: 'Votre profil artisan doit être approuvé pour effectuer cette action.' });

    rowsOf(world, 'artisanProfile').length = 0;

    expect((await refusal(() => positionOf(world, pending.id, job.id)))?.status).toBe(404);
  });

  it('only reads: the method has no transaction and no write', () => {
    const service = readSource('modules/cash-ledger/cash-ledger.service.ts');
    const start = service.indexOf('async getCashPosition');
    const body = service.slice(start, service.indexOf('/** The ledger of the signed-in artisan. */', start));
    const reader = readSource('modules/cash-ledger/cash-position.ts');

    expect(start).toBeGreaterThan(0);
    expect(reader).toContain('export async function cashPositionOf');
    expect(reader.length).toBeGreaterThan(200);

    for (const text of [body, reader]) {
      expect(text).not.toMatch(/\$transaction|\.create\(|\.update\(|\.updateMany\(|\.delete\(|\.upsert\(|lockJob|lockCashLedger|lockPayouts/);
    }
  });

  it('the collection and the position share the words: no refusal is written twice', () => {
    const service = readSource('modules/cash-ledger/cash-ledger.service.ts');
    const ops = readSource('modules/cash-ledger/cash-position.ts');

    for (const words of Object.values(COLLECT_CASH_WORDS)) {
      expect(service.includes(words)).toBe(false);
      expect(ops.includes(words)).toBe(false);
    }

    expect(service).toContain('COLLECT_CASH_WORDS.wrongStatus');
    expect(service).toContain('COLLECT_CASH_WORDS.inPaidPayout');
    expect(service).toContain('COLLECT_CASH_WORDS.noDocument');
    expect(service).toContain('COLLECT_CASH_WORDS.alreadyPaid');
    expect(service).toContain('foreignCurrencyWords(currency, currencyCode())');
    expect(ops).toContain('COLLECT_CASH_WORDS.wrongStatus');
    expect(ops).toContain('COLLECT_CASH_WORDS.inPaidPayout');
    expect(ops).toContain('COLLECT_CASH_WORDS.noDocument');
    expect(ops).toContain('COLLECT_CASH_WORDS.alreadyPaid');
    expect(ops).toContain('foreignCurrencyWords(currency, ledgerCurrency)');
    expect(service).toContain('openPaymentWords(describeAmount(blocking))');
    expect(ops).toContain('openPaymentWords(describeAmount(blocking))');
    expect(service).toContain('paymentsInTheWayOfCash(payments)');
    expect(ops).toContain('paymentsInTheWayOfCash(position.payments)');
    // the sentence of the open payment is written once, in the types
    expect(service.includes('est déjà en attente pour cette mission')).toBe(false);
    expect(ops.includes('est déjà en attente pour cette mission')).toBe(false);
  });

  it('the sentences the artisan reads are fixed', () => {
    expect(COLLECT_CASH_WORDS).toEqual({
      wrongStatus: 'Les espèces ne peuvent être encaissées qu’une fois sur place, pendant ou après le travail.',
      inPaidPayout: 'Un payout déjà payé comprend cette mission: contactez l’administration pour enregistrer cet encaissement.',
      noDocument: 'Aucun devis accepté ni facture: il n’y a pas de montant à encaisser.',
      alreadyPaid: 'Cette mission est déjà payée.',
    });
    expect(foreignCurrencyWords('EUR', 'TND')).toBe('Cette mission est facturée en EUR, le registre est tenu en TND.');
    expect(openPaymentWords('120,000 TND par virement')).toBe('Un paiement de 120,000 TND par virement est déjà en attente pour cette mission: contactez l’administration.');
  });

  describe('another way of paying that is open on the job', () => {
    const bothSay = async (d: ReturnType<typeof desk>, amount = 1) => {
      const position = await positionOf(d.world, d.artisan.id, d.job.id);
      const answer = await refusal(() => collect(d.world, d.artisan.id, d.job.id, amount));

      return { position, answer };
    };

    it('a transfer that waits for its confirmation: the position says no, with the words of the refusal', async () => {
      const d = desk();

      d.world.memory.plant('payment', { interventionId: d.job.id, method: 'BANK_TRANSFER', status: 'AWAITING_CONFIRMATION', amount: 119, currency: 'TND', createdById: d.client.id });

      const { position, answer } = await bothSay(d);

      expect(position.canCollect).toBe(false);
      expect(position.reason).toBe(openPaymentWords(describeAmount({ amount: 119, currency: 'TND' })));
      expect(position.reason).toMatch(/^Un paiement de .*119.* est déjà en attente pour cette mission: contactez l’administration\.$/);
      expect(answer?.status).toBe(409);
      expect(answer?.message).toBe(position.reason);
    });

    it('an online payment that a provider took and that is not paid yet: the same', async () => {
      const d = desk();

      d.world.memory.plant('payment', { interventionId: d.job.id, method: 'ONLINE_CARD', status: 'PENDING', amount: 60, currency: 'TND', providerPaymentId: 'pi_123', createdById: d.client.id });

      const { position, answer } = await bothSay(d);

      expect(position.canCollect).toBe(false);
      expect(answer?.status).toBe(409);
      expect(answer?.message).toBe(position.reason);
    });

    it('an online request that nobody can pay is not in the way: the position says yes and the collection cancels it', async () => {
      const d = desk();
      const placeholder = d.world.memory.plant('payment', { interventionId: d.job.id, method: 'ONLINE', status: 'PENDING', amount: 119, currency: 'TND', createdById: d.client.id });

      const { position, answer } = await bothSay(d);

      expect(position.canCollect).toBe(true);
      expect(position.reason).toBeNull();
      expect(answer).toBeNull();
      expect(rowsOf(d.world, 'payment').find((row) => row.id === placeholder.id)?.status).toBe('CANCELLED');
    });

    it('a cash request of the customer is the payment that is made, not an obstacle', async () => {
      const d = desk();

      d.world.memory.plant('payment', { interventionId: d.job.id, method: 'CASH', status: 'PENDING', amount: 119, currency: 'TND', createdById: d.client.id });

      const { position, answer } = await bothSay(d);

      expect(position.canCollect).toBe(true);
      expect(answer).toBeNull();
    });

    it('a payment that is decided (paid, failed, cancelled) is not open', async () => {
      const d = desk();

      d.world.memory.plant('payment', { interventionId: d.job.id, method: 'BANK_TRANSFER', status: 'FAILED', amount: 50, currency: 'TND', createdById: d.client.id });
      d.world.memory.plant('payment', { interventionId: d.job.id, method: 'BANK_TRANSFER', status: 'CANCELLED', amount: 50, currency: 'TND', createdById: d.client.id });

      const { position, answer } = await bothSay(d);

      expect(position.canCollect).toBe(true);
      expect(answer).toBeNull();
    });

    it('a job that is paid in full says so, even when a transfer is still open on it', async () => {
      const d = desk();

      d.world.memory.plant('payment', { interventionId: d.job.id, method: 'ONLINE', status: 'PAID', amount: 119, amountRefunded: 0, createdById: d.client.id });
      d.world.memory.plant('payment', { interventionId: d.job.id, method: 'BANK_TRANSFER', status: 'AWAITING_CONFIRMATION', amount: 10, currency: 'TND', createdById: d.client.id });

      const { position, answer } = await bothSay(d);

      expect(position.reason).toBe(COLLECT_CASH_WORDS.alreadyPaid);
      expect(answer?.message).toBe(COLLECT_CASH_WORDS.alreadyPaid);
    });

    it('a job that is not in the right status says so, even when a transfer is open', async () => {
      const d = desk({ status: 'ASSIGNED' });

      d.world.memory.plant('payment', { interventionId: d.job.id, method: 'BANK_TRANSFER', status: 'PENDING', amount: 50, currency: 'TND', createdById: d.client.id });

      const { position, answer } = await bothSay(d);

      expect(position.reason).toBe(COLLECT_CASH_WORDS.wrongStatus);
      expect(answer?.message).toBe(COLLECT_CASH_WORDS.wrongStatus);
    });
  });

  describe('when several things stand in the way, the first one the collection checks is the one told', () => {
    const paidPayoutOn = (d: ReturnType<typeof desk>) => {
      const financials = d.world.memory.plant('interventionFinancials', { interventionId: d.job.id, totalPrice: 119, platformCommission: 0, artisanPayout: 119, netRevenue: 0, companyMargin: 0 });
      const payout = d.world.memory.plant('artisanPayout', { artisanId: d.artisan.id, status: 'PAID', periodStart: new Date('2026-10-01T00:00:00.000Z'), periodEnd: new Date('2026-10-31T00:00:00.000Z') });

      d.world.memory.plant('artisanPayoutItem', { payoutId: payout.id, financialId: financials.id, interventionId: d.job.id, amount: 119 });
    };
    const bothSay = async (d: ReturnType<typeof desk>) => {
      const position = await positionOf(d.world, d.artisan.id, d.job.id);
      const answer = await refusal(() => collect(d.world, d.artisan.id, d.job.id, 1));

      return [position.reason, answer?.message ?? null];
    };

    it('the status, before a payout that was paid', async () => {
      const d = desk({ status: 'ASSIGNED' });

      paidPayoutOn(d);

      expect(await bothSay(d)).toEqual([COLLECT_CASH_WORDS.wrongStatus, COLLECT_CASH_WORDS.wrongStatus]);
    });

    it('a payout that was paid, before the missing document', async () => {
      const d = desk({ quote: null });

      paidPayoutOn(d);

      expect(await bothSay(d)).toEqual([COLLECT_CASH_WORDS.inPaidPayout, COLLECT_CASH_WORDS.inPaidPayout]);
    });

    it('another currency, before a job that is paid in full', async () => {
      const d = desk();

      rowsOf(d.world, 'quote')[0].currency = 'EUR';
      d.world.memory.plant('payment', { interventionId: d.job.id, method: 'ONLINE', status: 'PAID', amount: 119, amountRefunded: 0, createdById: d.client.id });

      expect(await bothSay(d)).toEqual([foreignCurrencyWords('EUR', 'TND'), foreignCurrencyWords('EUR', 'TND')]);
    });
  });

  it('counts the cash of this artisan on this job, not the cash of another artisan on it, nor their own on another job', async () => {
    const { world, artisan, other, client, job } = desk();
    const elsewhere = world.memory.plant('intervention', { clientId: client.id, artisanId: artisan.id, status: 'IN_PROGRESS', serviceType: 'PLOMBIER' });

    world.memory.plant('quote', { interventionId: elsewhere.id, createdById: artisan.id, status: 'ACCEPTED', amountHT: 80, taxAmount: 0, amountTTC: 80 });

    // the artisan who had this job before took cash on it; this artisan took cash on another job
    world.memory.plant('cashLedgerEntry', { artisanId: other.id, type: 'COLLECTION', interventionId: job.id, cashAmount: 25, commissionAmount: 3, currency: 'TND' });
    await collect(world, artisan.id, elsewhere.id, 10);

    const here = await positionOf(world, artisan.id, job.id);
    const there = await positionOf(world, artisan.id, elsewhere.id);

    expect(here.collected).toBe(0);
    expect(there.collected).toBe(10);

    await collect(world, artisan.id, job.id, 7);

    expect((await positionOf(world, artisan.id, job.id)).collected).toBe(7);
    expect((await positionOf(world, artisan.id, elsewhere.id)).collected).toBe(10);
  });

  it('does not ask the database about a number that is no row (a number past the column would be an error there)', async () => {
    const { world, artisan } = desk();
    const asked: unknown[] = [];
    const delegate = world.prisma.intervention;
    const original = delegate.findUnique.bind(delegate);

    delegate.findUnique = (args: unknown) => {
      asked.push(args);

      return original(args);
    };

    for (const bad of [0, -1, 1.5, Number.NaN, 2_147_483_648]) {
      await refusal(() => positionOf(world, artisan.id, bad));
    }

    expect(asked).toEqual([]);

    await refusal(() => positionOf(world, artisan.id, 1));

    expect(asked.length).toBe(1);
  });

  it('the route hands the signed-in role to the service, so that a customer who got past the guard is still turned away', async () => {
    const { world, client, artisan, job } = desk();
    const controller = new CashLedgerController(world.svc.cashLedger);

    expect((await refusal(() => controller.position(client.id, 'CLIENT' as any, job.id)))?.status).toBe(403);
    expect(await controller.position(artisan.id, ARTISAN as any, job.id)).toEqual(await positionOf(world, artisan.id, job.id));
  });

  it('the route is for artisans only', () => {
    const routes = scanController(readSource('modules/cash-ledger/cash-ledger.controller.ts'), TICKET_STAFF_ROLES);
    const route = routes.find((entry) => routeKey(entry.method, entry.path) === 'GET /cash-ledger/interventions/:/position');

    expect(route?.how).toBe('roles');
    expect(route?.rolesEnforced).toBe(true);
    expect([...(route?.roles ?? [])]).toEqual(['ARTISAN']);
  });
});
