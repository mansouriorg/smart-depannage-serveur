import { Decimal } from '../../common/testing/decimal-double';
import { World, emptyWorld } from '../../common/testing/world';
import { resetLocale } from '../../common/locale/locale';
import { restoreCollectionOfPayment, reverseCollectionsOfPayment, settleCashOnConfirm } from './cash-ledger-ops';
import { LOCK_ARTISAN, LOCK_CASH_LEDGER, LOCK_JOB, LOCK_PAYOUT, lockCashLedger, lockJob, lockPayouts } from '../assignment/artisan-lock';
import { TICKET_STAFF_ROLES } from '../../common/auth/role-policy';
import { routeKey, scanController } from '../../common/testing/route-roles';
import { readSource } from '../../common/testing/source-scan';

/**
 * The cash an artisan holds for the platform (P2-02), on the real services and a database that answers DECIMAL columns
 * as Decimal objects: a service that adds or compares an amount it read without going through `money()` fails here.
 */
function desk(options: { quote?: number | null; status?: string } = {}) {
  const world = emptyWorld();
  const make = (role: string, name: string) => world.memory.plant('user', { role, name });
  const admin = make('ADMIN', 'Admin');
  const accountant = make('ACCOUNTANT', 'Comptable');
  const support = make('SUPPORT', 'Support');
  const dispatcher = make('DISPATCHER', 'Dispatcher');
  const client = make('CLIENT', 'Client');
  const artisan = make('ARTISAN', 'Artisan');
  const other = make('ARTISAN', 'Autre artisan');

  world.memory.plant('artisanProfile', { userId: artisan.id, verificationStatus: 'APPROVED' });
  world.memory.plant('artisanProfile', { userId: other.id, verificationStatus: 'APPROVED' });

  const job = world.memory.plant('intervention', { clientId: client.id, artisanId: artisan.id, status: options.status ?? 'IN_PROGRESS', serviceType: 'PLOMBIER' });
  const amount = options.quote === undefined ? 119 : options.quote;
  const quote = amount === null ? null : world.memory.plant('quote', { interventionId: job.id, createdById: artisan.id, status: 'ACCEPTED', amountHT: amount, taxAmount: 0, amountTTC: amount });

  return { world, admin, accountant, support, dispatcher, client, artisan, other, job, quote };
}

const rowsOf = (world: World, model: string) => world.memory.rows(model);
const text = (value: unknown) => String(value);

interface Refusal {
  status: number;
  message: string;
}

/** What the services answer when they turn a call away: the HTTP status and the words. */
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

let taps = 0;

/** The app sends a key with every tap; a test that does not care about it gets a new one each time. */
const tap = (ledger: World['svc']['cashLedger'], userId: number, role: string, jobId: number, dto: Record<string, unknown>) =>
  ledger.collectCash(userId, role as any, jobId, { requestKey: `tap-auto-${(taps += 1)}`, ...dto } as any);

describe('an artisan says they took cash, and owes the platform its commission (P2-02)', () => {
  beforeEach(() => resetLocale());

  it('makes a cash payment that waits for confirmation and puts the cash and the commission in the ledger', async () => {
    const { world, artisan, job, quote } = desk();
    const answer = await tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount: 119, note: 'Payé à la fin' });

    expect(answer.replayed).toBe(false);
    expect(answer.payment).toEqual({ id: answer.payment.id, interventionId: job.id, method: 'CASH', status: 'AWAITING_CONFIRMATION', amount: 119, currency: 'TND', createdAt: answer.payment.createdAt });
    expect(answer.entry).toEqual({
      id: answer.entry.id,
      type: 'COLLECTION',
      interventionId: job.id,
      paymentId: answer.payment.id,
      cashAmount: 119,
      commissionAmount: 23.8,
      commissionRate: 20,
      currency: 'TND',
      reference: null,
      note: 'Payé à la fin',
      reversesId: null,
      createdAt: answer.entry.createdAt,
    });
    expect(answer.totals).toEqual({ currency: 'TND', cashCollected: 119, commissionDue: 23.8, commissionRemitted: 0, balance: 23.8 });

    const stored = rowsOf(world, 'payment')[0];

    expect(rowsOf(world, 'payment').length).toBe(1);
    expect(stored.createdById).toBe(artisan.id);
    expect(stored.quoteId).toBe(quote?.id);
    expect(stored.method).toBe('CASH');
    expect(text(stored.amount)).toBe('119');
    expect(stored.amount).toBeInstanceOf(Decimal);
    expect(rowsOf(world, 'cashLedgerEntry').length).toBe(1);
  });

  it('works to the millime: 20 % of 12.345 is 2.469, of 10.01 is 2.002, of 0.003 is 0.001', async () => {
    for (const [paid, commission] of [[12.345, 2.469], [10.01, 2.002], [0.003, 0.001], [99999.999, 20000]] as const) {
      const { world, artisan, job } = desk({ quote: paid });
      const answer = await tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount: paid });

      expect(`${paid}: ${answer.entry.commissionAmount}`).toBe(`${paid}: ${commission}`);
      expect(answer.totals.balance).toBe(commission);
    }
  });

  it('a balance is the cash collected, as commission, minus the commission remitted (the figure of the ticket)', async () => {
    const { world, accountant, artisan, job } = desk();

    await tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount: 50 });
    await tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount: 69 });

    const before = (await world.svc.cashLedger.getMyLedger(artisan.id, ARTISAN)).totals;

    expect(before).toEqual({ currency: 'TND', cashCollected: 119, commissionDue: 23.8, commissionRemitted: 0, balance: 23.8 });

    const paid = await world.svc.cashLedger.recordRemittance(accountant.id, 'ACCOUNTANT', artisan.id, { amount: 10, reference: 'VIR-12' });

    expect(paid.totals).toEqual({ currency: 'TND', cashCollected: 119, commissionDue: 23.8, commissionRemitted: 10, balance: 13.8 });

    const rest = await world.svc.cashLedger.recordRemittance(accountant.id, 'ACCOUNTANT', artisan.id, { amount: 13.8 });

    expect(rest.totals).toEqual({ currency: 'TND', cashCollected: 119, commissionDue: 23.8, commissionRemitted: 23.8, balance: 0 });
  });

  it('takes the rate of the job\'s financials when the back office has computed them', async () => {
    const { world, artisan, job } = desk();

    world.memory.plant('interventionFinancials', { interventionId: job.id, commissionRate: 15, totalPrice: 119, platformCommission: 17.85, artisanPayout: 101.15, netRevenue: 17.85, companyMargin: 17.85 });

    const answer = await tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount: 119 });

    expect(answer.entry.commissionRate).toBe(15);
    expect(answer.entry.commissionAmount).toBe(17.85);
  });

  it('uses the invoice, not the quote, as what is to be paid when the job has an invoice', async () => {
    const { world, artisan, job } = desk();

    world.memory.plant('invoice', { interventionId: job.id, status: 'ISSUED', amountHT: 130, taxAmount: 0, amountTTC: 130 });

    expect((await refusal(() => tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount: 131 })))?.status).toBe(400);

    const answer = await tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount: 130 });
    const stored = rowsOf(world, 'payment')[0];

    expect(answer.entry.cashAmount).toBe(130);
    expect(stored.invoiceId).toBe(rowsOf(world, 'invoice')[0].id);
  });

  it('a cancelled invoice is not what is to be paid: the accepted quote is', async () => {
    const { world, artisan, job, quote } = desk();

    world.memory.plant('invoice', { interventionId: job.id, status: 'CANCELLED', amountHT: 500, taxAmount: 0, amountTTC: 500 });

    expect((await refusal(() => tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount: 120 })))?.status).toBe(400);
    expect((await tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount: 119 })).entry.cashAmount).toBe(119);
    expect(rowsOf(world, 'payment')[0].invoiceId ?? null).toBe(null);
    expect(rowsOf(world, 'payment')[0].quoteId).toBe(quote?.id);
  });

  it('uses the cash payment the customer asked for, once, instead of making a second one', async () => {
    const { world, client, artisan, job } = desk();

    world.memory.plant('payment', { interventionId: job.id, method: 'CASH', provider: 'CASH', status: 'AWAITING_CONFIRMATION', amount: 100, createdById: client.id });

    const answer = await tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount: 119 });

    expect(rowsOf(world, 'payment').length).toBe(1);
    expect(answer.payment.id).toBe(rowsOf(world, 'payment')[0].id);
    expect(answer.payment.amount).toBe(119);
    expect(answer.entry.paymentId).toBe(answer.payment.id);
    expect(rowsOf(world, 'payment')[0].createdById).toBe(client.id);
  });

  it('when the customer asked to pay in cash twice, the newest request is the one that is taken', async () => {
    const { world, client, artisan, job } = desk();

    world.memory.plant('payment', { interventionId: job.id, method: 'CASH', provider: 'CASH', status: 'PENDING', amount: 100, createdById: client.id });
    world.memory.plant('payment', { interventionId: job.id, method: 'CASH', provider: 'CASH', status: 'AWAITING_CONFIRMATION', amount: 119, createdById: client.id });

    const answer = await tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount: 50 });
    const [older, newer] = rowsOf(world, 'payment');

    expect(answer.payment.id).toBe(newer.id);
    expect(text(newer.amount)).toBe('50');
    expect(text(older.amount)).toBe('100');
    expect(older.status).toBe('PENDING');
    expect(rowsOf(world, 'payment').length).toBe(2);
  });

  it('an online request nobody can pay (no provider took it) is cancelled when the artisan declares cash (P2-03)', async () => {
    const { world, client, artisan, job } = desk();

    world.memory.plant('payment', { interventionId: job.id, method: 'ONLINE', status: 'PENDING', amount: 119, createdById: client.id });

    await tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount: 119 });

    const online = rowsOf(world, 'payment').find((row) => row.method === 'ONLINE');

    expect(rowsOf(world, 'payment').map((row) => row.method).sort()).toEqual(['CASH', 'ONLINE']);
    expect(online?.status).toBe('CANCELLED');
    expect(online?.cancelReason).toBe('Remplacé par une autre demande de paiement.');
    expect(online?.cancelledAt).toBeInstanceOf(Date);
  });

  it('a payment that is really waiting (a provider took it, or a transfer to confirm) is not cancelled: the declaration is refused and nothing is written (P2-03)', async () => {
    const { world, client, artisan, job } = desk();

    world.memory.plant('payment', { interventionId: job.id, method: 'ONLINE', status: 'PENDING', amount: 119, providerPaymentId: 'pi_1', createdById: client.id });
    world.memory.plant('payment', { interventionId: job.id, method: 'BANK_TRANSFER', status: 'AWAITING_CONFIRMATION', amount: 119, createdById: client.id });

    const refused = await refusal(() => tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount: 50 }));

    expect(refused?.message).toBe('Un paiement de 119,000 TND est déjà en attente pour cette mission: contactez l’administration.');
    expect(rowsOf(world, 'payment').map((row) => row.status)).toEqual(['PENDING', 'AWAITING_CONFIRMATION']);
    expect(rowsOf(world, 'cashLedgerEntry')).toEqual([]);
  });

  it('says it on the timeline of the job', async () => {
    const { world, artisan, job } = desk();

    await tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount: 50 });

    const event = rowsOf(world, 'interventionEvent').find((row) => row.title === 'Espèces encaissées');

    expect(event?.message).toBe('L’artisan a déclaré avoir encaissé 50,000 TND en espèces.');
    expect(event?.interventionId).toBe(job.id);
  });

  it('what has been collected is taken off what is left to pay: a payment in two parts, never more than the total', async () => {
    const { world, artisan, job } = desk();

    await tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount: 50 });

    expect((await refusal(() => tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount: 70 })))?.message).toBe('Le montant dépasse ce qu’il reste à payer sur cette mission (69,000 TND).');

    const second = await tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount: 69 });

    expect(second.totals.cashCollected).toBe(119);
    expect(rowsOf(world, 'payment').length).toBe(2);
    expect((await refusal(() => tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount: 0.001 })))?.message).toBe('Cette mission est déjà payée.');
  });

  it('money already paid online counts too, and a refunded part is to be paid again', async () => {
    const { world, client, artisan, job } = desk();

    world.memory.plant('payment', { interventionId: job.id, method: 'ONLINE', status: 'PAID', amount: 100, createdById: client.id });

    expect((await refusal(() => tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount: 20 })))?.status).toBe(400);
    expect((await tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount: 19 })).entry.cashAmount).toBe(19);

    const paid = rowsOf(world, 'payment').find((row) => row.method === 'ONLINE')!;

    paid.status = 'PARTIALLY_REFUNDED';
    paid.amountRefunded = 30;

    expect((await tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount: 30 })).entry.cashAmount).toBe(30);
  });

  it('sent twice with the same key, it is written once and the second answer says so', async () => {
    const { world, artisan, job } = desk();
    const first = await tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount: 50, requestKey: 'tap-0001-abcd' });
    const again = await tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount: 50, requestKey: 'tap-0001-abcd' });

    expect(again.replayed).toBe(true);
    expect(again.entry.id).toBe(first.entry.id);
    expect(again.payment.id).toBe(first.payment.id);
    expect(again.totals.cashCollected).toBe(50);
    expect(rowsOf(world, 'payment').length).toBe(1);
    expect(rowsOf(world, 'cashLedgerEntry').length).toBe(1);
    expect(rowsOf(world, 'interventionEvent').filter((row) => row.title === 'Espèces encaissées').length).toBe(1);

    // the same key for another amount is a mistake of the app, not the same request
    expect((await refusal(() => tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount: 40, requestKey: 'tap-0001-abcd' })))?.status).toBe(409);
    expect(rowsOf(world, 'cashLedgerEntry').length).toBe(1);

    // ... and so is the same key for another job
    const second = world.memory.plant('intervention', { clientId: first.payment.id, artisanId: artisan.id, status: 'IN_PROGRESS', serviceType: 'PLOMBIER' });

    world.memory.plant('quote', { interventionId: second.id, createdById: artisan.id, status: 'ACCEPTED', amountHT: 80, taxAmount: 0, amountTTC: 80 });

    expect((await refusal(() => tap(world.svc.cashLedger, artisan.id, ARTISAN, second.id, { amount: 50, requestKey: 'tap-0001-abcd' })))?.status).toBe(409);
    expect(rowsOf(world, 'cashLedgerEntry').length).toBe(1);
    expect(rowsOf(world, 'payment').length).toBe(1);
  });

  it('two taps at the same moment with different keys: one is written, the other is refused', async () => {
    const { world, artisan, job } = desk();
    const taps = await Promise.all([
      refusal(() => tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount: 119, requestKey: 'tap-a-000001' })),
      refusal(() => tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount: 119, requestKey: 'tap-b-000002' })),
    ]);

    expect(taps.filter((tap) => tap === null).length).toBe(1);
    expect(rowsOf(world, 'payment').length).toBe(1);
    expect(rowsOf(world, 'cashLedgerEntry').length).toBe(1);
  });

  it('turns away a call that is not the artisan\'s to make, and writes nothing', async () => {
    const { world, admin, client, artisan, other, job } = desk();
    const cases: Array<[string, Refusal | null]> = [
      ['the customer', await refusal(() => tap(world.svc.cashLedger, client.id, 'CLIENT', job.id, { amount: 10 }))],
      ['staff', await refusal(() => tap(world.svc.cashLedger, admin.id, 'ADMIN', job.id, { amount: 10 }))],
      ['another artisan', await refusal(() => tap(world.svc.cashLedger, other.id, ARTISAN, job.id, { amount: 10 }))],
      ['a job that does not exist', await refusal(() => tap(world.svc.cashLedger, artisan.id, ARTISAN, 99999, { amount: 10 }))],
      ['a number that is no job', await refusal(() => tap(world.svc.cashLedger, artisan.id, ARTISAN, 0, { amount: 10 }))],
    ];

    expect(cases.map(([who, answer]) => `${who}: ${answer?.status}`)).toEqual([
      'the customer: 403',
      'staff: 403',
      'another artisan: 404',
      'a job that does not exist: 404',
      'a number that is no job: 404',
    ]);
    expect(rowsOf(world, 'payment').length).toBe(0);
    expect(rowsOf(world, 'cashLedgerEntry').length).toBe(0);
    expect(rowsOf(world, 'interventionEvent').length).toBe(0);
  });

  it('an artisan whose profile is not approved is turned away', async () => {
    for (const verificationStatus of ['DRAFT', 'PENDING_REVIEW', 'REJECTED', 'SUSPENDED']) {
      const { world, artisan, job } = desk();

      world.memory.rows('artisanProfile').find((row) => row.userId === artisan.id)!.verificationStatus = verificationStatus;

      const answer = await refusal(() => tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount: 10 }));

      expect(`${verificationStatus}: ${answer?.status}`).toBe(`${verificationStatus}: 403`);
      expect(answer?.message).toMatch(/approuvé/);
      expect(rowsOf(world, 'cashLedgerEntry').length).toBe(0);
    }
  });

  it('an artisan without any profile is turned away', async () => {
    const { world, artisan, job } = desk();

    world.memory.rows('artisanProfile').splice(0, world.memory.rows('artisanProfile').length);

    const answer = await refusal(() => tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount: 10 }));

    expect(answer?.status).toBe(404);
    expect(answer?.message).toBe('Profil artisan introuvable.');
    expect(rowsOf(world, 'cashLedgerEntry').length).toBe(0);
  });

  it('only on the spot, or after the work: not before the artisan is there, not when the job is cancelled or in dispute; a job that is paid or invoiced may still have something left to pay', async () => {
    const taken: Record<string, number> = {};

    for (const status of ['CREATED', 'QUOTE_SENT', 'QUOTE_ACCEPTED', 'ASSIGNED', 'ARTISAN_ACCEPTED', 'ARTISAN_ON_THE_WAY', 'ARTISAN_ARRIVED', 'IN_PROGRESS', 'WAITING_CLIENT_VALIDATION', 'COMPLETED', 'PAYMENT_PENDING', 'PAID', 'INVOICE_SENT', 'CANCELLED', 'DISPUTED']) {
      const { world, artisan, job } = desk({ status });
      const answer = await refusal(() => tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount: 10 }));

      taken[status] = answer === null ? 200 : answer.status;
    }

    expect(taken).toEqual({
      CREATED: 400,
      QUOTE_SENT: 400,
      QUOTE_ACCEPTED: 400,
      ASSIGNED: 400,
      ARTISAN_ACCEPTED: 400,
      ARTISAN_ON_THE_WAY: 400,
      ARTISAN_ARRIVED: 200,
      IN_PROGRESS: 200,
      WAITING_CLIENT_VALIDATION: 200,
      COMPLETED: 200,
      PAYMENT_PENDING: 200,
      PAID: 200,
      INVOICE_SENT: 200,
      CANCELLED: 400,
      DISPUTED: 400,
    });
  });

  it('refuses an amount that is not an amount, and one that is too big', async () => {
    const { world, artisan, job } = desk();
    const bad: unknown[] = [0, -5, 0.0004, 1.2345, Number.NaN, Number.POSITIVE_INFINITY, '50', null, undefined, 1e-7, 100000000000];
    const answers: string[] = [];

    for (const amount of bad) {
      const answer = await refusal(() => tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount } as any));

      answers.push(`${String(amount)}: ${answer?.status}`);
    }

    expect(answers).toEqual(bad.map((amount) => `${String(amount)}: 400`));
    expect(rowsOf(world, 'cashLedgerEntry').length).toBe(0);
  });

  it('nothing to collect without an accepted quote or an invoice, or in another currency than the ledger\'s', async () => {
    const none = desk({ quote: null });

    expect((await refusal(() => tap(none.world.svc.cashLedger, none.artisan.id, ARTISAN, none.job.id, { amount: 10 })))?.message).toBe('Aucun devis accepté ni facture: il n’y a pas de montant à encaisser.');

    const sent = desk();

    sent.world.memory.rows('quote')[0].status = 'SENT';
    expect((await refusal(() => tap(sent.world.svc.cashLedger, sent.artisan.id, ARTISAN, sent.job.id, { amount: 10 })))?.status).toBe(400);

    const euros = desk();

    euros.world.memory.rows('quote')[0].currency = 'EUR';
    expect((await refusal(() => tap(euros.world.svc.cashLedger, euros.artisan.id, ARTISAN, euros.job.id, { amount: 10 })))?.message).toBe('Cette mission est facturée en EUR, le registre est tenu en TND.');
  });

  it('a request key is required, from 8 to 64 characters: without one nothing is written', async () => {
    const { world, artisan, job } = desk();
    const bad: unknown[] = [undefined, null, '', '        ', 'court', 'x'.repeat(65)];
    const answers: string[] = [];

    for (const requestKey of bad) {
      const answer = await refusal(() => world.svc.cashLedger.collectCash(artisan.id, ARTISAN, job.id, { amount: 10, requestKey } as any));

      answers.push(`${String(requestKey).length}: ${answer?.status} ${answer?.message.slice(0, 40)}`);
    }

    expect(answers.map((line) => line.split(': ')[1])).toEqual(Array(6).fill('400 Une clé de requête de 8 à 64 caractères '));
    expect(rowsOf(world, 'cashLedgerEntry').length).toBe(0);
    expect(rowsOf(world, 'payment').length).toBe(0);

    expect((await world.svc.cashLedger.collectCash(artisan.id, ARTISAN, job.id, { amount: 10, requestKey: 'k'.repeat(8) })).replayed).toBe(false);
    expect((await world.svc.cashLedger.collectCash(artisan.id, ARTISAN, job.id, { amount: 10, requestKey: 'k'.repeat(64) })).replayed).toBe(false);
    expect((await world.svc.cashLedger.collectCash(artisan.id, ARTISAN, job.id, { amount: 10, requestKey: '  trimmed-key  ' })).entry.id).toBeGreaterThan(0);
    expect(rowsOf(world, 'cashLedgerEntry').map((line) => line.requestKey)).toEqual(['k'.repeat(8), 'k'.repeat(64), 'trimmed-key']);
  });

  it('a job that a payout already paid takes no more cash; while the payout is not paid the cash goes in and the payout is made again', async () => {
    const { world, client, artisan, job } = desk();
    const plantFinancials = (interventionId: number) => world.memory.plant('interventionFinancials', { interventionId, totalPrice: 119, platformCommission: 0, artisanPayout: 119, netRevenue: 0, companyMargin: 0 });
    const payout = world.memory.plant('artisanPayout', { artisanId: artisan.id, status: 'PAID', periodStart: new Date('2026-10-01T00:00:00.000Z'), periodEnd: new Date('2026-10-31T00:00:00.000Z') });

    // a payout that was paid and that holds another job of the artisan does not stop this one
    const elsewhere = world.memory.plant('intervention', { clientId: client.id, artisanId: artisan.id, status: 'PAID', serviceType: 'PLOMBIER' });

    world.memory.plant('artisanPayoutItem', { payoutId: payout.id, financialId: plantFinancials(elsewhere.id).id, interventionId: elsewhere.id, amount: 119 });
    expect((await tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount: 10 })).replayed).toBe(false);

    const second = world.memory.plant('artisanPayout', { artisanId: artisan.id, status: 'READY', periodStart: new Date('2026-10-01T00:00:00.000Z'), periodEnd: new Date('2026-10-31T00:00:00.000Z') });

    world.memory.plant('artisanPayoutItem', { payoutId: second.id, financialId: plantFinancials(job.id).id, interventionId: job.id, amount: 119 });

    const outcomes: string[] = [];

    for (const status of ['PENDING', 'READY', 'FAILED', 'CANCELLED']) {
      rowsOf(world, 'artisanPayout')[1].status = status;

      const answer = await refusal(() => tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount: 1 }));

      outcomes.push(`${status}: ${answer === null ? 'taken' : `${answer.status} ${answer.message}`}`);
    }

    expect(outcomes).toEqual(['PENDING: taken', 'READY: taken', 'FAILED: taken', 'CANCELLED: taken']);
    expect(rowsOf(world, 'cashLedgerEntry').length).toBe(5);

    rowsOf(world, 'artisanPayout')[1].status = 'PAID';

    const answer = await refusal(() => tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount: 10 }));

    expect(`${answer?.status} ${answer?.message}`).toBe('409 Un payout déjà payé comprend cette mission: contactez l’administration pour enregistrer cet encaissement.');
    expect(rowsOf(world, 'cashLedgerEntry').length).toBe(5);
  });

  it('a tap that is sent again after the payout was made still gets its first answer', async () => {
    const { world, artisan, job } = desk();
    const first = await world.svc.cashLedger.collectCash(artisan.id, ARTISAN, job.id, { amount: 10, requestKey: 'tap-replay-1' });
    const financials = world.memory.plant('interventionFinancials', { interventionId: job.id, totalPrice: 119, platformCommission: 0, artisanPayout: 119, netRevenue: 0, companyMargin: 0 });
    const payout = world.memory.plant('artisanPayout', { artisanId: artisan.id, status: 'PAID', periodStart: new Date('2026-10-01T00:00:00.000Z'), periodEnd: new Date('2026-10-31T00:00:00.000Z') });

    world.memory.plant('artisanPayoutItem', { payoutId: payout.id, financialId: financials.id, interventionId: job.id, amount: 119 });

    const again = await world.svc.cashLedger.collectCash(artisan.id, ARTISAN, job.id, { amount: 10, requestKey: 'tap-replay-1' });

    expect(again.replayed).toBe(true);
    expect(again.entry.id).toBe(first.entry.id);
  });
});

describe('the ledger follows the payment it belongs to (P2-02)', () => {
  beforeEach(() => resetLocale());

  async function declared(amount = 119) {
    const base = desk();
    const answer = await tap(base.world.svc.cashLedger, base.artisan.id, ARTISAN, base.job.id, { amount });

    return { ...base, paymentId: answer.payment.id as number };
  }

  const balance = async (world: World, artisanId: number) => (await world.svc.cashLedger.getMyLedger(artisanId, ARTISAN)).totals;

  it('cancelling the payment takes the collection back, once', async () => {
    const { world, admin, artisan, paymentId } = await declared();

    await world.svc.payments.cancel(paymentId, admin.id, { adminNote: 'Jamais reçu' });

    expect(rowsOf(world, 'payment')[0].status).toBe('CANCELLED');
    expect(await balance(world, artisan.id)).toEqual({ currency: 'TND', cashCollected: 0, commissionDue: 0, commissionRemitted: 0, balance: 0 });

    const lines = rowsOf(world, 'cashLedgerEntry');

    expect(lines.map((line) => line.type)).toEqual(['COLLECTION', 'REVERSAL']);
    expect(lines[1].reversesId).toBe(lines[0].id);
    expect(text(lines[1].cashAmount)).toBe('-119');
    expect(text(lines[1].commissionAmount)).toBe('-23.8');
    expect(lines[1].recordedById).toBe(admin.id);

    // taking it back again changes nothing
    expect(await world.prisma.$transaction((tx: any) => reverseCollectionsOfPayment(tx, paymentId, { userId: admin.id, reason: 'encore' }))).toBe(0);
    expect(rowsOf(world, 'cashLedgerEntry').length).toBe(2);
  });

  it('failing the payment takes it back too, and confirming it after all puts it back', async () => {
    const { world, admin, artisan, paymentId } = await declared();

    await world.svc.payments.fail(paymentId, admin.id, { adminNote: 'Pas payé' });
    expect((await balance(world, artisan.id)).balance).toBe(0);

    await world.svc.payments.confirm(paymentId, admin.id, {});
    expect(rowsOf(world, 'payment')[0].status).toBe('PAID');
    expect(await balance(world, artisan.id)).toEqual({ currency: 'TND', cashCollected: 119, commissionDue: 23.8, commissionRemitted: 0, balance: 23.8 });
    expect(rowsOf(world, 'cashLedgerEntry').map((line) => line.type)).toEqual(['COLLECTION', 'REVERSAL', 'COLLECTION']);

    // failed, confirmed, failed and confirmed again: the figures follow
    await world.svc.payments.confirm(paymentId, admin.id, {}).catch(() => undefined);
    expect((await balance(world, artisan.id)).balance).toBe(23.8);
  });

  it('confirming a payment that is not failed adds nothing: the collection is already there', async () => {
    const { world, admin, artisan, paymentId } = await declared();

    await world.svc.payments.confirm(paymentId, admin.id, {});

    expect(rowsOf(world, 'cashLedgerEntry').length).toBe(1);
    expect((await balance(world, artisan.id)).balance).toBe(23.8);
  });

  it('a cash payment nobody declared is written to the ledger when it is confirmed, once, for the artisan of the job', async () => {
    const { world, admin, artisan, job } = desk();
    const payment = await world.svc.payments.createAdminManualPayment(admin.id, job.id, { method: 'CASH', amount: 119 });

    await world.svc.payments.confirm(payment.id, admin.id, {});

    const lines = rowsOf(world, 'cashLedgerEntry');

    expect(lines.length).toBe(1);
    expect(lines[0].type).toBe('COLLECTION');
    expect(lines[0].artisanId).toBe(artisan.id);
    expect(lines[0].interventionId).toBe(job.id);
    expect(lines[0].paymentId).toBe(payment.id);
    expect(text(lines[0].cashAmount)).toBe('119');
    expect(text(lines[0].commissionAmount)).toBe('23.8');
    expect(text(lines[0].commissionRate)).toBe('20');
    expect(lines[0].recordedById).toBe(admin.id);
    expect(await balance(world, artisan.id)).toEqual({ currency: 'TND', cashCollected: 119, commissionDue: 23.8, commissionRemitted: 0, balance: 23.8 });

    // confirmed again (a double click): the same answer, and nothing is written a second time (P2-03)
    expect(await refusal(() => world.svc.payments.confirm(payment.id, admin.id, {}))).toBe(null);
    expect(rowsOf(world, 'cashLedgerEntry').length).toBe(1);
  });

  it('cash nobody declared takes the rate of the job\'s financials, and two payments are two lines', async () => {
    const { world, admin, artisan, job } = desk();

    world.memory.plant('interventionFinancials', { interventionId: job.id, commissionRate: 15, totalPrice: 119, platformCommission: 17.85, artisanPayout: 101.15, netRevenue: 17.85, companyMargin: 17.85 });

    // one open payment per job (P2-03): the second is asked for once the first is confirmed
    const first = await world.svc.payments.createAdminManualPayment(admin.id, job.id, { method: 'CASH', amount: 50 });

    await world.svc.payments.confirm(first.id, admin.id, {});

    const second = await world.svc.payments.createAdminManualPayment(admin.id, job.id, { method: 'CASH', amount: 69 });

    await world.svc.payments.confirm(second.id, admin.id, {});

    expect(rowsOf(world, 'cashLedgerEntry').map((line) => [text(line.cashAmount), text(line.commissionAmount)])).toEqual([['50', '7.5'], ['69', '10.35']]);
    expect(await balance(world, artisan.id)).toEqual({ currency: 'TND', cashCollected: 119, commissionDue: 17.85, commissionRemitted: 0, balance: 17.85 });
  });

  it('cash nobody declared that is failed and then confirmed after all is written once, when it is confirmed', async () => {
    const { world, admin, artisan, job } = desk();
    const payment = await world.svc.payments.createAdminManualPayment(admin.id, job.id, { method: 'CASH', amount: 119 });

    await world.svc.payments.fail(payment.id, admin.id, {});
    expect(rowsOf(world, 'cashLedgerEntry').length).toBe(0);

    await world.svc.payments.confirm(payment.id, admin.id, {});

    expect(rowsOf(world, 'payment')[0].status).toBe('PAID');
    expect(rowsOf(world, 'cashLedgerEntry').map((line) => line.type)).toEqual(['COLLECTION']);
    expect((await balance(world, artisan.id)).balance).toBe(23.8);
  });

  it('nothing is written for a payment that is not cash, for a job without an artisan, or for a payment in another currency', async () => {
    const online = desk();
    const paidOnline = await online.world.svc.payments.createAdminManualPayment(online.admin.id, online.job.id, { method: 'ONLINE', amount: 119 });

    await online.world.svc.payments.confirm(paidOnline.id, online.admin.id, {});
    expect(rowsOf(online.world, 'cashLedgerEntry').length).toBe(0);

    const nobody = desk();

    rowsOf(nobody.world, 'intervention')[0].artisanId = null;

    const unassigned = await nobody.world.svc.payments.createAdminManualPayment(nobody.admin.id, nobody.job.id, { method: 'CASH', amount: 119 });

    await nobody.world.svc.payments.confirm(unassigned.id, nobody.admin.id, {});
    expect(rowsOf(nobody.world, 'payment')[0].status).toBe('PAID');
    expect(rowsOf(nobody.world, 'cashLedgerEntry').length).toBe(0);

    const euros = desk();

    rowsOf(euros.world, 'quote')[0].currency = 'EUR';

    const abroad = await euros.world.svc.payments.createAdminManualPayment(euros.admin.id, euros.job.id, { method: 'CASH', amount: 119 });

    await euros.world.svc.payments.confirm(abroad.id, euros.admin.id, {});
    expect(rowsOf(euros.world, 'payment')[0].status).toBe('PAID');
    expect(rowsOf(euros.world, 'cashLedgerEntry').length).toBe(0);
  });

  it('a cash payment that would bring the job above what it has to pay is not confirmed, and nothing is written', async () => {
    const { world, admin, artisan, job } = desk();
    const big = await world.svc.payments.createAdminManualPayment(admin.id, job.id, { method: 'CASH', amount: 119.001 });
    const answer = await refusal(() => world.svc.payments.confirm(big.id, admin.id, {}));

    expect(answer?.status).toBe(409);
    expect(answer?.message).toBe('Ce paiement en espèces dépasse ce qu’il reste à payer sur cette mission.');
    expect(rowsOf(world, 'payment')[0].status).not.toBe('PAID');
    expect(rowsOf(world, 'cashLedgerEntry').length).toBe(0);
    expect(rowsOf(world, 'intervention')[0].status).toBe('IN_PROGRESS');
    expect((await balance(world, artisan.id)).balance).toBe(0);

    // up to the last millime is accepted (the refused one is cancelled first: one open payment per job, P2-03)
    await world.svc.payments.cancel(big.id, admin.id, {});

    const exact = await world.svc.payments.createAdminManualPayment(admin.id, job.id, { method: 'CASH', amount: 119 });

    await world.svc.payments.confirm(exact.id, admin.id, {});
    expect((await balance(world, artisan.id)).cashCollected).toBe(119);
  });

  it('a collection that was taken back is not put back when the job has been paid in the meantime', async () => {
    const { world, admin, client, artisan, job, paymentId } = await declared();

    await world.svc.payments.fail(paymentId, admin.id, {});
    world.memory.plant('payment', { interventionId: job.id, method: 'ONLINE', status: 'PAID', amount: 119, createdById: client.id });

    const answer = await refusal(() => world.svc.payments.confirm(paymentId, admin.id, {}));

    expect(answer?.status).toBe(409);
    expect(rowsOf(world, 'payment').find((row) => row.id === paymentId)?.status).toBe('FAILED');
    expect(rowsOf(world, 'cashLedgerEntry').map((line) => line.type)).toEqual(['COLLECTION', 'REVERSAL']);
    expect((await balance(world, artisan.id)).balance).toBe(0);
  });

  it('a payment that was paid cannot be cancelled or failed, so its collection stays', async () => {
    const { world, admin, artisan, paymentId } = await declared();

    await world.svc.payments.confirm(paymentId, admin.id, {});

    expect((await refusal(() => world.svc.payments.cancel(paymentId, admin.id, {})))?.status).toBe(400);
    expect((await refusal(() => world.svc.payments.fail(paymentId, admin.id, {})))?.status).toBe(400);
    expect((await balance(world, artisan.id)).balance).toBe(23.8);
  });

  it('settling a confirmed cash payment says what it did: nothing, put back, written, or skipped', async () => {
    const { world, admin, artisan, job, paymentId } = await declared();
    const settle = (id: number) =>
      world.prisma.$transaction((tx: any) => settleCashOnConfirm(tx, rowsOf(world, 'payment').find((row) => row.id === id)!, { userId: admin.id }));

    // the artisan declared it and it stands
    expect(await settle(paymentId)).toBe('standing');
    expect(rowsOf(world, 'cashLedgerEntry').length).toBe(1);

    // taken back, then put back once
    await world.prisma.$transaction((tx: any) => reverseCollectionsOfPayment(tx, paymentId, { userId: admin.id, reason: 'Échec' }));
    rowsOf(world, 'payment').find((row) => row.id === paymentId)!.status = 'FAILED';
    expect(await settle(paymentId)).toBe('restored');
    expect(await settle(paymentId)).toBe('standing');
    expect(rowsOf(world, 'cashLedgerEntry').map((line) => line.type)).toEqual(['COLLECTION', 'REVERSAL', 'COLLECTION']);

    // nobody declared it: written once
    rowsOf(world, 'payment').find((row) => row.id === paymentId)!.status = 'PAID';
    rowsOf(world, 'quote')[0].amountTTC = 500;

    const loose = await world.svc.payments.createAdminManualPayment(admin.id, job.id, { method: 'CASH', amount: 100 });

    expect(await settle(loose.id)).toBe('booked');
    expect(await settle(loose.id)).toBe('standing');
    expect(rowsOf(world, 'cashLedgerEntry').filter((line) => line.paymentId === loose.id).length).toBe(1);

    // not cash: skipped (the other payment is decided first: one open payment per job, P2-03)
    rowsOf(world, 'payment').find((row) => row.id === loose.id)!.status = 'PAID';

    const card = await world.svc.payments.createAdminManualPayment(admin.id, job.id, { method: 'ONLINE', amount: 100 });

    expect(await settle(card.id)).toBe('skipped');
    expect((await balance(world, artisan.id)).cashCollected).toBe(219);
  });

  it('cash for a job that a paid payout has taken is refused when it is confirmed; while the payout is not paid, it is booked', async () => {
    const { world, admin, artisan, job } = desk();
    const loose = await world.svc.payments.createAdminManualPayment(admin.id, job.id, { method: 'CASH', amount: 50 });
    const financials = world.memory.plant('interventionFinancials', { interventionId: job.id, totalPrice: 119, platformCommission: 0, artisanPayout: 119, netRevenue: 0, companyMargin: 0 });
    const payout = world.memory.plant('artisanPayout', { artisanId: artisan.id, status: 'PAID', periodStart: new Date('2026-10-01T00:00:00.000Z'), periodEnd: new Date('2026-10-31T00:00:00.000Z') });

    world.memory.plant('artisanPayoutItem', { payoutId: payout.id, financialId: financials.id, interventionId: job.id, amount: 119 });

    const answer = await refusal(() => world.svc.payments.confirm(loose.id, admin.id, {}));

    expect(`${answer?.status} ${answer?.message}`).toBe('409 Un payout déjà payé comprend cette mission: enregistrez cet encaissement par une correction du registre.');
    expect(rowsOf(world, 'payment')[0].status).toBe('AWAITING_CONFIRMATION');
    expect(rowsOf(world, 'cashLedgerEntry').length).toBe(0);

    rowsOf(world, 'artisanPayout')[0].status = 'READY';
    await world.svc.payments.confirm(loose.id, admin.id, {});

    expect(rowsOf(world, 'payment')[0].status).toBe('PAID');
    expect(rowsOf(world, 'cashLedgerEntry').map((line) => line.type)).toEqual(['COLLECTION']);
  });

  it('putting a collection back: only when it was taken back, once, and never for a payment nobody declared', async () => {
    const { world, admin, artisan, paymentId } = await declared();
    const restore = () => world.prisma.$transaction((tx: any) => restoreCollectionOfPayment(tx, paymentId, { userId: admin.id }));
    const reverse = (id: number) => world.prisma.$transaction((tx: any) => reverseCollectionsOfPayment(tx, id, { userId: admin.id, reason: 'Annulé' }));

    // it stands: nothing to put back
    expect(await restore()).toBe(false);
    expect(rowsOf(world, 'cashLedgerEntry').length).toBe(1);

    expect(await reverse(paymentId)).toBe(1);
    expect(await restore()).toBe(true);
    expect(await restore()).toBe(false);

    const lines = rowsOf(world, 'cashLedgerEntry');

    expect(lines.map((line) => line.type)).toEqual(['COLLECTION', 'REVERSAL', 'COLLECTION']);
    expect(text(lines[2].cashAmount)).toBe('119');
    expect(text(lines[2].commissionAmount)).toBe('23.8');
    expect(lines[2].paymentId).toBe(paymentId);
    expect((await balance(world, artisan.id)).balance).toBe(23.8);

    // a payment with no collection at all
    expect(await world.prisma.$transaction((tx: any) => restoreCollectionOfPayment(tx, 99999, { userId: admin.id }))).toBe(false);
    expect(await reverse(99999)).toBe(0);
    expect(rowsOf(world, 'cashLedgerEntry').length).toBe(3);
  });

  it('confirming and cancelling at the same moment: one wins, and the ledger agrees with the payment', async () => {
    const { world, admin, artisan, paymentId } = await declared();

    const answers = await Promise.all([
      refusal(() => world.svc.payments.confirm(paymentId, admin.id, {})),
      refusal(() => world.svc.payments.cancel(paymentId, admin.id, {})),
    ]);

    // the second one finds the payment already decided and is turned away
    expect(answers.filter((answer) => answer === null).length).toBe(1);

    const status = rowsOf(world, 'payment')[0].status;
    const owed = (await balance(world, artisan.id)).balance;

    expect(status === 'PAID' ? owed : status === 'CANCELLED' ? owed + 23.8 : -1).toBe(23.8);
  });
});

describe('the back office records what is handed over and puts figures right (P2-02)', () => {
  beforeEach(() => resetLocale());

  async function owing() {
    const base = desk();

    await tap(base.world.svc.cashLedger, base.artisan.id, ARTISAN, base.job.id, { amount: 119 });

    return base;
  }

  it('a remittance is stored with its reference, and cannot be more than what is owed', async () => {
    const { world, accountant, artisan } = await owing();
    const answer = await world.svc.cashLedger.recordRemittance(accountant.id, 'ACCOUNTANT', artisan.id, { amount: 20, reference: ' VIR-77 ', note: 'Virement D17' });

    expect(answer.entry).toEqual({ ...answer.entry, type: 'REMITTANCE', cashAmount: 0, commissionAmount: -20, reference: 'VIR-77', note: 'Virement D17', paymentId: null, interventionId: null });
    expect(answer.totals.balance).toBe(3.8);

    const tooMuch = await refusal(() => world.svc.cashLedger.recordRemittance(accountant.id, 'ACCOUNTANT', artisan.id, { amount: 3.801 }));

    expect(tooMuch?.status).toBe(400);
    expect(tooMuch?.message).toBe('Cet artisan ne doit que 3,800 TND: un versement plus grand n’est pas enregistré.');
    expect(rowsOf(world, 'cashLedgerEntry').length).toBe(2);

    await world.svc.cashLedger.recordRemittance(accountant.id, 'ACCOUNTANT', artisan.id, { amount: 3.8 });

    expect((await refusal(() => world.svc.cashLedger.recordRemittance(accountant.id, 'ACCOUNTANT', artisan.id, { amount: 0.001 })))?.message).toBe('Cet artisan ne doit rien à la plateforme.');
  });

  it('refuses an amount that is not an amount', async () => {
    const { world, accountant, artisan } = await owing();

    for (const amount of [0, -1, 0.0001, Number.NaN, '5', null, undefined]) {
      expect(`${String(amount)}: ${(await refusal(() => world.svc.cashLedger.recordRemittance(accountant.id, 'ACCOUNTANT', artisan.id, { amount } as any)))?.status}`).toBe(`${String(amount)}: 400`);
    }

    expect(rowsOf(world, 'cashLedgerEntry').length).toBe(1);
  });

  it('only the administrators and the accountant, and only for an artisan', async () => {
    const { world, admin, accountant, support, dispatcher, client, artisan, other } = await owing();
    const call = (id: number, role: string, target = artisan.id) => refusal(() => world.svc.cashLedger.recordRemittance(id, role as any, target, { amount: 1 }));

    expect((await call(support.id, 'SUPPORT'))?.status).toBe(403);
    expect((await call(dispatcher.id, 'DISPATCHER'))?.status).toBe(403);
    expect((await call(client.id, 'CLIENT'))?.status).toBe(403);
    expect((await call(artisan.id, ARTISAN))?.status).toBe(403);
    expect((await call(admin.id, 'ADMIN', client.id))?.status).toBe(404);
    expect((await call(admin.id, 'ADMIN', 99999))?.status).toBe(404);
    expect(rowsOf(world, 'cashLedgerEntry').length).toBe(1);
    expect(await call(admin.id, 'ADMIN')).toBe(null);
    expect(await call(accountant.id, 'ACCOUNTANT', other.id)).not.toBe(null);
  });

  it('the same key writes a remittance once; another amount under the same key is refused', async () => {
    const { world, accountant, artisan } = await owing();
    const first = await world.svc.cashLedger.recordRemittance(accountant.id, 'ACCOUNTANT', artisan.id, { amount: 5, requestKey: 'virement-0001' });
    const again = await world.svc.cashLedger.recordRemittance(accountant.id, 'ACCOUNTANT', artisan.id, { amount: 5, requestKey: 'virement-0001' });

    expect(again.replayed).toBe(true);
    expect(again.entry.id).toBe(first.entry.id);
    expect(again.totals.balance).toBe(18.8);
    expect((await refusal(() => world.svc.cashLedger.recordRemittance(accountant.id, 'ACCOUNTANT', artisan.id, { amount: 6, requestKey: 'virement-0001' })))?.status).toBe(409);
    expect(rowsOf(world, 'cashLedgerEntry').length).toBe(2);
  });

  it('two remittances of the whole balance at the same moment: one is recorded', async () => {
    const { world, admin, accountant, artisan } = await owing();
    const answers = await Promise.all([
      refusal(() => world.svc.cashLedger.recordRemittance(accountant.id, 'ACCOUNTANT', artisan.id, { amount: 23.8 })),
      refusal(() => world.svc.cashLedger.recordRemittance(admin.id, 'ADMIN', artisan.id, { amount: 23.8 })),
    ]);

    expect(answers.filter((answer) => answer === null).length).toBe(1);
    expect((await world.svc.cashLedger.getMyLedger(artisan.id, ARTISAN)).totals.balance).toBe(0);
    expect(rowsOf(world, 'cashLedgerEntry').filter((line) => line.type === 'REMITTANCE').length).toBe(1);
  });

  it('an adjustment starts an artisan from the balance they had before the ledger, or puts a figure right, and says why', async () => {
    const { world, admin, accountant, artisan, job } = desk();
    const opening = await world.svc.cashLedger.recordAdjustment(admin.id, 'ADMIN', artisan.id, { commissionAmount: 150.5, cashAmount: 752.5, reason: 'Solde au 1er octobre' });

    expect(opening.entry).toEqual({ ...opening.entry, type: 'ADJUSTMENT', cashAmount: 752.5, commissionAmount: 150.5, note: 'Solde au 1er octobre', commissionRate: null });
    expect(opening.totals).toEqual({ currency: 'TND', cashCollected: 752.5, commissionDue: 150.5, commissionRemitted: 0, balance: 150.5 });

    const fix = await world.svc.cashLedger.recordAdjustment(accountant.id, 'ACCOUNTANT', artisan.id, { commissionAmount: -0.5, interventionId: job.id, reason: 'Remise accordée au client' });

    expect(fix.entry.interventionId).toBe(job.id);
    expect(fix.totals.balance).toBe(150);
    expect(fix.totals.cashCollected).toBe(752.5);
  });

  it('an adjustment needs a reason, a figure that changes something, and a job that exists', async () => {
    const { world, admin, artisan } = desk();
    const call = (dto: Record<string, unknown>) => refusal(() => world.svc.cashLedger.recordAdjustment(admin.id, 'ADMIN', artisan.id, dto as any));

    expect((await call({ commissionAmount: 5 }))?.status).toBe(400);
    expect((await call({ commissionAmount: 5, reason: '  ' }))?.status).toBe(400);
    expect((await call({ commissionAmount: 5, reason: 'ab' }))?.status).toBe(400);
    expect((await call({ reason: 'sans montant' }))?.status).toBe(400);
    expect((await call({ commissionAmount: 0, cashAmount: 0, reason: 'zéro' }))?.status).toBe(400);
    expect((await call({ commissionAmount: 0.0001, reason: 'trop fin' }))?.status).toBe(400);
    expect((await call({ commissionAmount: Number.NaN, reason: 'pas un nombre' }))?.status).toBe(400);
    expect((await call({ commissionAmount: 5, reason: 'mission', interventionId: 99999 }))?.status).toBe(404);
    expect(rowsOf(world, 'cashLedgerEntry').length).toBe(0);
    expect(await call({ commissionAmount: -5, reason: 'un signe moins est permis' })).toBe(null);
  });

  it('the same key writes an adjustment once', async () => {
    const { world, admin, artisan } = desk();
    const dto = { commissionAmount: 5, reason: 'Régularisation', requestKey: 'adjust-0001' };
    const first = await world.svc.cashLedger.recordAdjustment(admin.id, 'ADMIN', artisan.id, dto);
    const again = await world.svc.cashLedger.recordAdjustment(admin.id, 'ADMIN', artisan.id, dto);

    expect(again.replayed).toBe(true);
    expect(again.entry.id).toBe(first.entry.id);
    expect((await refusal(() => world.svc.cashLedger.recordAdjustment(admin.id, 'ADMIN', artisan.id, { ...dto, commissionAmount: 6 })))?.status).toBe(409);
    expect(rowsOf(world, 'cashLedgerEntry').length).toBe(1);
  });

  it('the people who handle money see every artisan\'s balance, those who owe the most first', async () => {
    const { world, admin, accountant, support, artisan, other, job } = desk();

    await tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount: 119 });
    await world.svc.cashLedger.recordAdjustment(admin.id, 'ADMIN', other.id, { commissionAmount: 100, cashAmount: 500, reason: 'Solde de départ' });
    await world.svc.cashLedger.recordRemittance(accountant.id, 'ACCOUNTANT', other.id, { amount: 40 });

    const list = await world.svc.cashLedger.listBalances('ACCOUNTANT');

    expect(list.map((row: any) => [row.name, row.cashCollected, row.commissionDue, row.commissionRemitted, row.balance])).toEqual([
      ['Autre artisan', 500, 100, 40, 60],
      ['Artisan', 119, 23.8, 0, 23.8],
    ]);
    expect((await refusal(() => world.svc.cashLedger.listBalances('SUPPORT')))?.status).toBe(403);
    expect((await refusal(() => world.svc.cashLedger.listBalances(ARTISAN as any)))?.status).toBe(403);
    expect(support).toBeDefined();
  });

  it('an artisan reads their own ledger a page at a time, newest first, with the same totals on each page', async () => {
    const { world, admin, artisan, other } = desk();

    for (let n = 1; n <= 5; n += 1) await world.svc.cashLedger.recordAdjustment(admin.id, 'ADMIN', artisan.id, { commissionAmount: n, reason: `ligne ${n}` });
    await world.svc.cashLedger.recordAdjustment(admin.id, 'ADMIN', other.id, { commissionAmount: 1000, reason: 'autre artisan' });

    const first = await world.svc.cashLedger.getMyLedger(artisan.id, ARTISAN, { limit: 2 });

    expect(first.entries.map((line: any) => line.note)).toEqual(['ligne 5', 'ligne 4']);
    expect(first.totals.balance).toBe(15);
    expect(first.nextBefore).toBe(first.entries[1].id);

    const second = await world.svc.cashLedger.getMyLedger(artisan.id, ARTISAN, { limit: 2, before: first.nextBefore! });

    expect(second.entries.map((line: any) => line.note)).toEqual(['ligne 3', 'ligne 2']);

    const last = await world.svc.cashLedger.getMyLedger(artisan.id, ARTISAN, { limit: 2, before: second.nextBefore! });

    expect(last.entries.map((line: any) => line.note)).toEqual(['ligne 1']);
    expect(last.nextBefore).toBe(null);
    expect(last.totals.balance).toBe(15);
    expect((await world.svc.cashLedger.getMyLedger(artisan.id, ARTISAN, { limit: 100000 })).entries.length).toBe(5);
    expect((await world.svc.cashLedger.getMyLedger(artisan.id, ARTISAN, { limit: 0 })).entries.length).toBe(5);
  });

  it('a page is at most 200 lines, 50 when nothing is asked, and at least one', async () => {
    const { world, artisan } = desk();

    for (let n = 1; n <= 205; n += 1) world.memory.plant('cashLedgerEntry', { artisanId: artisan.id, type: 'ADJUSTMENT', cashAmount: 0, commissionAmount: 1, note: `ligne ${n}` });

    const ledger = world.svc.cashLedger;

    expect((await ledger.getMyLedger(artisan.id, ARTISAN)).entries.length).toBe(50);
    expect((await ledger.getMyLedger(artisan.id, ARTISAN, { limit: 100000 })).entries.length).toBe(200);
    expect((await ledger.getMyLedger(artisan.id, ARTISAN, { limit: -5 })).entries.length).toBe(1);
    expect((await ledger.getMyLedger(artisan.id, ARTISAN, { limit: 2.9 })).entries.length).toBe(2);
    expect((await ledger.getMyLedger(artisan.id, ARTISAN, { limit: 100000 })).nextBefore).not.toBe(null);
    expect((await ledger.getMyLedger(artisan.id, ARTISAN, { limit: 100000 })).totals.balance).toBe(205);
  });

  it('a page that ends exactly at the last line says there is no next page', async () => {
    const { world, admin, artisan } = desk();

    for (let n = 1; n <= 3; n += 1) await world.svc.cashLedger.recordAdjustment(admin.id, 'ADMIN', artisan.id, { commissionAmount: n, reason: `ligne ${n}` });

    const page = await world.svc.cashLedger.getMyLedger(artisan.id, ARTISAN, { limit: 3 });

    expect(page.entries.length).toBe(3);
    expect(page.nextBefore).toBe(null);
  });

  it('the people who handle money read one artisan\'s ledger; nobody else does, and not that of a customer', async () => {
    const { world, admin, support, client, artisan } = desk();

    await world.svc.cashLedger.recordAdjustment(admin.id, 'ADMIN', artisan.id, { commissionAmount: 5, reason: 'Départ' });

    const page = await world.svc.cashLedger.getArtisanLedger('ADMIN', artisan.id);

    expect(page.artisan).toEqual({ id: artisan.id, name: 'Artisan', phone: page.artisan.phone });
    expect(page.entries.length).toBe(1);
    expect((await refusal(() => world.svc.cashLedger.getArtisanLedger('SUPPORT', artisan.id)))?.status).toBe(403);
    expect((await refusal(() => world.svc.cashLedger.getArtisanLedger('ADMIN', client.id)))?.status).toBe(404);
    expect((await refusal(() => world.svc.cashLedger.getMyLedger(client.id, 'CLIENT' as any)))?.status).toBe(403);
    expect(support).toBeDefined();
  });

  it('every amount that leaves the service is a plain number, never a Decimal and never a text', async () => {
    const { world, accountant, artisan, job } = desk();
    const collected = await tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount: 12.345 }).catch(() => null);
    const answers: unknown[] = [
      collected,
      await world.svc.cashLedger.recordRemittance(accountant.id, 'ACCOUNTANT', artisan.id, { amount: 1 }).catch(() => null),
      await world.svc.cashLedger.getMyLedger(artisan.id, ARTISAN),
      await world.svc.cashLedger.getArtisanLedger('ADMIN', artisan.id),
      await world.svc.cashLedger.listBalances('ADMIN'),
    ];
    const seen: string[] = [];
    const walk = (value: unknown, path: string) => {
      if (value instanceof Decimal) seen.push(`${path}: a Decimal`);
      else if (Array.isArray(value)) value.forEach((item, at) => walk(item, `${path}[${at}]`));
      else if (value && typeof value === 'object' && !(value instanceof Date)) for (const [key, entry] of Object.entries(value)) walk(entry, `${path}.${key}`);
      else if (typeof value === 'string' && /^-?\d+\.\d+$/.test(value)) seen.push(`${path}: a text ${value}`);
    };

    answers.forEach((answer, at) => walk(answer, `answer${at}`));

    expect(seen).toEqual([]);
  });
});

/** Another request holds a lock; a test decides what it does with it, and what the request under test has done by then. */
async function whileHolding<T>(world: World, take: (tx: any) => Promise<void>, request: () => Promise<unknown>, atTheEnd: (tx: any) => Promise<void>, midway: () => T): Promise<{ answer: Refusal | null; seen: T }> {
  let release!: () => void;
  let locked!: () => void;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  const taken = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const holder = world.prisma.$transaction(async (tx: any) => {
    await take(tx);
    locked();
    await open;
    await atTheEnd(tx);
  });

  await taken;

  const waiting = refusal(request);

  await new Promise((resolve) => setTimeout(resolve, 25));

  let seen: T;

  try {
    seen = midway();
  } finally {
    release();
  }

  await holder;

  return { answer: await waiting, seen };
}

describe('a request waits for the job it changes, and decides on what it finds then (P2-02)', () => {
  beforeEach(() => resetLocale());

  async function declared() {
    const base = desk();
    const answer = await tap(base.world.svc.cashLedger, base.artisan.id, ARTISAN, base.job.id, { amount: 119 });

    return { ...base, paymentId: answer.payment.id as number };
  }

  const kinds = (world: World) => rowsOf(world, 'cashLedgerEntry').map((line) => line.type);

  it('a cancel that waits finds the payment paid in the meantime, and is turned away', async () => {
    const { world, admin, job, paymentId } = await declared();
    const { answer, seen } = await whileHolding(
      world,
      (tx) => lockJob(tx, job.id),
      () => world.svc.payments.cancel(paymentId, admin.id, {}),
      async (tx) => {
        await tx.payment.update({ where: { id: paymentId }, data: { status: 'PAID' } });
      },
      () => rowsOf(world, 'payment')[0].status,
    );

    expect(seen).toBe('AWAITING_CONFIRMATION');
    expect(answer?.status).toBe(400);
    expect(rowsOf(world, 'payment')[0].status).toBe('PAID');
    expect(kinds(world)).toEqual(['COLLECTION']);
  });

  it('a fail that waits finds the payment paid in the meantime, and is turned away', async () => {
    const { world, admin, job, paymentId } = await declared();
    const { answer, seen } = await whileHolding(
      world,
      (tx) => lockJob(tx, job.id),
      () => world.svc.payments.fail(paymentId, admin.id, {}),
      async (tx) => {
        await tx.payment.update({ where: { id: paymentId }, data: { status: 'PAID' } });
      },
      () => rowsOf(world, 'payment')[0].status,
    );

    expect(seen).toBe('AWAITING_CONFIRMATION');
    expect(answer?.status).toBe(400);
    expect(rowsOf(world, 'payment')[0].status).toBe('PAID');
    expect(kinds(world)).toEqual(['COLLECTION']);
  });

  it('a confirmation that waits finds the payment cancelled in the meantime, and is turned away', async () => {
    const { world, admin, job, paymentId } = await declared();
    const { answer, seen } = await whileHolding(
      world,
      (tx) => lockJob(tx, job.id),
      () => world.svc.payments.confirm(paymentId, admin.id, {}),
      async (tx) => {
        await tx.payment.update({ where: { id: paymentId }, data: { status: 'CANCELLED' } });
      },
      () => rowsOf(world, 'payment')[0].status,
    );

    expect(seen).toBe('AWAITING_CONFIRMATION');
    expect(answer?.status).toBe(400);
    expect(rowsOf(world, 'payment')[0].status).toBe('CANCELLED');
  });

  it('a collection that waits does not use a payment that was cancelled in the meantime', async () => {
    const { world, client, artisan, job } = desk();

    const asked = world.memory.plant('payment', { interventionId: job.id, method: 'CASH', provider: 'CASH', status: 'AWAITING_CONFIRMATION', amount: 100, createdById: client.id });
    const { answer, seen } = await whileHolding(
      world,
      (tx) => lockJob(tx, job.id),
      () => tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount: 119 }),
      async (tx) => {
        await tx.payment.update({ where: { id: asked.id }, data: { status: 'CANCELLED' } });
      },
      () => rowsOf(world, 'cashLedgerEntry').length,
    );

    expect(seen).toBe(0);
    expect(answer).toBe(null);

    const [cancelled, made] = rowsOf(world, 'payment');

    expect(cancelled.status).toBe('CANCELLED');
    expect(made.status).toBe('AWAITING_CONFIRMATION');
    expect(rowsOf(world, 'cashLedgerEntry').map((line) => line.paymentId)).toEqual([made.id]);
  });
});

describe('every write to a ledger waits for the artisan\'s ledger lock (P2-02)', () => {
  beforeEach(() => resetLocale());

  async function declared() {
    const base = desk();
    const answer = await tap(base.world.svc.cashLedger, base.artisan.id, ARTISAN, base.job.id, { amount: 119 });

    return { ...base, paymentId: answer.payment.id as number };
  }

  const count = (world: World) => rowsOf(world, 'cashLedgerEntry').length;
  const hold = (artisanId: number) => (tx: any) => lockCashLedger(tx, artisanId);
  const nothing = async () => undefined;

  it('collecting cash, recording a remittance, an adjustment, taking a collection back and putting it back', async () => {
    const seen: string[] = [];

    {
      const { world, artisan, job } = desk();
      const run = await whileHolding(world, hold(artisan.id), () => tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount: 50 }), nothing, () => count(world));

      seen.push(`collect: ${run.seen} then ${count(world)} ${run.answer}`);
    }

    {
      const { world, accountant, artisan, job } = desk();

      await tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount: 50 });

      const run = await whileHolding(world, hold(artisan.id), () => world.svc.cashLedger.recordRemittance(accountant.id, 'ACCOUNTANT', artisan.id, { amount: 1 }), nothing, () => count(world));

      seen.push(`remittance: ${run.seen} then ${count(world)} ${run.answer}`);
    }

    {
      const { world, admin, artisan } = desk();
      const run = await whileHolding(world, hold(artisan.id), () => world.svc.cashLedger.recordAdjustment(admin.id, 'ADMIN', artisan.id, { commissionAmount: 1, reason: 'Départ' }), nothing, () => count(world));

      seen.push(`adjustment: ${run.seen} then ${count(world)} ${run.answer}`);
    }

    {
      const { world, admin, artisan, paymentId } = await declared();
      const run = await whileHolding(world, hold(artisan.id), () => world.prisma.$transaction((tx: any) => reverseCollectionsOfPayment(tx, paymentId, { userId: admin.id, reason: 'Annulé' })), nothing, () => count(world));

      seen.push(`reversal: ${run.seen} then ${count(world)} ${run.answer}`);

      const back = await whileHolding(world, hold(artisan.id), () => world.prisma.$transaction((tx: any) => restoreCollectionOfPayment(tx, paymentId, { userId: admin.id })), nothing, () => count(world));

      seen.push(`restoring: ${back.seen} then ${count(world)} ${back.answer}`);
    }

    expect(seen).toEqual([
      'collect: 0 then 1 null',
      'remittance: 1 then 2 null',
      'adjustment: 0 then 1 null',
      'reversal: 1 then 2 null',
      'restoring: 2 then 3 null',
    ]);
  });

  it('collecting cash, and confirming cash nobody declared, wait for the payouts of the artisan', async () => {
    const seen: string[] = [];

    {
      const { world, artisan, job } = desk();
      const run = await whileHolding(world, (tx) => lockPayouts(tx, artisan.id), () => tap(world.svc.cashLedger, artisan.id, ARTISAN, job.id, { amount: 50 }), nothing, () => count(world));

      seen.push(`collect: ${run.seen} then ${count(world)} ${run.answer}`);
    }

    {
      const { world, admin, artisan, job } = desk();
      const loose = await world.svc.payments.createAdminManualPayment(admin.id, job.id, { method: 'CASH', amount: 119 });
      const run = await whileHolding(world, (tx) => lockPayouts(tx, artisan.id), () => world.svc.payments.confirm(loose.id, admin.id, {}), nothing, () => [count(world), rowsOf(world, 'payment')[0].status].join(' '));

      seen.push(`confirm, payouts: ${run.seen} then ${count(world)} ${rowsOf(world, 'payment')[0].status} ${run.answer}`);
    }

    {
      const { world, admin, artisan, job } = desk();
      const loose = await world.svc.payments.createAdminManualPayment(admin.id, job.id, { method: 'CASH', amount: 119 });
      const run = await whileHolding(world, hold(artisan.id), () => world.svc.payments.confirm(loose.id, admin.id, {}), nothing, () => [count(world), rowsOf(world, 'payment')[0].status].join(' '));

      seen.push(`confirm, ledger: ${run.seen} then ${count(world)} ${rowsOf(world, 'payment')[0].status} ${run.answer}`);
    }

    expect(seen).toEqual([
      'collect: 0 then 1 null',
      'confirm, payouts: 0 AWAITING_CONFIRMATION then 1 PAID null',
      'confirm, ledger: 0 AWAITING_CONFIRMATION then 1 PAID null',
    ]);
  });

  it('taking a collection back, because the payment was cancelled or failed, waits for the payouts of the artisan', async () => {
    const seen: string[] = [];

    for (const way of ['cancel', 'fail'] as const) {
      const { world, admin, artisan, paymentId } = await declared();
      const run = await whileHolding(world, (tx) => lockPayouts(tx, artisan.id), () => world.svc.payments[way](paymentId, admin.id, {}), nothing, () => count(world));

      seen.push(`${way}: ${run.seen} then ${count(world)} ${run.answer}`);
    }

    expect(seen).toEqual(['cancel: 1 then 2 null', 'fail: 1 then 2 null']);
  });

  it('the figures of a ledger come from one query, and so do the balances of all the artisans', async () => {
    const { world, admin, artisan } = desk();

    await world.svc.cashLedger.recordAdjustment(admin.id, 'ADMIN', artisan.id, { commissionAmount: 5, cashAmount: 25, reason: 'Départ' });

    const used = async (work: () => Promise<unknown>) => {
      world.memory.calls.length = 0;
      await work();

      return world.memory.calls.filter((call) => call.startsWith('cashLedgerEntry.'));
    };

    expect(await used(() => world.svc.cashLedger.getMyLedger(artisan.id, ARTISAN))).toEqual(['cashLedgerEntry.findMany', 'cashLedgerEntry.groupBy']);
    expect(await used(() => world.svc.cashLedger.listBalances('ADMIN'))).toEqual(['cashLedgerEntry.groupBy']);
  });

  it('the locks of the jobs, the calendars, the ledgers and the payouts are four different locks', () => {
    expect(new Set([LOCK_JOB, LOCK_ARTISAN, LOCK_CASH_LEDGER, LOCK_PAYOUT]).size).toBe(4);
  });
});

describe('what the database itself refuses (P2-02)', () => {
  beforeEach(() => resetLocale());

  const codeOf = async (work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (error) {
      return String((error as { code?: string }).code);
    }

    return null;
  };

  it('a line is taken back once, and a key is used once by an artisan', async () => {
    const { world, artisan, other } = desk();
    const line = (data: Record<string, unknown>) => world.prisma.cashLedgerEntry.create({ data: { artisanId: artisan.id, type: 'ADJUSTMENT', cashAmount: 0, commissionAmount: 1, ...data } });
    const first = await line({ type: 'COLLECTION' });

    expect(await codeOf(() => line({ type: 'REVERSAL', reversesId: first.id }))).toBe(null);
    expect(await codeOf(() => line({ type: 'REVERSAL', reversesId: first.id }))).toBe('P2002');

    expect(await codeOf(() => line({ requestKey: 'une-clef-0001' }))).toBe(null);
    expect(await codeOf(() => line({ requestKey: 'une-clef-0001' }))).toBe('P2002');
    expect(await codeOf(() => world.prisma.cashLedgerEntry.create({ data: { artisanId: other.id, type: 'ADJUSTMENT', requestKey: 'une-clef-0001' } }))).toBe(null);
    expect(await codeOf(() => line({}))).toBe(null);
    expect(await codeOf(() => line({}))).toBe(null);
  });
});

describe('what the app must send to collect cash (P2-02)', () => {
  it('the request key is a required text of 8 to 64 characters in the rules of the DTO', () => {
    const source = readSource('modules/cash-ledger/dto/cash-ledger.dto.ts');
    const start = source.indexOf('export class CollectCashDto');
    const body = source.slice(start, source.indexOf('export class', start + 10));

    expect(body).toMatch(/@IsString\(\)\s+@Length\(8, 64\)\s+requestKey: string;/);
    expect(body).not.toMatch(/requestKey\?/);
    expect(body.slice(body.indexOf('requestKey') - 120, body.indexOf('requestKey'))).not.toMatch(/IsOptional/);
  });
});

describe('who the routes of the ledger are open to (P2-02)', () => {
  it('the artisan declares and reads their own; the administrators and the accountant read the others and write', () => {
    const routes = scanController(readSource('modules/cash-ledger/cash-ledger.controller.ts'), TICKET_STAFF_ROLES);
    const finance = ['ACCOUNTANT', 'ADMIN', 'SUPER_ADMIN'];
    const opened = Object.fromEntries(routes.map((route) => [routeKey(route.method, route.path), [route.how, route.rolesEnforced, [...(route.roles ?? [])].sort()]]));

    expect(opened).toEqual({
      'POST /cash-ledger/interventions/:/collect-cash': ['roles', true, ['ARTISAN']],
      'GET /cash-ledger/mine': ['roles', true, ['ARTISAN']],
      'GET /cash-ledger/balances': ['roles', true, finance],
      'GET /cash-ledger/artisans/:': ['roles', true, finance],
      'POST /cash-ledger/artisans/:/remittances': ['roles', true, finance],
      'POST /cash-ledger/artisans/:/adjustments': ['roles', true, finance],
    });
  });
});
