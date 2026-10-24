import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { World, emptyWorld } from '../../common/testing/world';
import { resetLocale } from '../../common/locale/locale';
import { lockJob } from '../assignment/artisan-lock';
import { describeOpenPayment, isPlaceholder } from './open-payment';
import { settleComplaintRefund } from './financials-ops';
import { PaymentsService } from './payments.service';

/**
 * What a payment does to the rest of the books (P2-03), on the real services and a database that answers DECIMAL columns as
 * Decimal objects: the financials of a job come from its confirmed payments, a refund changes the payment, the financials and
 * the complaint together and tells the customer, a double click on confirm is one confirmation, and a job has one open
 * payment at a time.
 */
function desk(options: { quote?: number | null; invoice?: number | null; status?: string; artisan?: boolean } = {}) {
  const world = emptyWorld();
  const make = (role: string, name: string) => world.memory.plant('user', { role, name });
  const admin = make('ADMIN', 'Admin');
  const accountant = make('ACCOUNTANT', 'Comptable');
  const client = make('CLIENT', 'Client');
  const artisan = make('ARTISAN', 'Artisan');

  world.memory.plant('artisanProfile', { userId: artisan.id, verificationStatus: 'APPROVED' });

  const token = 'raw-link-0001';
  const job = world.memory.plant('intervention', {
    clientId: client.id,
    artisanId: options.artisan === false ? null : artisan.id,
    status: options.status ?? 'COMPLETED',
    serviceType: 'PLOMBIER',
    trackingToken: crypto.createHash('sha256').update(token).digest('hex'),
  });
  const amount = options.quote === undefined ? 120 : options.quote;
  const quote = amount === null ? null : world.memory.plant('quote', { interventionId: job.id, createdById: artisan.id, status: 'ACCEPTED', amountHT: amount, taxAmount: 0, amountTTC: amount, currency: 'TND' });
  // The company offers the usual ways and has an account for a transfer (P2-06: a request names a way the company offers).
  world.memory.plant('companySettings', { companyName: 'Smart Dépannage', paymentMethods: ['ONLINE', 'CASH', 'BANK_TRANSFER'], rib: '08006012345678901234' });

  const billed = options.invoice === undefined ? null : options.invoice;
  const invoice = billed === null ? null : world.memory.plant('invoice', { interventionId: job.id, status: 'ISSUED', amountHT: billed, taxAmount: 0, amountTTC: billed, currency: 'TND' });

  return { world, admin, accountant, client, artisan, job, quote, invoice, token };
}

type Desk = ReturnType<typeof desk>;

const rowsOf = (world: World, model: string) => world.memory.rows(model);
const num = (value: unknown) => Number(String(value));
const payment = (world: World, id: number) => rowsOf(world, 'payment').find((row) => row.id === id)!;
const jobRow = (d: Desk) => rowsOf(d.world, 'intervention').find((row) => row.id === d.job.id)!;
const events = (d: Desk, type?: string) => rowsOf(d.world, 'interventionEvent').filter((row) => row.interventionId === d.job.id && (!type || row.type === type));
const told = (d: Desk, call: string) => d.world.sink.filter((entry) => entry === call).length;

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

/** A payment of the job that waits for the back office, planted as it would be after a request. */
function plantPayment(d: Desk, fields: Record<string, unknown> = {}) {
  return d.world.memory.plant('payment', {
    interventionId: d.job.id,
    method: 'BANK_TRANSFER',
    provider: 'MANUAL',
    status: 'AWAITING_CONFIRMATION',
    amount: 120,
    amountRefunded: 0,
    currency: 'TND',
    createdById: d.client.id,
    ...fields,
  });
}

/** Asks for a payment as the admin would and confirms it. */
async function pay(d: Desk, amount: number, method = 'BANK_TRANSFER') {
  const asked = await d.world.svc.payments.createAdminManualPayment(d.admin.id, d.job.id, { method, amount });

  await d.world.svc.payments.confirm(asked.id, d.admin.id, {});

  return asked.id as number;
}

const financialsOf = (d: Desk) => rowsOf(d.world, 'interventionFinancials').filter((row) => row.interventionId === d.job.id);

/** Another request holds a lock; a test decides what it sees meanwhile and what it does at the end. */
async function whileHolding<T>(world: World, take: (tx: any) => Promise<void>, request: () => Promise<unknown>, midway: () => T, atTheEnd: (tx: any) => Promise<void> = async () => undefined): Promise<{ answer: Refusal | null; seen: T }> {
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

describe('the financials of a job are worked out from its confirmed payments (P2-03)', () => {
  beforeEach(() => resetLocale());

  it('confirming a payment writes what was received, the commission of 20 % and what the artisan is owed', async () => {
    const d = desk();
    const id = await pay(d, 120);
    const [row] = financialsOf(d);

    expect(payment(d.world, id).status).toBe('PAID');
    expect(financialsOf(d).length).toBe(1);
    expect([num(row.totalPrice), num(row.commissionRate), num(row.platformCommission), num(row.artisanPayout)]).toEqual([120, 20, 24, 96]);
    expect([num(row.paymentProviderFee), num(row.refundAmount), num(row.netRevenue), num(row.companyMargin)]).toEqual([0, 0, 24, 24]);
    expect(row.currency).toBe('TND');
    expect(row.calculatedById).toBe(d.admin.id);
  });

  it('works to the millime: 20 % of 12.345 is 2.469 and the rest is 9.876', async () => {
    const d = desk({ quote: 12.345 });

    await pay(d, 12.345);

    const [row] = financialsOf(d);

    expect([num(row.totalPrice), num(row.platformCommission), num(row.artisanPayout), num(row.netRevenue)]).toEqual([12.345, 2.469, 9.876, 2.469]);
  });

  it('several confirmed payments add up, and each confirmation works the figures out again', async () => {
    const d = desk();

    await pay(d, 50);
    expect(num(financialsOf(d)[0].totalPrice)).toBe(50);
    expect(num(financialsOf(d)[0].platformCommission)).toBe(10);

    await pay(d, 70);
    expect(financialsOf(d).length).toBe(1);
    expect([num(financialsOf(d)[0].totalPrice), num(financialsOf(d)[0].platformCommission), num(financialsOf(d)[0].artisanPayout)]).toEqual([120, 24, 96]);
  });

  it('the rate, the provider fee and the notes of the job stay when the payments change the amounts', async () => {
    const d = desk();

    d.world.memory.plant('interventionFinancials', { interventionId: d.job.id, totalPrice: 0, commissionRate: 15, platformCommission: 0, artisanPayout: 0, paymentProviderFee: 2.5, netRevenue: 0, companyMargin: 0, notes: 'Accord du 3 octobre' });

    await pay(d, 100);

    const [row] = financialsOf(d);

    expect([num(row.commissionRate), num(row.totalPrice), num(row.platformCommission), num(row.artisanPayout), num(row.paymentProviderFee), num(row.netRevenue)]).toEqual([15, 100, 15, 85, 2.5, 12.5]);
    expect(row.notes).toBe('Accord du 3 octobre');
  });

  it('nothing is worked out for a payment that is not confirmed: waiting, failed, cancelled', async () => {
    const d = desk();
    const waiting = plantPayment(d);
    const other = plantPayment(d, { status: 'PENDING' });

    await d.world.svc.payments.fail(waiting.id, d.admin.id, {});
    await d.world.svc.payments.cancel(other.id, d.admin.id, {});

    expect(financialsOf(d)).toEqual([]);
  });

  it('nothing is worked out for a job without an artisan, or for money in another currency; the payment is confirmed all the same', async () => {
    const nobody = desk({ artisan: false });
    const id = await pay(nobody, 120);

    expect(payment(nobody.world, id).status).toBe('PAID');
    expect(financialsOf(nobody)).toEqual([]);

    const abroad = desk();
    const euros = plantPayment(abroad, { currency: 'EUR' });

    await abroad.world.svc.payments.confirm(euros.id, abroad.admin.id, {});

    expect(payment(abroad.world, euros.id).status).toBe('PAID');
    expect(financialsOf(abroad)).toEqual([]);
  });

  it('a payment in another currency is left out of the figures of the company', async () => {
    const d = desk();

    await pay(d, 100);

    const euros = plantPayment(d, { currency: 'EUR', amount: 40 });

    await d.world.svc.payments.confirm(euros.id, d.admin.id, {});

    expect(num(financialsOf(d)[0].totalPrice)).toBe(100);
  });

  it('the back office route works the figures out again, keeping the rate, the fee and the notes it is given', async () => {
    const d = desk();

    await pay(d, 100);

    const answer: any = await d.world.svc.business.calculateInterventionFinancials(d.accountant.id, 'ACCOUNTANT', d.job.id, { commissionRate: 25, paymentProviderFee: 1.5, notes: '  frais du terminal  ' });

    expect([num(answer.totalPrice), num(answer.commissionRate), num(answer.platformCommission), num(answer.artisanPayout), num(answer.paymentProviderFee), num(answer.netRevenue)]).toEqual([100, 25, 25, 75, 1.5, 23.5]);
    expect(answer.notes).toBe('frais du terminal');
    expect(answer.calculatedById).toBe(d.accountant.id);
    expect(financialsOf(d).length).toBe(1);

    // asked again with nothing: the same figures, the rate and the fee as they were
    const again: any = await d.world.svc.business.calculateInterventionFinancials(d.admin.id, 'ADMIN', d.job.id, {});

    expect([num(again.commissionRate), num(again.paymentProviderFee), again.notes]).toEqual([25, 1.5, 'frais du terminal']);
  });

  it('the back office route turns away a job with no confirmed payment, a job with no artisan, a missing job and a role that is not staff', async () => {
    const d = desk();
    const call = (role: string, userId: number, jobId = d.job.id) => refusal(() => d.world.svc.business.calculateInterventionFinancials(userId, role as any, jobId, { commissionRate: 20 }));

    plantPayment(d);

    expect(await call('ADMIN', d.admin.id)).toEqual({ status: 400, message: 'Aucun paiement confirmé: les montants sont calculés à partir des paiements confirmés de l’intervention.' });
    expect((await call('ADMIN', d.admin.id, 9999))?.status).toBe(404);
    expect((await call('CLIENT', d.client.id))?.status).toBe(403);
    expect((await call('ARTISAN', d.artisan.id))?.status).toBe(403);
    expect(financialsOf(d)).toEqual([]);

    const nobody = desk({ artisan: false });

    expect((await refusal(() => nobody.world.svc.business.calculateInterventionFinancials(nobody.admin.id, 'ADMIN', nobody.job.id, {})))?.status).toBe(400);
  });

  it('a payment with no currency written is in the currency of the company', async () => {
    const d = desk();
    const row = plantPayment(d, { currency: null, amount: 80 });

    await d.world.svc.payments.confirm(row.id, d.admin.id, {});

    expect(num(financialsOf(d)[0].totalPrice)).toBe(80);
  });

  it('a payment marked as refunded counts as given back in full, even when its refunded amount was never written', async () => {
    const d = desk();

    plantPayment(d, { status: 'REFUNDED', amount: 50, amountRefunded: 0 });
    await pay(d, 70);

    const [row] = financialsOf(d);

    expect([num(row.totalPrice), num(row.refundAmount), num(row.netRevenue)]).toEqual([120, 50, 24 - 50]);
  });

  it('the figures route waits for the payments of the job to be decided, and works on what it finds then', async () => {
    const d = desk();
    const row = plantPayment(d);
    const { answer, seen } = await whileHolding(
      d.world,
      (tx) => lockJob(tx, d.job.id),
      () => d.world.svc.business.calculateInterventionFinancials(d.admin.id, 'ADMIN', d.job.id, { commissionRate: 10 }),
      () => financialsOf(d).length,
      async (tx) => {
        await tx.payment.update({ where: { id: row.id }, data: { status: 'PAID' } });
      },
    );

    expect(seen).toBe(0);
    expect(answer).toBe(null);
    expect([num(financialsOf(d)[0].totalPrice), num(financialsOf(d)[0].platformCommission)]).toEqual([120, 12]);
  });

  it('the body of the back office route no longer takes amounts: only the rate, the provider fee and the notes', () => {
    const source = fs.readFileSync(path.join(__dirname, '../business/dto/business.dto.ts'), 'utf8');
    const start = source.indexOf('class CalculateInterventionFinancialsDto');
    const body = source.slice(start, source.indexOf('\n}', start));

    expect([...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((found) => found[1])).toEqual(['commissionRate', 'paymentProviderFee', 'notes']);
  });
});

describe('a refund changes the payment, the financials and the complaint, and tells the customer (P2-03)', () => {
  beforeEach(() => resetLocale());

  async function refundable() {
    const d = desk({ invoice: 120 });
    const id = await pay(d, 120);
    const complaint = d.world.memory.plant('complaint', { interventionId: d.job.id, userId: d.client.id, title: 'Fuite', description: 'Toujours là', refundRequested: true, refundDecision: 'PENDING', status: 'IN_REVIEW' });

    return { d, id, complaint };
  }

  const complaintRow = (d: Desk, id: number) => rowsOf(d.world, 'complaint').find((row) => row.id === id)!;

  it('a partial refund of 20 changes all three records: the payment, the financials, the complaint', async () => {
    const { d, id, complaint } = await refundable();
    const answer: any = await d.world.svc.payments.refund(id, d.admin.id, { amount: 20, reason: 'Geste commercial' });

    expect([answer.status, num(answer.amountRefunded)]).toEqual(['PARTIALLY_REFUNDED', 20]);

    const row = payment(d.world, id);

    expect([row.status, num(row.amountRefunded), row.refundedById, row.refundReason]).toEqual(['PARTIALLY_REFUNDED', 20, d.admin.id, 'Geste commercial']);
    expect(row.refundedAt).toBeInstanceOf(Date);

    const [money] = financialsOf(d);

    expect([num(money.totalPrice), num(money.refundAmount), num(money.platformCommission), num(money.artisanPayout), num(money.netRevenue), num(money.companyMargin)]).toEqual([120, 20, 24, 96, 4, 4]);

    const decided = complaintRow(d, complaint.id);

    expect([decided.refundDecision, decided.refundApproved, num(decided.refundAmount), decided.refundDecidedById, decided.status]).toEqual(['PARTIAL_REFUND', true, 20, d.admin.id, 'REFUNDED']);
    expect(decided.refundDecidedAt).toBeInstanceOf(Date);
    expect(decided.resolvedAt).toBeInstanceOf(Date);
    expect(decided.closedAt).toBeInstanceOf(Date);
  });

  it('with no amount, what is left of the payment goes back: everything the first time, and the complaint is REFUNDED', async () => {
    const { d, id, complaint } = await refundable();

    await d.world.svc.payments.refund(id, d.admin.id, {});

    expect([payment(d.world, id).status, num(payment(d.world, id).amountRefunded)]).toEqual(['REFUNDED', 120]);
    expect([num(financialsOf(d)[0].refundAmount), num(financialsOf(d)[0].netRevenue)]).toEqual([120, -96]);
    expect([complaintRow(d, complaint.id).refundDecision, num(complaintRow(d, complaint.id).refundAmount)]).toEqual(['REFUNDED', 120]);
  });

  it('two partial refunds add up; with no amount the second one gives back what is left; a third has nothing to give', async () => {
    const { d, id, complaint } = await refundable();

    await d.world.svc.payments.refund(id, d.admin.id, { amount: 50 });
    expect([payment(d.world, id).status, num(payment(d.world, id).amountRefunded), complaintRow(d, complaint.id).refundDecision]).toEqual(['PARTIALLY_REFUNDED', 50, 'PARTIAL_REFUND']);

    await d.world.svc.payments.refund(id, d.admin.id, {});
    expect([payment(d.world, id).status, num(payment(d.world, id).amountRefunded), num(financialsOf(d)[0].refundAmount)]).toEqual(['REFUNDED', 120, 120]);

    expect(await refusal(() => d.world.svc.payments.refund(id, d.admin.id, {}))).toEqual({ status: 400, message: 'Seuls les paiements payés peuvent être remboursés.' });
    expect(num(payment(d.world, id).amountRefunded)).toBe(120);
  });

  it('more than what was paid is refused, in one refund or over two, and nothing changes', async () => {
    const { d, id, complaint } = await refundable();
    const tooMuch = 'Le montant total remboursé ne peut pas dépasser le montant du paiement.';

    expect(await refusal(() => d.world.svc.payments.refund(id, d.admin.id, { amount: 120.001 }))).toEqual({ status: 400, message: tooMuch });

    await d.world.svc.payments.refund(id, d.admin.id, { amount: 100 });

    expect(await refusal(() => d.world.svc.payments.refund(id, d.admin.id, { amount: 20.001 }))).toEqual({ status: 400, message: tooMuch });
    expect(num(payment(d.world, id).amountRefunded)).toBe(100);
    expect(num(financialsOf(d)[0].refundAmount)).toBe(100);
    expect(num(complaintRow(d, complaint.id).refundAmount)).toBe(100);
  });

  it('an amount that is not above 0 is refused', async () => {
    const { d, id } = await refundable();

    for (const amount of [0, -5]) {
      expect(await refusal(() => d.world.svc.payments.refund(id, d.admin.id, { amount }))).toEqual({ status: 400, message: 'Le montant du remboursement doit être supérieur à 0.' });
    }

    expect(payment(d.world, id).status).toBe('PAID');
    expect(num(financialsOf(d)[0].refundAmount)).toBe(0);
  });

  it('only a payment that was paid can be refunded', async () => {
    const d = desk();
    const outcomes: string[] = [];

    for (const status of ['PENDING', 'AWAITING_CONFIRMATION', 'FAILED', 'CANCELLED', 'REFUNDED']) {
      const row = plantPayment(d, { status });
      const answer = await refusal(() => d.world.svc.payments.refund(row.id, d.admin.id, { amount: 10 }));

      outcomes.push(`${status}: ${answer?.status}`);
    }

    expect(outcomes).toEqual(['PENDING: 400', 'AWAITING_CONFIRMATION: 400', 'FAILED: 400', 'CANCELLED: 400', 'REFUNDED: 400']);
    expect(await refusal(() => d.world.svc.payments.refund(9999, d.admin.id, { amount: 10 }))).toEqual({ status: 404, message: 'Paiement introuvable.' });
    expect(financialsOf(d)).toEqual([]);
  });

  it('a refund is counted on the whole job: the complaint is REFUNDED only when everything received went back', async () => {
    const d = desk();
    const first = await pay(d, 70);
    const second = await pay(d, 50);
    const complaint = d.world.memory.plant('complaint', { interventionId: d.job.id, userId: d.client.id, title: 'Fuite', description: 'x', refundRequested: true, refundDecision: 'PENDING' });

    await d.world.svc.payments.refund(first, d.admin.id, {});
    expect([complaintRow(d, complaint.id).refundDecision, num(complaintRow(d, complaint.id).refundAmount)]).toEqual(['PARTIAL_REFUND', 70]);
    expect([num(financialsOf(d)[0].totalPrice), num(financialsOf(d)[0].refundAmount)]).toEqual([120, 70]);

    // decided already: a later refund does not decide it again
    const decidedAt = complaintRow(d, complaint.id).refundDecidedAt;

    await d.world.svc.payments.refund(second, d.admin.id, {});
    expect([complaintRow(d, complaint.id).refundDecision, num(complaintRow(d, complaint.id).refundAmount), complaintRow(d, complaint.id).refundDecidedAt]).toEqual(['PARTIAL_REFUND', 70, decidedAt]);
    expect(num(financialsOf(d)[0].refundAmount)).toBe(120);
  });

  it('only the complaints that were waiting for a refund are decided: asked for or approved; the others are left as they are', async () => {
    const { d, id } = await refundable();
    const others = ['NOT_REQUESTED', 'REJECTED', 'REFUNDED', 'PARTIAL_REFUND'].map((refundDecision) => d.world.memory.plant('complaint', { interventionId: d.job.id, userId: d.client.id, title: refundDecision, description: 'x', refundDecision, status: 'OPEN' }));
    const approved = d.world.memory.plant('complaint', { interventionId: d.job.id, userId: d.client.id, title: 'approuvée', description: 'x', refundDecision: 'APPROVED', refundApproved: true, status: 'IN_REVIEW' });
    const elsewhere = d.world.memory.plant('intervention', { clientId: d.client.id, artisanId: d.artisan.id, status: 'COMPLETED', serviceType: 'PLOMBIER' });
    const stranger = d.world.memory.plant('complaint', { interventionId: elsewhere.id, userId: d.client.id, title: 'ailleurs', description: 'x', refundDecision: 'PENDING' });

    await d.world.svc.payments.refund(id, d.admin.id, { amount: 30 });

    expect(others.map((row) => [complaintRow(d, row.id).refundDecision, complaintRow(d, row.id).status])).toEqual([['NOT_REQUESTED', 'OPEN'], ['REJECTED', 'OPEN'], ['REFUNDED', 'OPEN'], ['PARTIAL_REFUND', 'OPEN']]);
    expect([complaintRow(d, approved.id).refundDecision, num(complaintRow(d, approved.id).refundAmount)]).toEqual(['PARTIAL_REFUND', 30]);
    expect(complaintRow(d, stranger.id).refundDecision).toBe('PENDING');
  });

  it('settling the complaints says how many it decided', async () => {
    const d = desk();

    for (const refundDecision of ['PENDING', 'APPROVED', 'REJECTED']) d.world.memory.plant('complaint', { interventionId: d.job.id, userId: d.client.id, title: refundDecision, description: 'x', refundDecision });

    const decided = await d.world.prisma.$transaction((tx: any) => settleComplaintRefund(tx, d.job.id, { userId: d.admin.id }, { received: 100, refunded: 100, kept: 0 }));
    const nothing = await d.world.prisma.$transaction((tx: any) => settleComplaintRefund(tx, d.job.id, { userId: d.admin.id }, { received: 100, refunded: 100, kept: 0 }));

    expect([decided, nothing]).toEqual([2, 0]);
    expect(rowsOf(d.world, 'complaint').map((row) => row.refundDecision)).toEqual(['REFUNDED', 'REFUNDED', 'REJECTED']);
  });

  it('the timeline says it with a fixed line, and how many complaints were decided is kept for the back office', async () => {
    const { d, id } = await refundable();

    await d.world.svc.payments.refund(id, d.admin.id, { amount: 20, reason: 'Ne pas répéter au client' });

    const [line] = events(d).filter((event) => event.title === 'Remboursement partiel enregistré');

    expect(line.message).toBe('Remboursement de 20,000 TND.');
    expect(JSON.stringify([line.title, line.message])).not.toContain('Ne pas répéter');
    expect(line.metadata).toEqual({ paymentId: id, reason: 'Ne pas répéter au client', refundAmount: 20, totalRefunded: 20, isFullRefund: false, complaintsDecided: 1 });
  });

  it('the customer is told: a payment notice naming the amount, once, with the refund in its data', async () => {
    const { d, id } = await refundable();
    const real = new PaymentsService(d.world.prisma, d.world.svc.events, d.world.svc.notifications);

    await real.refund(id, d.admin.id, { amount: 20 });

    const notices = rowsOf(d.world, 'notification').filter((row) => row.recipientId === d.client.id && row.title === 'Remboursement effectué');

    expect(notices.length).toBe(1);
    expect(notices[0].type).toBe('PAYMENT_RECEIVED');
    expect(notices[0].message).toBe('Un remboursement de 20,000 TND a été effectué sur votre paiement.');
    expect([notices[0].entityType, notices[0].entityId]).toEqual(['PAYMENT', id]);
    expect(notices[0].data).toEqual({ paymentId: id, interventionId: d.job.id, amount: 20, refund: true });
    expect(rowsOf(d.world, 'notification').filter((row) => row.recipientId === d.artisan.id)).toEqual([]);
  });

  it('each refund is told and written with its own amount, not the running total', async () => {
    const { d, id } = await refundable();
    const real = new PaymentsService(d.world.prisma, d.world.svc.events, d.world.svc.notifications);

    await real.refund(id, d.admin.id, { amount: 50 });
    await real.refund(id, d.admin.id, { amount: 30 });

    expect(rowsOf(d.world, 'notification').filter((row) => row.title === 'Remboursement effectué').map((row) => row.message)).toEqual([
      'Un remboursement de 50,000 TND a été effectué sur votre paiement.',
      'Un remboursement de 30,000 TND a été effectué sur votre paiement.',
    ]);
    expect(events(d).filter((event) => event.title === 'Remboursement partiel enregistré').map((event) => [event.message, event.metadata.refundAmount, event.metadata.totalRefunded])).toEqual([
      ['Remboursement de 50,000 TND.', 50, 50],
      ['Remboursement de 30,000 TND.', 30, 80],
    ]);
  });

  it('the last refund that completes the payment is the full one on the timeline', async () => {
    const { d, id } = await refundable();

    await d.world.svc.payments.refund(id, d.admin.id, { amount: 100 });
    await d.world.svc.payments.refund(id, d.admin.id, {});

    expect(events(d).map((event) => event.title).filter((title) => title.startsWith('Remboursement'))).toEqual(['Remboursement partiel enregistré', 'Remboursement enregistré']);
    expect(events(d).filter((event) => event.title === 'Remboursement enregistré')[0].metadata.isFullRefund).toBe(true);
  });

  it('a refund that is refused tells nobody and writes nothing on the timeline', async () => {
    const { d, id } = await refundable();
    const before = events(d).length;
    const calls = told(d, 'notifications.notifyPaymentRefunded');

    await refusal(() => d.world.svc.payments.refund(id, d.admin.id, { amount: 500 }));

    expect(events(d).length).toBe(before);
    expect(told(d, 'notifications.notifyPaymentRefunded')).toBe(calls);

    await d.world.svc.payments.refund(id, d.admin.id, { amount: 5 });
    expect(told(d, 'notifications.notifyPaymentRefunded')).toBe(calls + 1);
  });

  it('a notice that cannot be sent does not undo the refund', async () => {
    const { d, id } = await refundable();
    const real = new PaymentsService(d.world.prisma, d.world.svc.events, d.world.svc.notifications);

    d.world.svc.notifications.notify = async () => {
      throw new Error('the socket is down');
    };

    expect(await refusal(() => real.refund(id, d.admin.id, { amount: 20 }))).toBe(null);
    expect(num(payment(d.world, id).amountRefunded)).toBe(20);
    expect(rowsOf(d.world, 'notification').filter((row) => row.title === 'Remboursement effectué')).toEqual([]);
  });

  it('a job with no artisan has no financials to follow, but the payment and the complaint still change', async () => {
    const d = desk({ artisan: false });
    const row = plantPayment(d, { status: 'PAID', method: 'CASH' });
    const complaint = d.world.memory.plant('complaint', { interventionId: d.job.id, userId: d.client.id, title: 'Fuite', description: 'x', refundDecision: 'PENDING' });

    await d.world.svc.payments.refund(row.id, d.admin.id, { amount: 20 });

    expect(num(payment(d.world, row.id).amountRefunded)).toBe(20);
    expect(financialsOf(d)).toEqual([]);
    expect([complaintRow(d, complaint.id).refundDecision, num(complaintRow(d, complaint.id).refundAmount)]).toEqual(['PARTIAL_REFUND', 20]);
  });

  it('two refunds of 70 at the same moment on a payment of 120: one is made, the other is refused', async () => {
    const { d, id } = await refundable();
    const both = await Promise.all([refusal(() => d.world.svc.payments.refund(id, d.admin.id, { amount: 70 })), refusal(() => d.world.svc.payments.refund(id, d.admin.id, { amount: 70 }))]);

    expect(both.filter((one) => one === null).length).toBe(1);
    expect(both.find((one) => one !== null)).toEqual({ status: 400, message: 'Le montant total remboursé ne peut pas dépasser le montant du paiement.' });
    expect(num(payment(d.world, id).amountRefunded)).toBe(70);
    expect(num(financialsOf(d)[0].refundAmount)).toBe(70);
    expect(events(d).filter((event) => event.title === 'Remboursement partiel enregistré').length).toBe(1);
  });

  it('a refund waits for the job it changes and decides on what it finds then', async () => {
    const { d, id } = await refundable();
    const { answer, seen } = await whileHolding(d.world, (tx) => lockJob(tx, d.job.id), () => d.world.svc.payments.refund(id, d.admin.id, { amount: 20 }), () => num(payment(d.world, id).amountRefunded));

    expect(seen).toBe(0);
    expect(answer).toBe(null);
    expect(num(payment(d.world, id).amountRefunded)).toBe(20);
  });

  it('a refund of cash leaves the cash ledger of the artisan as it is: that cash is settled by an adjustment', async () => {
    const d = desk();
    const declared = await d.world.svc.cashLedger.collectCash(d.artisan.id, 'ARTISAN', d.job.id, { amount: 120, requestKey: 'tap-refund-0001' } as any);

    await d.world.svc.payments.confirm(declared.payment.id, d.admin.id, {});

    const before = rowsOf(d.world, 'cashLedgerEntry').map((line) => line.type);

    await d.world.svc.payments.refund(declared.payment.id, d.admin.id, { amount: 20 });

    expect(rowsOf(d.world, 'cashLedgerEntry').map((line) => line.type)).toEqual(before);
    expect(num(financialsOf(d)[0].refundAmount)).toBe(20);
  });
});

describe('confirming twice is one confirmation (P2-03)', () => {
  beforeEach(() => resetLocale());

  it('a second click answers with the payment as it is and writes nothing more', async () => {
    const d = desk({ invoice: 120 });
    const row = plantPayment(d);
    const first: any = await d.world.svc.payments.confirm(row.id, d.admin.id, { reference: 'VIR-1' });
    const lines = events(d, 'PAYMENT_CONFIRMED').length;
    const confirmedAt = payment(d.world, row.id).confirmedAt;
    const second: any = await d.world.svc.payments.confirm(row.id, d.accountant.id, { reference: 'VIR-2', adminNote: 'encore' });

    expect([first.status, second.status]).toEqual(['PAID', 'PAID']);
    expect(second.reference).toBe('VIR-1');
    expect(payment(d.world, row.id).confirmedById).toBe(d.admin.id);
    expect(payment(d.world, row.id).confirmedAt).toBe(confirmedAt);
    expect(payment(d.world, row.id).adminNote ?? null).not.toBe('encore');
    expect([lines, events(d, 'PAYMENT_CONFIRMED').length]).toEqual([1, 1]);
    expect(told(d, 'notifications.notifyPaymentReceived')).toBe(1);
  });

  it('two clicks at the same moment: one confirmation, one line on the timeline, one notice, one set of figures', async () => {
    const d = desk({ invoice: 120 });
    const row = plantPayment(d);
    const both = await Promise.all([refusal(() => d.world.svc.payments.confirm(row.id, d.admin.id, {})), refusal(() => d.world.svc.payments.confirm(row.id, d.admin.id, {}))]);

    expect(both).toEqual([null, null]);
    expect(payment(d.world, row.id).status).toBe('PAID');
    expect(events(d, 'PAYMENT_CONFIRMED').length).toBe(1);
    expect(told(d, 'notifications.notifyPaymentReceived')).toBe(1);
    expect(financialsOf(d).length).toBe(1);
    expect(num(financialsOf(d)[0].totalPrice)).toBe(120);
    expect(rowsOf(d.world, 'invoice')[0].status).toBe('PAID');
  });

  it('three clicks at the same moment on cash the artisan declared: one line in the ledger', async () => {
    const d = desk();
    const declared = await d.world.svc.cashLedger.collectCash(d.artisan.id, 'ARTISAN', d.job.id, { amount: 120, requestKey: 'tap-double-0001' } as any);
    const clicks = await Promise.all([1, 2, 3].map(() => refusal(() => d.world.svc.payments.confirm(declared.payment.id, d.admin.id, {}))));

    expect(clicks).toEqual([null, null, null]);
    expect(rowsOf(d.world, 'cashLedgerEntry').map((line) => line.type)).toEqual(['COLLECTION']);
    expect(events(d, 'PAYMENT_CONFIRMED').length).toBe(1);
  });

  it('two clicks at the same moment on cash nobody declared: the artisan owes the commission once', async () => {
    const d = desk();
    const row = plantPayment(d, { method: 'CASH', amount: 100 });

    await Promise.all([d.world.svc.payments.confirm(row.id, d.admin.id, {}), d.world.svc.payments.confirm(row.id, d.admin.id, {})]);

    expect(rowsOf(d.world, 'cashLedgerEntry').map((line) => [line.type, String(line.cashAmount), String(line.commissionAmount)])).toEqual([['COLLECTION', '100', '20']]);
  });

  it('a payment that was cancelled, refunded or never asked for cannot be confirmed', async () => {
    const d = desk();
    const outcomes: string[] = [];

    for (const status of ['CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED']) {
      const row = plantPayment(d, { status });
      const answer = await refusal(() => d.world.svc.payments.confirm(row.id, d.admin.id, {}));

      outcomes.push(`${status}: ${answer?.status} ${answer?.message}`);
    }

    expect(outcomes).toEqual([
      'CANCELLED: 400 Ce paiement ne peut pas être confirmé car son statut est CANCELLED.',
      'REFUNDED: 400 Ce paiement ne peut pas être confirmé car son statut est REFUNDED.',
      'PARTIALLY_REFUNDED: 400 Ce paiement ne peut pas être confirmé car son statut est PARTIALLY_REFUNDED.',
    ]);
    expect((await refusal(() => d.world.svc.payments.confirm(9999, d.admin.id, {})))?.status).toBe(404);
    expect(financialsOf(d)).toEqual([]);
  });

  it('a click that waits for the job finds the payment cancelled meanwhile, and is turned away', async () => {
    const d = desk();
    const row = plantPayment(d);
    const { answer, seen } = await whileHolding(
      d.world,
      (tx) => lockJob(tx, d.job.id),
      () => d.world.svc.payments.confirm(row.id, d.admin.id, {}),
      () => payment(d.world, row.id).status,
      async (tx) => {
        await tx.payment.update({ where: { id: row.id }, data: { status: 'CANCELLED' } });
      },
    );

    expect(seen).toBe('AWAITING_CONFIRMATION');
    expect(answer).toEqual({ status: 400, message: 'Ce paiement ne peut pas être confirmé car son statut est CANCELLED.' });
    expect(payment(d.world, row.id).status).toBe('CANCELLED');
    expect(financialsOf(d)).toEqual([]);
    expect(events(d, 'PAYMENT_CONFIRMED')).toEqual([]);
  });

  it('a click that waits for the job finds the payment confirmed meanwhile, and answers with it without a second confirmation', async () => {
    const d = desk();
    const row = plantPayment(d);
    const { answer } = await whileHolding(
      d.world,
      (tx) => lockJob(tx, d.job.id),
      () => d.world.svc.payments.confirm(row.id, d.admin.id, {}),
      () => payment(d.world, row.id).status,
      async (tx) => {
        await tx.payment.update({ where: { id: row.id }, data: { status: 'PAID', confirmedById: d.accountant.id } });
      },
    );

    expect(answer).toBe(null);
    expect(payment(d.world, row.id).confirmedById).toBe(d.accountant.id);
    expect(events(d, 'PAYMENT_CONFIRMED')).toEqual([]);
    expect(told(d, 'notifications.notifyPaymentReceived')).toBe(0);
  });

  it('a payment that failed can still be confirmed after all, once', async () => {
    const d = desk();
    const row = plantPayment(d);

    await d.world.svc.payments.fail(row.id, d.admin.id, { reason: 'Virement non reçu' });
    await Promise.all([d.world.svc.payments.confirm(row.id, d.admin.id, {}), d.world.svc.payments.confirm(row.id, d.admin.id, {})]);

    expect(payment(d.world, row.id).status).toBe('PAID');
    expect(events(d, 'PAYMENT_CONFIRMED').length).toBe(1);
    expect(num(financialsOf(d)[0].totalPrice)).toBe(120);
  });
});

describe('the job and its invoice are paid when the confirmed payments cover them (P2-03)', () => {
  beforeEach(() => resetLocale());

  const invoiceRow = (d: Desk) => rowsOf(d.world, 'invoice').find((row) => row.interventionId === d.job.id)!;

  it('a part payment leaves the job and the invoice as they are; the payment that completes them pays both', async () => {
    const d = desk({ invoice: 120, status: 'PAYMENT_PENDING' });

    await pay(d, 50);
    expect([jobRow(d).status, jobRow(d).paidAt ?? null, invoiceRow(d).status, invoiceRow(d).paidAt ?? null]).toEqual(['PAYMENT_PENDING', null, 'ISSUED', null]);

    await pay(d, 70);
    expect([jobRow(d).status, invoiceRow(d).status]).toEqual(['PAID', 'PAID']);
    expect(jobRow(d).paidAt).toBeInstanceOf(Date);
    expect(invoiceRow(d).paidAt).toBeInstanceOf(Date);
  });

  it('one payment of everything pays the job and the invoice at once', async () => {
    const d = desk({ invoice: 120, status: 'PAYMENT_PENDING' });

    await pay(d, 120);

    expect([jobRow(d).status, invoiceRow(d).status]).toEqual(['PAID', 'PAID']);
  });

  it('a millime short is a part payment', async () => {
    const d = desk({ invoice: 120, status: 'PAYMENT_PENDING' });

    await pay(d, 119.999);
    expect([jobRow(d).status, invoiceRow(d).status]).toEqual(['PAYMENT_PENDING', 'ISSUED']);

    await pay(d, 0.001);
    expect([jobRow(d).status, invoiceRow(d).status]).toEqual(['PAID', 'PAID']);
  });

  it('without an invoice the accepted quote is what is to be paid', async () => {
    const d = desk({ status: 'PAYMENT_PENDING' });

    await pay(d, 100);
    expect(jobRow(d).status).toBe('PAYMENT_PENDING');

    await pay(d, 20);
    expect(jobRow(d).status).toBe('PAID');
  });

  it('a cancelled invoice is not what is to be paid: the accepted quote is', async () => {
    const d = desk({ invoice: 500, status: 'PAYMENT_PENDING' });

    invoiceRow(d).status = 'CANCELLED';

    await pay(d, 120);

    expect(jobRow(d).status).toBe('PAID');
    expect(invoiceRow(d).status).toBe('CANCELLED');
  });

  it('a draft invoice is not what is to be paid either: the accepted quote is, and the financials are made from it', async () => {
    // the draft asks less (80) than the quote (120): were it the document, the financials would price the job at 80
    const d = desk({ invoice: 80, status: 'PAYMENT_PENDING' });

    invoiceRow(d).status = 'DRAFT';

    await pay(d, 120);

    expect(jobRow(d).status).toBe('PAID');
    expect(invoiceRow(d).status).toBe('DRAFT');
    expect(num(financialsOf(d)[0].totalPrice)).toBe(120);
  });

  it('with nothing to compare (no invoice, no accepted quote) a confirmation pays the job', async () => {
    const d = desk({ quote: null, status: 'PAYMENT_PENDING' });
    const row = plantPayment(d, { amount: 10 });

    await d.world.svc.payments.confirm(row.id, d.admin.id, {});

    expect(jobRow(d).status).toBe('PAID');
  });

  it('a document in another currency cannot be compared: a confirmation pays the job and the invoice', async () => {
    const d = desk({ invoice: 120, status: 'PAYMENT_PENDING' });

    invoiceRow(d).currency = 'EUR';

    await pay(d, 10);

    expect([jobRow(d).status, invoiceRow(d).status]).toEqual(['PAID', 'PAID']);
  });

  it('money that went back does not pay: what is kept is what counts', async () => {
    const d = desk({ invoice: 120, status: 'PAYMENT_PENDING' });

    plantPayment(d, { status: 'PARTIALLY_REFUNDED', amount: 100, amountRefunded: 80 });
    await pay(d, 90);

    // 20 kept of the first, 90 of the second: 110 of 120
    expect([jobRow(d).status, invoiceRow(d).status]).toEqual(['PAYMENT_PENDING', 'ISSUED']);

    await pay(d, 10);
    expect([jobRow(d).status, invoiceRow(d).status]).toEqual(['PAID', 'PAID']);
  });

  it('the invoice the payment is linked to is the one that is paid', async () => {
    const d = desk({ invoice: 120, status: 'PAYMENT_PENDING' });
    const row = plantPayment(d, { invoiceId: invoiceRow(d).id });

    await d.world.svc.payments.confirm(row.id, d.admin.id, {});

    expect(invoiceRow(d).status).toBe('PAID');
  });

  it('a refund afterwards does not put the job back: it stays paid', async () => {
    const d = desk({ invoice: 120, status: 'PAYMENT_PENDING' });
    const id = await pay(d, 120);

    await d.world.svc.payments.refund(id, d.admin.id, { amount: 20 });

    expect([jobRow(d).status, invoiceRow(d).status]).toEqual(['PAID', 'PAID']);
  });

  it('a job that is still being worked on takes the payment (and notes the day the money came) but does not move', async () => {
    const d = desk({ invoice: 120, status: 'IN_PROGRESS' });

    await pay(d, 120);

    expect(jobRow(d).status).toBe('IN_PROGRESS');
    expect(jobRow(d).paidAt).toBeInstanceOf(Date);
    expect(invoiceRow(d).status).toBe('PAID');
    expect(num(financialsOf(d)[0].totalPrice)).toBe(120);
  });
});

describe('a job has one open payment at a time (P2-03)', () => {
  beforeEach(() => resetLocale());

  const ask = (d: Desk, dto: Record<string, unknown>) => d.world.svc.payments.createClientPaymentRequest(d.client.id, d.job.id, dto as any);
  const askAsAdmin = (d: Desk, dto: Record<string, unknown>) => d.world.svc.payments.createAdminManualPayment(d.admin.id, d.job.id, dto as any);
  const askAsVisitor = (d: Desk, dto: Record<string, unknown>) => d.world.svc.guest.createGuestPayment(d.job.id, d.token, dto as any);
  const open = (d: Desk) => rowsOf(d.world, 'payment').filter((row) => row.interventionId === d.job.id && ['PENDING', 'AWAITING_CONFIRMATION'].includes(row.status));
  const requests = (d: Desk) => events(d, 'PAYMENT_PENDING').length;

  it('the customer who asks again for the same payment gets the open one back: nothing is written', async () => {
    const d = desk();
    const first: any = await ask(d, { method: 'BANK_TRANSFER' });
    const second: any = await ask(d, { method: 'BANK_TRANSFER' });

    expect(first.replayed).toBeUndefined();
    expect(second.replayed).toBe(true);
    expect(second.id).toBe(first.id);
    expect(typeof second.instructions).toBe('string');
    expect(rowsOf(d.world, 'payment').length).toBe(1);
    expect(requests(d)).toBe(1);
  });

  it('another amount or another way of paying is refused while a payment waits, and nothing is written', async () => {
    const d = desk();

    await ask(d, { method: 'BANK_TRANSFER' });

    const message = 'Un paiement de 120,000 TND par virement est déjà en attente pour cette mission. Faites-le annuler par l’administration ou attendez sa confirmation.';

    expect(await refusal(() => ask(d, { method: 'CASH' }))).toEqual({ status: 409, message });
    expect(await refusal(() => ask(d, { method: 'BANK_TRANSFER', amount: 50 }))).toEqual({ status: 409, message });
    expect(await refusal(() => askAsAdmin(d, { method: 'CASH', amount: 120 }))).toEqual({ status: 409, message });
    expect(await refusal(() => askAsVisitor(d, { method: 'CASH' }))).toEqual({ status: 409, message });
    expect(rowsOf(d.world, 'payment').length).toBe(1);
    expect(requests(d)).toBe(1);
  });

  it('an online request that nobody can pay (no provider took it) is cancelled when another way of paying is chosen', async () => {
    const d = desk();
    const online: any = await ask(d, { method: 'ONLINE' });
    const transfer: any = await ask(d, { method: 'BANK_TRANSFER' });

    expect(transfer.id).not.toBe(online.id);
    expect([payment(d.world, online.id).status, payment(d.world, online.id).cancelReason]).toEqual(['CANCELLED', 'Remplacé par une autre demande de paiement.']);
    expect(payment(d.world, online.id).cancelledAt).toBeInstanceOf(Date);
    expect(open(d).map((row) => row.id)).toEqual([transfer.id]);

    // a card request is one too
    const card: any = await ask(d, { method: 'ONLINE_CARD' }).catch((error: any) => error);

    expect(card.getStatus?.()).toBe(409);
  });

  it('the same online request again is the open one; a card request is replaced by a cash one', async () => {
    const d = desk();
    const first: any = await ask(d, { method: 'ONLINE_CARD' });
    const again: any = await ask(d, { method: 'ONLINE_CARD' });
    const cash: any = await ask(d, { method: 'CASH' });

    expect([again.replayed, again.id]).toEqual([true, first.id]);
    expect(payment(d.world, first.id).status).toBe('CANCELLED');
    expect(open(d).map((row) => row.id)).toEqual([cash.id]);
  });

  it('an online payment a provider took is a real payment: it is not cancelled for another request', async () => {
    const d = desk();
    const taken = plantPayment(d, { method: 'ONLINE', status: 'PENDING', providerPaymentId: 'pi_123' });

    expect((await refusal(() => ask(d, { method: 'CASH' })))?.status).toBe(409);
    expect(payment(d.world, taken.id).status).toBe('PENDING');
    expect(rowsOf(d.world, 'payment').length).toBe(1);
  });

  it('once a payment is decided (paid, failed, cancelled, refunded) the next request is welcome', async () => {
    for (const status of ['PAID', 'FAILED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED']) {
      const d = desk();

      plantPayment(d, { status, amount: 50 });

      const next: any = await ask(d, { method: 'BANK_TRANSFER', amount: 70 });

      expect(`${status}: ${next.replayed} ${num(next.amount)}`).toBe(`${status}: undefined 70`);
      expect(open(d).length).toBe(1);
    }
  });

  it('two requests at the same moment: the same one is written once; two different ones, one is refused', async () => {
    const same = desk();
    const both = await Promise.all([refusal(() => ask(same, { method: 'BANK_TRANSFER' })), refusal(() => ask(same, { method: 'BANK_TRANSFER' }))]);

    expect(both).toEqual([null, null]);
    expect(rowsOf(same.world, 'payment').length).toBe(1);
    expect(requests(same)).toBe(1);

    const different = desk();
    const mixed = await Promise.all([refusal(() => ask(different, { method: 'BANK_TRANSFER' })), refusal(() => askAsVisitor(different, { method: 'CASH' }))]);

    expect(mixed.filter((one) => one === null).length).toBe(1);
    expect(mixed.find((one) => one !== null)?.status).toBe(409);
    expect(rowsOf(different.world, 'payment').length).toBe(1);
  });

  it('the back office asking again for the same payment gets the open one back too', async () => {
    const d = desk();
    const first = await askAsAdmin(d, { method: 'CASH', amount: 80 });
    const second = await askAsAdmin(d, { method: 'CASH', amount: 80 });

    expect(second.id).toBe(first.id);
    expect(rowsOf(d.world, 'payment').length).toBe(1);
    expect(events(d, 'PAYMENT_PENDING').length).toBe(1);

    // two requests at the same moment: one payment
    const same = desk();
    const both = await Promise.all([askAsAdmin(same, { method: 'BANK_TRANSFER', amount: 60 }), askAsAdmin(same, { method: 'BANK_TRANSFER', amount: 60 })]);

    expect(both[0].id).toBe(both[1].id);
    expect(rowsOf(same.world, 'payment').length).toBe(1);
    expect(events(same, 'PAYMENT_PENDING').length).toBe(1);

    await d.world.svc.payments.cancel(first.id, d.admin.id, {});

    const next = await askAsAdmin(d, { method: 'BANK_TRANSFER', amount: 80 });

    expect(next.id).not.toBe(first.id);
  });

  it('the visitor with the link: the same request again is the open one, and the answer says so', async () => {
    const d = desk();
    const first: any = await askAsVisitor(d, { method: 'BANK_TRANSFER', reference: 'VIR-9' });
    const second: any = await askAsVisitor(d, { method: 'BANK_TRANSFER' });

    expect(first.replayed).toBeUndefined();
    expect(second.replayed).toBe(true);
    expect(second.payment.id).toBe(first.payment.id);
    expect(second.instructions).toBe('Effectuez le virement puis envoyez la référence.');
    expect(rowsOf(d.world, 'payment').length).toBe(1);
    expect(requests(d)).toBe(1);
  });

  it('the visitor can pay for a job after the quote was accepted without the job jumping to PAYMENT_PENDING', async () => {
    const d = desk({ status: 'ASSIGNED' });

    await askAsVisitor(d, { method: 'CASH' });

    expect(jobRow(d).status).toBe('ASSIGNED');
    expect(jobRow(d).paymentPendingAt ?? null).toBe(null);
    expect(rowsOf(d.world, 'payment').length).toBe(1);
  });

  it('a request for a job that is finished moves it to PAYMENT_PENDING and writes the date, once', async () => {
    for (const who of ['visitor', 'customer']) {
      const d = desk({ status: 'COMPLETED' });
      const go = () => (who === 'visitor' ? askAsVisitor(d, { method: 'CASH' }) : ask(d, { method: 'CASH' }));

      await go();

      const movedAt = jobRow(d).paymentPendingAt;

      expect(`${who}: ${jobRow(d).status}`).toBe(`${who}: PAYMENT_PENDING`);
      expect(movedAt).toBeInstanceOf(Date);

      await new Promise((resolve) => setTimeout(resolve, 5));
      await go();
      expect(jobRow(d).paymentPendingAt).toBe(movedAt);
    }
  });

  it('a job that is being worked on does not move for a customer’s request either', async () => {
    const d = desk({ status: 'IN_PROGRESS' });

    await ask(d, { method: 'BANK_TRANSFER' });

    expect(jobRow(d).status).toBe('IN_PROGRESS');
    expect(jobRow(d).paymentPendingAt ?? null).toBe(null);
  });

  it('the artisan’s declaration of cash does not wait for other cash, and is refused while a transfer or a card payment is open', async () => {
    const d = desk({ status: 'IN_PROGRESS' });

    await ask(d, { method: 'CASH', amount: 120 });

    const declared = await d.world.svc.cashLedger.collectCash(d.artisan.id, 'ARTISAN', d.job.id, { amount: 120, requestKey: 'tap-open-0001' } as any);

    expect(rowsOf(d.world, 'payment').length).toBe(1);
    expect(declared.payment.method).toBe('CASH');

    const other = desk({ status: 'IN_PROGRESS' });

    await ask(other, { method: 'BANK_TRANSFER' });

    const refused = await refusal(() => other.world.svc.cashLedger.collectCash(other.artisan.id, 'ARTISAN', other.job.id, { amount: 50, requestKey: 'tap-open-0002' } as any));

    expect(refused).toEqual({ status: 409, message: 'Un paiement de 120,000 TND est déjà en attente pour cette mission: contactez l’administration.' });
    expect(rowsOf(other.world, 'cashLedgerEntry')).toEqual([]);
  });

  it('who is waiting is told in words: the amount and the way', () => {
    const words = [
      ['CASH', 'en espèces'],
      ['BANK_TRANSFER', 'par virement'],
      ['ONLINE', 'en ligne'],
      ['ONLINE_CARD', 'par carte'],
    ].map(([method, said]) => [describeOpenPayment({ method, amount: 12.5, currency: 'TND' }), `12,500 TND ${said}`]);

    expect(words.map(([found]) => found)).toEqual(words.map(([, wanted]) => wanted));
  });

  it('only an online request still pending with no provider behind it is a placeholder', () => {
    const cases: Array<[Record<string, unknown>, boolean]> = [
      [{ status: 'PENDING', method: 'ONLINE' }, true],
      [{ status: 'PENDING', method: 'ONLINE_CARD' }, true],
      [{ status: 'PENDING', method: 'ONLINE', providerPaymentId: 'pi_1' }, false],
      [{ status: 'PENDING', method: 'BANK_TRANSFER' }, false],
      [{ status: 'PENDING', method: 'CASH' }, false],
      [{ status: 'AWAITING_CONFIRMATION', method: 'ONLINE' }, false],
      [{ status: 'PAID', method: 'ONLINE' }, false],
    ];

    expect(cases.map(([row]) => isPlaceholder(row))).toEqual(cases.map(([, wanted]) => wanted));
  });
});

describe('failing or cancelling a payment keeps the reason (P2-03)', () => {
  beforeEach(() => resetLocale());

  it('a failure keeps the reason on the payment and in the data of the timeline line, not in its words', async () => {
    const d = desk();
    const row = plantPayment(d);

    await d.world.svc.payments.fail(row.id, d.admin.id, { reason: 'Virement introuvable', adminNote: 'vu avec la banque' });

    expect([payment(d.world, row.id).status, payment(d.world, row.id).failureReason, payment(d.world, row.id).adminNote]).toEqual(['FAILED', 'Virement introuvable', 'vu avec la banque']);
    expect(payment(d.world, row.id).failedAt).toBeInstanceOf(Date);
    expect(payment(d.world, row.id).cancelReason ?? null).toBe(null);

    const [line] = events(d).filter((event) => event.title === 'Paiement échoué');

    expect([line.message, line.metadata.reason]).toEqual(['Le paiement a échoué.', 'Virement introuvable']);
  });

  it('a cancellation keeps the reason in its own column', async () => {
    const d = desk();
    const row = plantPayment(d);

    await d.world.svc.payments.cancel(row.id, d.admin.id, { reason: 'Le client paie en espèces', adminNote: 'appel de 10h' });

    expect([payment(d.world, row.id).status, payment(d.world, row.id).cancelReason, payment(d.world, row.id).adminNote]).toEqual(['CANCELLED', 'Le client paie en espèces', 'appel de 10h']);
    expect(payment(d.world, row.id).cancelledAt).toBeInstanceOf(Date);
    expect(payment(d.world, row.id).failureReason ?? null).toBe(null);

    const [line] = events(d).filter((event) => event.title === 'Paiement annulé');

    expect([line.message, line.metadata.reason]).toEqual(['Le paiement a été annulé.', 'Le client paie en espèces']);
  });

  it('with no reason typed, the note of the back office is the reason, and with neither a fixed sentence is', async () => {
    const d = desk();
    const rows = [plantPayment(d), plantPayment(d), plantPayment(d), plantPayment(d)];

    await d.world.svc.payments.fail(rows[0].id, d.admin.id, { adminNote: 'note seule' });
    await d.world.svc.payments.fail(rows[1].id, d.admin.id, {});
    await d.world.svc.payments.cancel(rows[2].id, d.admin.id, { adminNote: 'note seule' });
    await d.world.svc.payments.cancel(rows[3].id, d.admin.id, {});

    expect([payment(d.world, rows[0].id).failureReason, payment(d.world, rows[1].id).failureReason]).toEqual(['note seule', 'Le paiement a échoué.']);
    expect([payment(d.world, rows[2].id).cancelReason, payment(d.world, rows[3].id).cancelReason]).toEqual(['note seule', 'Le paiement a été annulé.']);
  });

  it('a payment that was paid or refunded can be neither failed nor cancelled', async () => {
    const d = desk();
    const outcomes: string[] = [];

    for (const status of ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED']) {
      const row = plantPayment(d, { status });

      outcomes.push(`${status}: ${(await refusal(() => d.world.svc.payments.fail(row.id, d.admin.id, { reason: 'x' })))?.status} ${(await refusal(() => d.world.svc.payments.cancel(row.id, d.admin.id, { reason: 'x' })))?.status}`);
      expect(payment(d.world, row.id).status).toBe(status);
    }

    expect(outcomes).toEqual(['PAID: 400 400', 'PARTIALLY_REFUNDED: 400 400', 'REFUNDED: 400 400']);
  });

  it('the bodies of the four routes say what they take: the reference, the reason, the amount and the note', () => {
    const source = fs.readFileSync(path.join(__dirname, 'dto/payment.dto.ts'), 'utf8');
    const fieldsOf = (name: string) => {
      const start = source.indexOf(`export class ${name}`);

      return [...source.slice(start, source.indexOf('\n}', start)).matchAll(/^\s{2}(\w+)\??:/gm)].map((found) => found[1]);
    };

    expect(fieldsOf('ConfirmPaymentDto')).toEqual(['reference', 'adminNote']);
    expect(fieldsOf('FailPaymentDto')).toEqual(['reason', 'adminNote']);
    expect(fieldsOf('CancelPaymentDto')).toEqual(['reason', 'adminNote']);
    expect(fieldsOf('RefundPaymentDto')).toEqual(['amount', 'reason', 'adminNote']);

    const controller = fs.readFileSync(path.join(__dirname, 'payments.controller.ts'), 'utf8');

    for (const name of ['ConfirmPaymentDto', 'FailPaymentDto', 'CancelPaymentDto', 'RefundPaymentDto']) expect(controller).toContain(`dto: ${name}`);

    expect(controller).not.toContain('AdminPaymentActionDto');
  });
});

describe('paid counts and revenue follow the payments (P2-03)', () => {
  beforeEach(() => resetLocale());

  function otherJob(d: Desk, fields: Record<string, unknown>) {
    const job = d.world.memory.plant('intervention', { clientId: d.client.id, artisanId: d.artisan.id, status: 'COMPLETED', serviceType: 'PLOMBIER' });

    d.world.memory.plant('interventionFinancials', { interventionId: job.id, totalPrice: 100, platformCommission: 20, artisanPayout: 80, netRevenue: 20, companyMargin: 20 });
    d.world.memory.plant('payment', { interventionId: job.id, method: 'BANK_TRANSFER', currency: 'TND', createdById: d.client.id, amount: 100, amountRefunded: 0, ...fields });

    return job;
  }

  it('a job counts as paid when a payment of it was paid, or paid and partly given back: not when it is only finished or waiting', async () => {
    const d = desk();

    // 1: paid
    otherJob(d, { status: 'PAID' });
    // 2: paid and partly given back
    otherJob(d, { status: 'PARTIALLY_REFUNDED', amountRefunded: 30 });
    // 3 to 7: nothing was kept
    for (const status of ['REFUNDED', 'AWAITING_CONFIRMATION', 'PENDING', 'FAILED', 'CANCELLED']) otherJob(d, { status, amountRefunded: status === 'REFUNDED' ? 100 : 0 });

    // 8: financials, but no payment at all
    const bare = d.world.memory.plant('intervention', { clientId: d.client.id, artisanId: d.artisan.id, status: 'PAID', serviceType: 'PLOMBIER' });

    d.world.memory.plant('interventionFinancials', { interventionId: bare.id, totalPrice: 100, platformCommission: 20, artisanPayout: 80, netRevenue: 20, companyMargin: 20 });

    const dashboard: any = await d.world.svc.business.revenueDashboard(d.admin.id, 'ADMIN', {});

    expect(dashboard.totals.paidInterventionCount).toBe(2);
    expect(dashboard.totals.interventionCount).toBe(8);
  });

  it('the revenue of the month and of the day is what was kept: the refunds are taken off', async () => {
    const d = desk();

    d.world.memory.plant('payment', { interventionId: d.job.id, method: 'CASH', status: 'PAID', amount: 100, amountRefunded: 0, createdById: d.client.id });
    d.world.memory.plant('payment', { interventionId: d.job.id, method: 'CASH', status: 'PARTIALLY_REFUNDED', amount: 80, amountRefunded: 30, createdById: d.client.id });
    d.world.memory.plant('payment', { interventionId: d.job.id, method: 'CASH', status: 'REFUNDED', amount: 50, amountRefunded: 50, createdById: d.client.id });
    d.world.memory.plant('payment', { interventionId: d.job.id, method: 'CASH', status: 'AWAITING_CONFIRMATION', amount: 40, amountRefunded: 0, createdById: d.client.id });
    // marked as refunded in an older row that never wrote the amount: nothing was kept
    d.world.memory.plant('payment', { interventionId: d.job.id, method: 'CASH', status: 'REFUNDED', amount: 25, amountRefunded: 0, createdById: d.client.id });

    const kpis: any = await d.world.svc.admin.getDashboardKpis();

    expect([kpis.monthlyRevenue, kpis.todayRevenue]).toEqual([150, 150]);
  });

  it('the revenue of an artisan is what the customers kept of their jobs', async () => {
    const d = desk();
    const profile = rowsOf(d.world, 'artisanProfile').find((row) => row.userId === d.artisan.id)!;

    d.world.memory.plant('payment', { interventionId: d.job.id, method: 'CASH', status: 'PAID', amount: 100, amountRefunded: 0, createdById: d.client.id });
    d.world.memory.plant('payment', { interventionId: d.job.id, method: 'CASH', status: 'PARTIALLY_REFUNDED', amount: 80, amountRefunded: 30, createdById: d.client.id });
    d.world.memory.plant('payment', { interventionId: d.job.id, method: 'CASH', status: 'REFUNDED', amount: 50, amountRefunded: 50, createdById: d.client.id });
    d.world.memory.plant('payment', { interventionId: d.job.id, method: 'CASH', status: 'REFUNDED', amount: 25, amountRefunded: 0, createdById: d.client.id });

    const revenue: any = await d.world.svc.admin.getArtisanRevenue(profile.id);

    expect(revenue.totalRevenue).toBe(150);
  });
});

describe('what a person decided on a complaint stays, and the refund is read from the whole job (P2-03, after the review)', () => {
  beforeEach(() => resetLocale());

  const plantComplaint = (d: Desk, fields: Record<string, unknown>) => d.world.memory.plant('complaint', { interventionId: d.job.id, userId: d.client.id, title: 'Fuite', description: 'Toujours là', status: 'OPEN', ...fields });
  const complaintRow = (d: Desk, id: number) => rowsOf(d.world, 'complaint').find((row) => row.id === id)!;
  const earlier = new Date('2026-10-01T09:00:00.000Z');

  it('a complaint that was closed without a refund is not answered by a refund made later', async () => {
    const d = desk({ invoice: 120 });
    const id = await pay(d, 120);
    const closed = ['RESOLVED', 'REJECTED'].map((status) => plantComplaint(d, { refundDecision: 'PENDING', refundRequested: true, status }));
    const open = plantComplaint(d, { refundDecision: 'PENDING', refundRequested: true });

    await d.world.svc.payments.refund(id, d.admin.id, { amount: 20 });

    expect(closed.map((row) => [complaintRow(d, row.id).refundDecision, complaintRow(d, row.id).status, complaintRow(d, row.id).refundDecidedAt ?? null])).toEqual([['PENDING', 'RESOLVED', null], ['PENDING', 'REJECTED', null]]);
    expect([complaintRow(d, open.id).refundDecision, complaintRow(d, open.id).status]).toEqual(['PARTIAL_REFUND', 'REFUNDED']);
  });

  it('a refund approved for 50 stays approved, and waiting, until 50 have gone back; then it keeps who approved it and when', async () => {
    const d = desk({ invoice: 120 });
    const id = await pay(d, 120);
    const approved = plantComplaint(d, { refundDecision: 'APPROVED', refundApproved: true, refundAmount: 50, status: 'IN_REVIEW', refundDecidedById: d.accountant.id, refundDecidedAt: earlier });

    const first: any = await d.world.svc.payments.refund(id, d.admin.id, { amount: 20 });

    expect(num(first.amountRefunded)).toBe(20);
    expect([complaintRow(d, approved.id).refundDecision, num(complaintRow(d, approved.id).refundAmount), complaintRow(d, approved.id).status]).toEqual(['APPROVED', 50, 'IN_REVIEW']);
    expect(events(d).find((event) => event.title === 'Remboursement partiel enregistré')?.metadata).toMatchObject({ complaintsDecided: 0 });

    await d.world.svc.payments.refund(id, d.admin.id, { amount: 30 });

    const row = complaintRow(d, approved.id);

    expect([row.refundDecision, num(row.refundAmount), row.status, row.refundDecidedById, row.refundDecidedAt]).toEqual(['PARTIAL_REFUND', 50, 'IN_REVIEW', d.accountant.id, earlier]);
    expect(row.refundApproved).toBe(true);
  });

  it('a refund approved for an amount, when everything goes back, is a full one for the amount that went back', async () => {
    const d = desk({ invoice: 120 });
    const id = await pay(d, 120);
    const approved = plantComplaint(d, { refundDecision: 'APPROVED', refundApproved: true, refundAmount: 50, status: 'REFUNDED', refundDecidedById: d.accountant.id, refundDecidedAt: earlier });

    await d.world.svc.payments.refund(id, d.admin.id, {});

    const row = complaintRow(d, approved.id);

    expect([row.refundDecision, num(row.refundAmount), row.status, row.refundDecidedById]).toEqual(['REFUNDED', 120, 'REFUNDED', d.accountant.id]);
  });

  it('a refund approved with no amount is decided by the first refund', async () => {
    const d = desk({ invoice: 120 });
    const id = await pay(d, 120);
    const approved = plantComplaint(d, { refundDecision: 'APPROVED', refundApproved: true, status: 'IN_REVIEW' });

    await d.world.svc.payments.refund(id, d.admin.id, { amount: 10 });

    expect([complaintRow(d, approved.id).refundDecision, num(complaintRow(d, approved.id).refundAmount)]).toEqual(['PARTIAL_REFUND', 10]);
  });

  it('a refund of a payment in another currency decides nothing: there is no amount of the company to speak of', async () => {
    const d = desk({ invoice: 120 });
    const euros = plantPayment(d, { status: 'PAID', amount: 120, currency: 'EUR' });
    const waiting = plantComplaint(d, { refundDecision: 'PENDING', refundRequested: true });

    await d.world.svc.payments.refund(euros.id, d.admin.id, { amount: 20 });

    expect([payment(d.world, euros.id).status, complaintRow(d, waiting.id).refundDecision, complaintRow(d, waiting.id).status]).toEqual(['PARTIALLY_REFUNDED', 'PENDING', 'OPEN']);
  });

  it('a refusal written before the decision itself was: a later refund does not turn it into an approval; an approval of that time is one', async () => {
    const d = desk({ invoice: 120 });
    const id = await pay(d, 120);
    const refused = plantComplaint(d, { refundDecision: 'PENDING', refundRequested: true, refundApproved: false, refundDecidedById: d.accountant.id, refundDecidedAt: earlier, status: 'IN_REVIEW' });
    const approved = plantComplaint(d, { refundDecision: 'PENDING', refundRequested: true, refundApproved: true, refundAmount: 50, refundDecidedById: d.accountant.id, refundDecidedAt: earlier, status: 'REFUNDED' });

    await d.world.svc.payments.refund(id, d.admin.id, { amount: 20 });

    expect([complaintRow(d, refused.id).refundDecision, complaintRow(d, refused.id).refundApproved, complaintRow(d, refused.id).status]).toEqual(['PENDING', false, 'IN_REVIEW']);
    expect([complaintRow(d, approved.id).refundDecision, num(complaintRow(d, approved.id).refundAmount)]).toEqual(['PENDING', 50]);

    await d.world.svc.payments.refund(id, d.admin.id, { amount: 30 });

    expect([complaintRow(d, refused.id).refundDecision, complaintRow(d, refused.id).refundApproved]).toEqual(['PENDING', false]);
    expect([complaintRow(d, approved.id).refundDecision, num(complaintRow(d, approved.id).refundAmount), complaintRow(d, approved.id).refundDecidedById]).toEqual(['PARTIAL_REFUND', 50, d.accountant.id]);
  });

  it('a person who decides between the reading and the writing is not overwritten', async () => {
    const d = desk({ invoice: 120 });

    await pay(d, 120);

    const waiting = plantComplaint(d, { refundDecision: 'PENDING', refundRequested: true });
    const decidedMeanwhile = {
      complaint: {
        findMany: async (args: any) => {
          const found = await d.world.prisma.complaint.findMany(args);

          complaintRow(d, waiting.id).refundDecision = 'REJECTED';

          return found;
        },
        updateMany: (args: any) => d.world.prisma.complaint.updateMany(args),
      },
    };

    const decided = await settleComplaintRefund(decidedMeanwhile, d.job.id, { userId: d.admin.id }, { received: 120, refunded: 20, kept: 100 });

    expect(decided).toBe(0);
    expect([complaintRow(d, waiting.id).refundDecision, complaintRow(d, waiting.id).status]).toEqual(['REJECTED', 'OPEN']);
  });

  it('the refund decision of the back office is written in the complaint itself, with who decided', async () => {
    const d = desk({ invoice: 120 });
    const yes = plantComplaint(d, { refundDecision: 'PENDING', refundRequested: true });
    const no = plantComplaint(d, { refundDecision: 'PENDING', refundRequested: true });

    await d.world.svc.admin.decideRefund(d.admin.id, yes.id, { approved: true, amount: 40 } as any);
    await d.world.svc.admin.decideRefund(d.accountant.id, no.id, { approved: false } as any);

    expect([complaintRow(d, yes.id).refundDecision, complaintRow(d, yes.id).refundApproved, num(complaintRow(d, yes.id).refundAmount), complaintRow(d, yes.id).refundDecidedById]).toEqual(['APPROVED', true, 40, d.admin.id]);
    expect([complaintRow(d, no.id).refundDecision, complaintRow(d, no.id).refundApproved, complaintRow(d, no.id).refundAmount ?? null, complaintRow(d, no.id).refundDecidedById]).toEqual(['REJECTED', false, null, d.accountant.id]);
  });

  it('the refund that the back office approved is then made with the payment: the whole chain, with the amounts agreeing', async () => {
    const d = desk({ invoice: 120 });
    const id = await pay(d, 120);
    const asked = plantComplaint(d, { refundDecision: 'PENDING', refundRequested: true });

    await d.world.svc.admin.decideRefund(d.admin.id, asked.id, { approved: true, amount: 40 } as any);
    await d.world.svc.payments.refund(id, d.admin.id, { amount: 40 });

    expect([complaintRow(d, asked.id).refundDecision, num(complaintRow(d, asked.id).refundAmount)]).toEqual(['PARTIAL_REFUND', 40]);
    expect(num(financialsOf(d)[0].refundAmount)).toBe(40);
    expect(payment(d.world, id).status).toBe('PARTIALLY_REFUNDED');
  });

  it('a refund refused and then asked for again starts from nothing: the refund that follows settles it', async () => {
    const d = desk({ invoice: 120 });
    const id = await pay(d, 120);
    const asked = plantComplaint(d, { refundDecision: 'PENDING', refundRequested: true });

    await d.world.svc.admin.decideRefund(d.admin.id, asked.id, { approved: false } as any);
    expect([complaintRow(d, asked.id).refundDecision, complaintRow(d, asked.id).refundApproved]).toEqual(['REJECTED', false]);

    await d.world.svc.complaints.adminDecision(d.admin.id, 'ADMIN' as any, asked.id, { decision: 'FULL_REFUND' } as any);

    const again = complaintRow(d, asked.id);

    expect([again.refundDecision, again.refundApproved, again.refundDecidedById ?? null, again.refundDecidedAt ?? null, again.status]).toEqual(['PENDING', false, null, null, 'IN_REVIEW']);

    await d.world.svc.payments.refund(id, d.admin.id, { amount: 120 });

    const settled = complaintRow(d, asked.id);

    expect([settled.refundDecision, settled.refundApproved, num(settled.refundAmount), settled.status, settled.refundDecidedById]).toEqual(['REFUNDED', true, 120, 'REFUNDED', d.admin.id]);
  });

  it('a refund approved and then asked for again is no longer approved for the old amount', async () => {
    const d = desk({ invoice: 120 });
    const id = await pay(d, 120);
    const asked = plantComplaint(d, { refundDecision: 'PENDING', refundRequested: true });

    await d.world.svc.admin.decideRefund(d.admin.id, asked.id, { approved: true, amount: 100 } as any);
    await d.world.svc.complaints.adminDecision(d.admin.id, 'ADMIN' as any, asked.id, { decision: 'PARTIAL_REFUND' } as any);

    // the answer given to the first request is void: no approval, no amount, nobody who decided
    const again = complaintRow(d, asked.id);

    expect([again.refundDecision, again.refundApproved, again.refundAmount ?? null, again.refundDecidedById ?? null, again.refundDecidedAt ?? null]).toEqual(['PENDING', false, null, null, null]);

    await d.world.svc.payments.refund(id, d.admin.id, { amount: 30 });

    // nobody approved an amount for the new request: what went back is the answer
    expect([complaintRow(d, asked.id).refundDecision, num(complaintRow(d, asked.id).refundAmount)]).toEqual(['PARTIAL_REFUND', 30]);
  });

  it('a refund that was made settles the complaint for good: the back office cannot refuse or approve another amount afterwards', async () => {
    const d = desk({ invoice: 120 });
    const id = await pay(d, 120);
    const asked = plantComplaint(d, { refundDecision: 'PENDING', refundRequested: true });

    await d.world.svc.payments.refund(id, d.admin.id, { amount: 120 });
    expect(complaintRow(d, asked.id).refundDecision).toBe('REFUNDED');

    const refused = await refusal(() => d.world.svc.admin.decideRefund(d.admin.id, asked.id, { approved: false } as any));
    const changed = await refusal(() => d.world.svc.admin.decideRefund(d.admin.id, asked.id, { approved: true, amount: 10 } as any));

    // (even an amount above what was received is answered that the refund is made: the complaint is looked at first)
    const above = await refusal(() => d.world.svc.admin.decideRefund(d.admin.id, asked.id, { approved: true, amount: 5000 } as any));

    expect(refused).toEqual({ status: 409, message: 'Le remboursement de cette réclamation est déjà effectué.' });
    expect(changed).toEqual({ status: 409, message: 'Le remboursement de cette réclamation est déjà effectué.' });
    expect(above).toEqual({ status: 409, message: 'Le remboursement de cette réclamation est déjà effectué.' });
    expect([complaintRow(d, asked.id).refundDecision, complaintRow(d, asked.id).refundApproved, num(complaintRow(d, asked.id).refundAmount), complaintRow(d, asked.id).status]).toEqual(['REFUNDED', true, 120, 'REFUNDED']);
    expect(events(d).filter((row) => row.title === 'Décision remboursement').length).toBe(0);

    // a partly refunded complaint is just as settled
    const partly = plantComplaint(d, { refundDecision: 'PARTIAL_REFUND', refundApproved: true, refundAmount: 40, status: 'REFUNDED' });

    expect((await refusal(() => d.world.svc.admin.decideRefund(d.admin.id, partly.id, { approved: false } as any)))?.status).toBe(409);
    expect(complaintRow(d, partly.id).refundDecision).toBe('PARTIAL_REFUND');
  });

  it('a refund approved for more than was received is refused: it could never be paid back', async () => {
    const d = desk({ invoice: 120 });

    await pay(d, 120);

    const asked = plantComplaint(d, { refundDecision: 'PENDING', refundRequested: true });
    const over = await refusal(() => d.world.svc.admin.decideRefund(d.admin.id, asked.id, { approved: true, amount: 120.5 } as any));

    expect(over?.status).toBe(400);
    expect(over?.message.includes('dépasse ce qui a été encaissé sur cette mission (120')).toBe(true);
    expect(complaintRow(d, asked.id).refundDecision).toBe('PENDING');

    // the whole of what was received is allowed, and so is a refusal with an amount above it
    await d.world.svc.admin.decideRefund(d.admin.id, asked.id, { approved: true, amount: 120 } as any);
    expect([complaintRow(d, asked.id).refundDecision, num(complaintRow(d, asked.id).refundAmount)]).toEqual(['APPROVED', 120]);

    const no = plantComplaint(d, { refundDecision: 'PENDING', refundRequested: true });

    await d.world.svc.admin.decideRefund(d.admin.id, no.id, { approved: false, amount: 999 } as any);
    expect(complaintRow(d, no.id).refundDecision).toBe('REJECTED');
  });

  it('an approval with no payment received yet is not limited (nothing says how much there will be), and one with no amount is not either', async () => {
    const d = desk({ invoice: 120 });
    const asked = plantComplaint(d, { refundDecision: 'PENDING', refundRequested: true });
    const other = plantComplaint(d, { refundDecision: 'PENDING', refundRequested: true });

    await d.world.svc.admin.decideRefund(d.admin.id, asked.id, { approved: true, amount: 500 } as any);
    expect(complaintRow(d, asked.id).refundDecision).toBe('APPROVED');

    await pay(d, 120);
    await d.world.svc.admin.decideRefund(d.admin.id, other.id, { approved: true } as any);
    expect(complaintRow(d, other.id).refundDecision).toBe('APPROVED');
  });

  it('a decision on a refund waits for the refund that is being made on the job, and is turned away once the refund has settled the complaint', async () => {
    const d = desk({ invoice: 120 });
    const id = await pay(d, 120);
    const asked = plantComplaint(d, { refundDecision: 'PENDING', refundRequested: true });

    const { answer, seen } = await whileHolding(
      d.world,
      (tx) => lockJob(tx, d.job.id),
      () => d.world.svc.admin.decideRefund(d.admin.id, asked.id, { approved: true, amount: 50 } as any),
      () => complaintRow(d, asked.id).refundDecision,
      // the refund that holds the lock gives the whole payment back and settles the complaint, as a refund does
      async (tx) => {
        await tx.payment.update({ where: { id }, data: { status: 'REFUNDED', amountRefunded: 120 } });
        await settleComplaintRefund(tx, d.job.id, { userId: d.admin.id }, { received: 120, refunded: 120, kept: 0 });
      },
    );

    // while the refund holds the job, the decision waits: nothing is written
    expect(seen).toBe('PENDING');
    expect(answer).toEqual({ status: 409, message: 'Le remboursement de cette réclamation est déjà effectué.' });
    expect([complaintRow(d, asked.id).refundDecision, complaintRow(d, asked.id).refundApproved, num(complaintRow(d, asked.id).refundAmount)]).toEqual(['REFUNDED', true, 120]);
  });

  it('money that already went back is the answer to an approval: the complaint is settled at once, and no other complaint of the job is', async () => {
    const d = desk({ invoice: 120 });
    const id = await pay(d, 120);

    await d.world.svc.payments.refund(id, d.admin.id, { amount: 60 });

    const asked = plantComplaint(d, { refundDecision: 'PENDING', refundRequested: true });
    const other = plantComplaint(d, { refundDecision: 'PENDING', refundRequested: true });

    await d.world.svc.admin.decideRefund(d.admin.id, asked.id, { approved: true, amount: 50 } as any);

    const settled = complaintRow(d, asked.id);

    expect([settled.refundDecision, settled.refundApproved, num(settled.refundAmount), settled.refundDecidedById, settled.status]).toEqual(['PARTIAL_REFUND', true, 60, d.admin.id, 'REFUNDED']);
    expect([complaintRow(d, other.id).refundDecision, complaintRow(d, other.id).status]).toEqual(['PENDING', 'OPEN']);
  });

  it('an approval for more than has gone back so far waits for the rest; an approval with no amount while nothing went back waits for the refund', async () => {
    const d = desk({ invoice: 120 });
    const id = await pay(d, 120);
    const open = plantComplaint(d, { refundDecision: 'PENDING', refundRequested: true });

    await d.world.svc.admin.decideRefund(d.admin.id, open.id, { approved: true } as any);
    expect(complaintRow(d, open.id).refundDecision).toBe('APPROVED');

    await d.world.svc.payments.refund(id, d.admin.id, { amount: 60 });
    expect([complaintRow(d, open.id).refundDecision, num(complaintRow(d, open.id).refundAmount)]).toEqual(['PARTIAL_REFUND', 60]);

    // a complaint that asks for a refund after that, and is approved for 100 when 60 went back, waits for the 40 that are missing
    const big = plantComplaint(d, { refundDecision: 'PENDING', refundRequested: true });

    await d.world.svc.admin.decideRefund(d.admin.id, big.id, { approved: true, amount: 100 } as any);
    expect([complaintRow(d, big.id).refundDecision, num(complaintRow(d, big.id).refundAmount)]).toEqual(['APPROVED', 100]);

    await d.world.svc.payments.refund(id, d.admin.id, { amount: 40 });
    expect([complaintRow(d, big.id).refundDecision, num(complaintRow(d, big.id).refundAmount)]).toEqual(['PARTIAL_REFUND', 100]);
  });

  it('a refund that was made is not asked for again from the decision of the complaint; a decision that asks for none leaves what the complaint says about the refund', async () => {
    const d = desk({ invoice: 120 });
    const id = await pay(d, 120);
    const asked = plantComplaint(d, { refundDecision: 'PENDING', refundRequested: true });

    await d.world.svc.payments.refund(id, d.admin.id, { amount: 120 });

    const again = await refusal(() => d.world.svc.complaints.adminDecision(d.admin.id, 'ADMIN' as any, asked.id, { decision: 'FULL_REFUND' } as any));

    expect(again).toEqual({ status: 409, message: 'Le remboursement de cette réclamation est déjà effectué.' });
    expect([complaintRow(d, asked.id).refundDecision, complaintRow(d, asked.id).refundApproved, num(complaintRow(d, asked.id).refundAmount), complaintRow(d, asked.id).status]).toEqual(['REFUNDED', true, 120, 'REFUNDED']);

    await d.world.svc.complaints.adminDecision(d.admin.id, 'ADMIN' as any, asked.id, { decision: 'CLIENT_FAVOR', note: 'Le client avait raison' } as any);

    const closed = complaintRow(d, asked.id);

    expect([closed.adminDecision, closed.refundDecision, closed.refundApproved, num(closed.refundAmount), closed.refundDecidedById, closed.status]).toEqual(['CLIENT_FAVOR', 'REFUNDED', true, 120, d.admin.id, 'RESOLVED']);
  });

  it('a decision of the complaint that loses to a refund made in between is turned away and writes nothing', async () => {
    const d = desk({ invoice: 120 });
    const asked = plantComplaint(d, { refundDecision: 'PENDING', refundRequested: true });
    const service = d.world.svc.complaints as any;
    const real = service.prisma;

    // the refund settles the complaint after the decision was read, before it is written
    service.prisma = new Proxy(real, {
      get: (target, key) =>
        key === 'complaint'
          ? {
              findUnique: (args: any) => target.complaint.findUnique(args),
              updateMany: async (args: any) => {
                complaintRow(d, asked.id).refundDecision = 'REFUNDED';
                complaintRow(d, asked.id).refundApproved = true;

                return target.complaint.updateMany(args);
              },
            }
          : Reflect.get(target, key),
    });

    const late = await refusal(() => service.adminDecision(d.admin.id, 'ADMIN', asked.id, { decision: 'NO_REFUND' }));

    service.prisma = real;
    expect(late).toEqual({ status: 409, message: 'Le remboursement de cette réclamation est déjà effectué.' });
    expect([complaintRow(d, asked.id).refundDecision, complaintRow(d, asked.id).adminDecision ?? null, complaintRow(d, asked.id).status]).toEqual(['REFUNDED', null, 'OPEN']);
  });

  it('a refund decision that loses to a decision written without the lock of the job is turned away and writes nothing', async () => {
    const d = desk({ invoice: 120 });
    const asked = plantComplaint(d, { refundDecision: 'PENDING', refundRequested: true });
    const admin = d.world.svc.admin as any;
    const real = admin.prisma;

    // the complaint is settled by someone else after the decision was read, before it is written
    admin.prisma = new Proxy(real, {
      get: (target, key) =>
        key === '$transaction'
          ? (work: (tx: any) => Promise<unknown>) =>
              target.$transaction((tx: any) =>
                work(
                  new Proxy(tx, {
                    get: (inner, name) =>
                      name === 'complaint'
                        ? {
                            findUnique: (args: any) => inner.complaint.findUnique(args),
                            updateMany: async (args: any) => {
                              complaintRow(d, asked.id).refundDecision = 'PARTIAL_REFUND';
                              complaintRow(d, asked.id).refundApproved = true;

                              return inner.complaint.updateMany(args);
                            },
                          }
                        : Reflect.get(inner, name),
                  }),
                ),
              )
          : Reflect.get(target, key),
    });

    const late = await refusal(() => admin.decideRefund(d.admin.id, asked.id, { approved: false }));

    admin.prisma = real;
    expect(late).toEqual({ status: 409, message: 'Le remboursement de cette réclamation est déjà effectué.' });
    expect([complaintRow(d, asked.id).refundDecision, complaintRow(d, asked.id).refundApproved, complaintRow(d, asked.id).status]).toEqual(['PARTIAL_REFUND', true, 'OPEN']);
    expect(events(d).filter((row) => row.title === 'Décision remboursement').length).toBe(0);
  });

  it('a decision with no refund after a refund was approved voids the approval: nothing is approved, nothing is shown to the customer', async () => {
    const d = desk({ invoice: 120 });
    const asked = plantComplaint(d, { refundDecision: 'PENDING', refundRequested: true });

    await d.world.svc.admin.decideRefund(d.admin.id, asked.id, { approved: true, amount: 80 } as any);
    await d.world.svc.complaints.adminDecision(d.admin.id, 'ADMIN' as any, asked.id, { decision: 'NO_REFUND' } as any);

    const row = complaintRow(d, asked.id);

    expect([row.refundRequested, row.refundDecision, row.refundApproved, row.refundAmount ?? null, row.refundDecidedById ?? null, row.refundDecidedAt ?? null, row.status]).toEqual([false, 'NOT_REQUESTED', false, null, null, null, 'RESOLVED']);
  });

  it('putting a refund back to pending decides nothing: no person and no date, so the refund that follows settles it', async () => {
    const d = desk({ invoice: 120 });
    const id = await pay(d, 120);
    const asked = plantComplaint(d, { refundDecision: 'PENDING', refundRequested: true });

    await d.world.svc.complaints.refundDecision(d.admin.id, 'ADMIN' as any, asked.id, { decision: 'REJECTED' } as any);
    expect([complaintRow(d, asked.id).refundDecision, complaintRow(d, asked.id).refundDecidedById, complaintRow(d, asked.id).refundDecidedAt instanceof Date]).toEqual(['REJECTED', d.admin.id, true]);

    await d.world.svc.complaints.refundDecision(d.admin.id, 'ADMIN' as any, asked.id, { decision: 'PENDING' } as any);
    expect([complaintRow(d, asked.id).refundDecision, complaintRow(d, asked.id).refundApproved, complaintRow(d, asked.id).refundDecidedById ?? null, complaintRow(d, asked.id).refundDecidedAt ?? null]).toEqual(['PENDING', false, null, null]);

    await d.world.svc.payments.refund(id, d.admin.id, { amount: 120 });
    expect([complaintRow(d, asked.id).refundDecision, complaintRow(d, asked.id).status]).toEqual(['REFUNDED', 'REFUNDED']);
  });
});

describe('asking again carries what is new, and a payment cannot go over what is left to pay (P2-03, after the review)', () => {
  beforeEach(() => resetLocale());

  const ask = (d: Desk, dto: Record<string, unknown>) => d.world.svc.payments.createClientPaymentRequest(d.client.id, d.job.id, dto as any);
  const askAsAdmin = (d: Desk, dto: Record<string, unknown>) => d.world.svc.payments.createAdminManualPayment(d.admin.id, d.job.id, dto as any);
  const askAsVisitor = (d: Desk, dto: Record<string, unknown>) => d.world.svc.guest.createGuestPayment(d.job.id, d.token, dto as any);

  it('the customer who sends the reference of the transfer afterwards: the open payment keeps it; an empty field does not wipe it', async () => {
    const d = desk();
    const first: any = await ask(d, { method: 'BANK_TRANSFER' });

    expect([payment(d.world, first.id).reference ?? null, payment(d.world, first.id).clientNote ?? null]).toEqual([null, null]);

    const again: any = await ask(d, { method: 'BANK_TRANSFER', reference: 'VIR-77', clientNote: 'Fait ce matin' });

    expect([again.replayed, again.id]).toEqual([true, first.id]);
    expect([payment(d.world, first.id).reference, payment(d.world, first.id).clientNote]).toEqual(['VIR-77', 'Fait ce matin']);

    await ask(d, { method: 'BANK_TRANSFER' });
    await ask(d, { method: 'BANK_TRANSFER', reference: '   ', clientNote: '' });
    expect([payment(d.world, first.id).reference, payment(d.world, first.id).clientNote]).toEqual(['VIR-77', 'Fait ce matin']);

    await ask(d, { method: 'BANK_TRANSFER', reference: 'VIR-78' });
    expect([payment(d.world, first.id).reference, payment(d.world, first.id).clientNote]).toEqual(['VIR-78', 'Fait ce matin']);
    expect(rowsOf(d.world, 'payment').length).toBe(1);
    expect(events(d, 'PAYMENT_PENDING').length).toBe(1);
  });

  it('the visitor with the link keeps the reference sent with the second request', async () => {
    const d = desk();
    const first: any = await askAsVisitor(d, { method: 'BANK_TRANSFER' });
    const second: any = await askAsVisitor(d, { method: 'BANK_TRANSFER', reference: 'VIR-9', clientNote: 'Merci' });

    expect(second.replayed).toBe(true);
    expect(second.payment.id).toBe(first.payment.id);
    expect([payment(d.world, first.payment.id).reference, payment(d.world, first.payment.id).clientNote]).toEqual(['VIR-9', 'Merci']);

    await askAsVisitor(d, { method: 'BANK_TRANSFER' });
    expect(payment(d.world, first.payment.id).reference).toBe('VIR-9');
  });

  it('the back office that asks again with a reference or a note keeps them on the open payment', async () => {
    const d = desk();
    const first = await askAsAdmin(d, { method: 'BANK_TRANSFER', amount: 80 });

    await askAsAdmin(d, { method: 'BANK_TRANSFER', amount: 80, reference: 'VIR-5', adminNote: 'Reçu par mail', clientNote: 'Client prévenu' });

    expect([payment(d.world, first.id).reference, payment(d.world, first.id).adminNote, payment(d.world, first.id).clientNote]).toEqual(['VIR-5', 'Reçu par mail', 'Client prévenu']);
    expect(rowsOf(d.world, 'payment').length).toBe(1);
  });

  it('a card request from a visitor waits for a provider like an online one, and a cash request replaces it', async () => {
    const d = desk();
    const card: any = await askAsVisitor(d, { method: 'ONLINE_CARD' });

    expect(payment(d.world, card.payment.id).status).toBe('PENDING');
    expect(card.instructions).toBe('Paiement en ligne non connecté pour le moment. Cette demande reste en attente.');
    expect(events(d, 'PAYMENT_PENDING')[0].message).toBe('Demande de paiement en ligne créée. Aucun prestataire externe n’est encore connecté.');

    const online: any = desk();
    const plain: any = await askAsVisitor(online, { method: 'ONLINE' });

    expect(payment(online.world, plain.payment.id).status).toBe('PENDING');

    const cash: any = await askAsVisitor(d, { method: 'CASH' });

    expect(payment(d.world, card.payment.id).status).toBe('CANCELLED');
    expect(payment(d.world, cash.payment.id).status).toBe('AWAITING_CONFIRMATION');
    expect(cash.instructions).toBe('Paiement en espèces à confirmer par l’administration.');
  });

  it('a transfer that would take the payments over what is left to pay is refused when it is confirmed, and nothing is written', async () => {
    const d = desk();

    plantPayment(d, { method: 'CASH', status: 'PAID', amount: 120 });

    // a transfer that failed, and that the back office would now confirm after all, when the cash has paid everything
    const failed = plantPayment(d, { status: 'FAILED', amount: 120 });
    const before = rowsOf(d.world, 'interventionFinancials').length;
    const refused = await refusal(() => d.world.svc.payments.confirm(failed.id, d.admin.id, {}));

    expect(refused).toEqual({ status: 409, message: 'Ce paiement dépasse ce qu’il reste à payer sur cette mission.' });
    expect(payment(d.world, failed.id).status).toBe('FAILED');
    expect(rowsOf(d.world, 'interventionFinancials').length).toBe(before);
    expect(events(d, 'PAYMENT_CONFIRMED').length).toBe(0);
  });

  it('what is left is what the document asks for less what is kept: a second transfer above it is refused, one within it is confirmed', async () => {
    const d = desk({ invoice: 120 });

    plantPayment(d, { status: 'PAID', amount: 100 });

    const above = plantPayment(d, { amount: 50 });
    const within = plantPayment(d, { amount: 20 });

    expect((await refusal(() => d.world.svc.payments.confirm(above.id, d.admin.id, {})))?.status).toBe(409);
    expect(payment(d.world, above.id).status).toBe('AWAITING_CONFIRMATION');
    expect(await refusal(() => d.world.svc.payments.confirm(within.id, d.admin.id, {}))).toBe(null);
    expect(payment(d.world, within.id).status).toBe('PAID');
  });

  it('money that went back makes room again: the transfer for what was refunded is confirmed', async () => {
    const d = desk();

    plantPayment(d, { status: 'PARTIALLY_REFUNDED', amount: 120, amountRefunded: 50 });

    const again = plantPayment(d, { amount: 50 });
    const tooMuch = plantPayment(d, { amount: 51 });

    expect(await refusal(() => d.world.svc.payments.confirm(again.id, d.admin.id, {}))).toBe(null);
    expect((await refusal(() => d.world.svc.payments.confirm(tooMuch.id, d.admin.id, {})))?.status).toBe(409);
  });

  it('the check is left out when there is nothing to compare with (no document, another currency); cash has its own rule', async () => {
    const noDocument = desk({ quote: null });

    plantPayment(noDocument, { status: 'PAID', amount: 500 });

    const free = plantPayment(noDocument, { amount: 900 });

    expect(await refusal(() => noDocument.world.svc.payments.confirm(free.id, noDocument.admin.id, {}))).toBe(null);

    const foreign = desk();

    plantPayment(foreign, { status: 'PAID', amount: 120 });

    const euros = plantPayment(foreign, { amount: 50, currency: 'EUR' });

    expect(await refusal(() => foreign.world.svc.payments.confirm(euros.id, foreign.admin.id, {}))).toBe(null);

    const cash = desk();

    plantPayment(cash, { status: 'PAID', amount: 120 });

    // the document is in another currency: its amount cannot be set against payments in the currency of the company
    const foreignDocument = desk({ quote: 100 });

    rowsOf(foreignDocument.world, 'quote')[0].currency = 'EUR';
    plantPayment(foreignDocument, { status: 'PAID', amount: 100 });

    const more = plantPayment(foreignDocument, { amount: 50 });

    expect(await refusal(() => foreignDocument.world.svc.payments.confirm(more.id, foreignDocument.admin.id, {}))).toBe(null);

    // cash has its own rule, with its own words (the one of the cash ledger): this check does not answer for it
    const handed = plantPayment(cash, { method: 'CASH', amount: 30 });

    expect(await refusal(() => cash.world.svc.payments.confirm(handed.id, cash.admin.id, {}))).toEqual({ status: 409, message: 'Ce paiement en espèces dépasse ce qu’il reste à payer sur cette mission.' });
  });

  it('a transfer above what is left is refused even when it waited for the job and the cash came first', async () => {
    const d = desk();
    const transfer = plantPayment(d, { amount: 120 });
    const { answer } = await whileHolding(
      d.world,
      (tx) => lockJob(tx, d.job.id),
      () => d.world.svc.payments.confirm(transfer.id, d.admin.id, {}),
      () => payment(d.world, transfer.id).status,
      async (tx) => {
        await tx.payment.create({ data: { interventionId: d.job.id, method: 'CASH', provider: 'MANUAL', status: 'PAID', amount: 120, amountRefunded: 0, currency: 'TND', createdById: d.client.id } });
      },
    );

    expect(answer?.status).toBe(409);
    expect(payment(d.world, transfer.id).status).toBe('AWAITING_CONFIRMATION');
  });

  it('cash is not compared with a document in another currency, with or without an artisan on the job', async () => {
    for (const artisan of [false, true]) {
      const d = desk({ quote: null, artisan });

      d.world.memory.plant('quote', { interventionId: d.job.id, createdById: d.artisan.id, status: 'ACCEPTED', amountHT: 100, taxAmount: 0, amountTTC: 100, currency: 'EUR' });

      const cash = plantPayment(d, { method: 'CASH', amount: 150 });

      await d.world.svc.payments.confirm(cash.id, d.admin.id, {});
      expect(payment(d.world, cash.id).status).toBe('PAID');
    }
  });

  it('cash confirmed on a job nobody took is not confirmed above what is left to pay; money in another currency is not compared', async () => {
    const d = desk({ artisan: false });
    const first = plantPayment(d, { method: 'CASH', amount: 100 });
    const over = plantPayment(d, { method: 'CASH', amount: 30 });
    const foreign = plantPayment(d, { method: 'CASH', amount: 500, currency: 'EUR' });

    await d.world.svc.payments.confirm(first.id, d.admin.id, {});

    const refused = await refusal(() => d.world.svc.payments.confirm(over.id, d.admin.id, {}));

    expect(refused).toEqual({ status: 409, message: 'Ce paiement en espèces dépasse ce qu’il reste à payer sur cette mission.' });
    expect(payment(d.world, over.id).status).toBe('AWAITING_CONFIRMATION');

    await d.world.svc.payments.confirm(foreign.id, d.admin.id, {});
    expect(payment(d.world, foreign.id).status).toBe('PAID');

    // exactly what is left is allowed
    const exact = plantPayment(d, { method: 'CASH', amount: 20 });

    await d.world.svc.payments.confirm(exact.id, d.admin.id, {});
    expect(payment(d.world, exact.id).status).toBe('PAID');
    expect(rowsOf(d.world, 'cashLedgerEntry').length).toBe(0);
  });
});

describe('failing a payment twice, and a payment that was cancelled (P2-03, after the review)', () => {
  beforeEach(() => resetLocale());

  it('a second click on a payment that failed answers with it as it is: the first reason, no second line on the timeline', async () => {
    const d = desk();
    const waiting = plantPayment(d);

    await d.world.svc.payments.fail(waiting.id, d.admin.id, { reason: 'Virement non reçu' });

    const failedAt = payment(d.world, waiting.id).failedAt;
    const second: any = await d.world.svc.payments.fail(waiting.id, d.admin.id, { reason: 'Autre raison', adminNote: 'Autre note' });

    expect(second.status).toBe('FAILED');
    expect([payment(d.world, waiting.id).failureReason, payment(d.world, waiting.id).failedAt, payment(d.world, waiting.id).adminNote ?? null]).toEqual(['Virement non reçu', failedAt, null]);
    expect(events(d).filter((event) => event.title === 'Paiement échoué').length).toBe(1);
  });

  it('two clicks at the same moment fail it once', async () => {
    const d = desk();
    const waiting = plantPayment(d);
    const both = await Promise.all([refusal(() => d.world.svc.payments.fail(waiting.id, d.admin.id, { reason: 'A' })), refusal(() => d.world.svc.payments.fail(waiting.id, d.admin.id, { reason: 'B' }))]);

    expect(both).toEqual([null, null]);
    expect(events(d).filter((event) => event.title === 'Paiement échoué').length).toBe(1);
    expect(['A', 'B']).toContain(payment(d.world, waiting.id).failureReason);
  });

  it('a payment that was cancelled cannot be marked as failed: it would be one that can be confirmed again', async () => {
    const d = desk();
    const waiting = plantPayment(d);

    await d.world.svc.payments.cancel(waiting.id, d.admin.id, { reason: 'Doublon' });

    expect(await refusal(() => d.world.svc.payments.fail(waiting.id, d.admin.id, {}))).toEqual({ status: 400, message: 'Un paiement annulé ne peut pas être marqué comme échoué.' });
    expect([payment(d.world, waiting.id).status, payment(d.world, waiting.id).cancelReason]).toEqual(['CANCELLED', 'Doublon']);
  });

  it('a click on fail that waited for the job and found the payment cancelled meanwhile is turned away', async () => {
    const d = desk();
    const waiting = plantPayment(d);
    const { answer } = await whileHolding(
      d.world,
      (tx) => lockJob(tx, d.job.id),
      () => d.world.svc.payments.fail(waiting.id, d.admin.id, {}),
      () => payment(d.world, waiting.id).status,
      async (tx) => {
        await tx.payment.update({ where: { id: waiting.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
      },
    );

    expect(answer).toEqual({ status: 400, message: 'Un paiement annulé ne peut pas être marqué comme échoué.' });
    expect(payment(d.world, waiting.id).status).toBe('CANCELLED');
    expect(events(d).filter((event) => event.title === 'Paiement échoué').length).toBe(0);
  });

  it('a click on fail that waited for the job and found the payment failed meanwhile answers with it, and writes nothing more', async () => {
    const d = desk();
    const waiting = plantPayment(d);
    const { answer } = await whileHolding(
      d.world,
      (tx) => lockJob(tx, d.job.id),
      () => d.world.svc.payments.fail(waiting.id, d.admin.id, { reason: 'Second' }),
      () => payment(d.world, waiting.id).status,
      async (tx) => {
        await tx.payment.update({ where: { id: waiting.id }, data: { status: 'FAILED', failedAt: new Date(), failureReason: 'Premier' } });
      },
    );

    expect(answer).toBe(null);
    expect(payment(d.world, waiting.id).failureReason).toBe('Premier');
    expect(events(d).filter((event) => event.title === 'Paiement échoué').length).toBe(0);
  });

  it('an invoice that was cancelled stays cancelled when a payment linked to it is confirmed', async () => {
    const d = desk({ invoice: 120 });

    rowsOf(d.world, 'invoice')[0].status = 'CANCELLED';

    const linked = plantPayment(d, { invoiceId: d.invoice!.id, amount: 120 });

    await d.world.svc.payments.confirm(linked.id, d.admin.id, {});

    expect(payment(d.world, linked.id).status).toBe('PAID');
    expect(rowsOf(d.world, 'invoice')[0].status).toBe('CANCELLED');
    expect(jobRow(d).status).toBe('PAID');
  });
});

describe('an invoice made after a payment is paid when the payments cover it (P2-03, after the review)', () => {
  beforeEach(() => resetLocale());

  const invoiceOf = (d: Desk) => rowsOf(d.world, 'invoice').filter((row) => row.interventionId === d.job.id);

  it('the financials follow the invoice that is made after the payment: 120 received on a quote, then an invoice of 100', async () => {
    const d = desk();

    await pay(d, 120);
    expect(num(financialsOf(d)[0].totalPrice)).toBe(120);

    await d.world.svc.invoices.createForIntervention(d.job.id, d.admin.id, { amountHT: 100, taxRate: 0 } as any);

    const [f] = financialsOf(d);

    // the price is what the invoice asks for; the 20 above it is an overpayment, not income
    expect([num(f.totalPrice), num(f.platformCommission) + num(f.artisanPayout)]).toEqual([100, 100]);
    expect(num(f.refundAmount)).toBe(0);

    // a refund of that overpayment gives back what was never owed: the platform bears nothing
    await d.world.svc.payments.refund((rowsOf(d.world, 'payment')[0] as any).id, d.admin.id, { amount: 20 });
    expect(num(financialsOf(d)[0].netRevenue)).toBe(num(f.platformCommission));
  });

  it('an invoice made after a payout was paid leaves the figures that the payout took; while the payout is not paid they follow the invoice', async () => {
    const d = desk();

    await pay(d, 120);

    const [before] = financialsOf(d);
    const payout = d.world.memory.plant('artisanPayout', { artisanId: d.artisan.id, status: 'PAID', periodStart: new Date('2026-10-01T00:00:00.000Z'), periodEnd: new Date('2026-10-31T00:00:00.000Z') });

    d.world.memory.plant('artisanPayoutItem', { payoutId: payout.id, financialId: before.id, interventionId: d.job.id, amount: num(before.artisanPayout) });

    await d.world.svc.invoices.createForIntervention(d.job.id, d.admin.id, { amountHT: 100, taxRate: 0 } as any);

    // the share the artisan was paid is the share of the financials still
    expect([num(financialsOf(d)[0].totalPrice), num(financialsOf(d)[0].artisanPayout)]).toEqual([120, num(before.artisanPayout)]);

    const other = desk();

    await pay(other, 120);

    const waiting = other.world.memory.plant('artisanPayout', { artisanId: other.artisan.id, status: 'READY', periodStart: new Date('2026-10-01T00:00:00.000Z'), periodEnd: new Date('2026-10-31T00:00:00.000Z') });

    other.world.memory.plant('artisanPayoutItem', { payoutId: waiting.id, financialId: financialsOf(other)[0].id, interventionId: other.job.id, amount: 96 });
    await other.world.svc.invoices.createForIntervention(other.job.id, other.admin.id, { amountHT: 100, taxRate: 0 } as any);
    expect(num(financialsOf(other)[0].totalPrice)).toBe(100);
  });

  it('an invoice made while nothing was received yet leaves no financials', async () => {
    const d = desk();

    await d.world.svc.invoices.createForIntervention(d.job.id, d.admin.id, { amountHT: 100, taxRate: 0 } as any);
    expect(financialsOf(d).length).toBe(0);
  });

  it('a deposit does not pay the invoice that is made afterwards; the payment is linked to it all the same', async () => {
    const d = desk();
    const deposit = plantPayment(d, { status: 'PAID', amount: 40 });

    await d.world.svc.invoices.createForIntervention(d.job.id, d.admin.id, {} as any);

    const [invoice] = invoiceOf(d);

    expect([invoice.status, invoice.paymentStatus, invoice.paidAt ?? null]).toEqual(['ISSUED', 'PENDING', null]);
    expect(payment(d.world, deposit.id).invoiceId).toBe(invoice.id);

    // the payment that completes it pays it
    const rest = plantPayment(d, { amount: 80 });

    await d.world.svc.payments.confirm(rest.id, d.admin.id, {});
    expect(invoiceOf(d)[0].status).toBe('PAID');
  });

  it('a payment of everything pays the invoice that is made afterwards', async () => {
    const d = desk();

    plantPayment(d, { status: 'PAID', amount: 120 });

    await d.world.svc.invoices.createForIntervention(d.job.id, d.admin.id, {} as any);

    const [invoice] = invoiceOf(d);

    expect([invoice.status, invoice.paymentStatus]).toEqual(['PAID', 'PAID']);
    expect(invoice.paidAt).toBeInstanceOf(Date);
  });

  it('money that went back is not kept: 120 paid and 20 given back is 100 kept, which does not pay 120', async () => {
    const d = desk();

    plantPayment(d, { status: 'PARTIALLY_REFUNDED', amount: 120, amountRefunded: 20 });

    await d.world.svc.invoices.createForIntervention(d.job.id, d.admin.id, {} as any);

    expect(invoiceOf(d)[0].status).toBe('ISSUED');
  });

  it('an invoice for what was kept is paid: 120 paid, 20 given back, the invoice is for 100', async () => {
    const d = desk({ quote: 100 });
    const first = plantPayment(d, { status: 'PAID', amount: 120 });

    await d.world.svc.payments.refund(first.id, d.admin.id, { amount: 20 });
    await d.world.svc.invoices.createForIntervention(d.job.id, d.admin.id, {} as any);

    const [invoice] = invoiceOf(d);

    expect([invoice.status, invoice.paymentStatus]).toEqual(['PAID', 'PAID']);
    expect(payment(d.world, first.id).invoiceId).toBe(invoice.id);
  });

  it('a payment that was refunded in full pays nothing', async () => {
    const d = desk();
    const first = plantPayment(d, { status: 'PAID', amount: 120 });

    await d.world.svc.payments.refund(first.id, d.admin.id, {});
    await d.world.svc.invoices.createForIntervention(d.job.id, d.admin.id, {} as any);

    expect(invoiceOf(d)[0].status).toBe('ISSUED');
    expect(payment(d.world, first.id).invoiceId ?? null).toBe(null);
  });

  it('an invoice in another currency than the company\'s cannot be compared with the payments: a payment settles it', async () => {
    const d = desk();

    rowsOf(d.world, 'quote')[0].currency = 'EUR';
    plantPayment(d, { status: 'PAID', amount: 40 });

    await d.world.svc.invoices.createForIntervention(d.job.id, d.admin.id, {} as any);

    expect([invoiceOf(d)[0].currency, invoiceOf(d)[0].status]).toEqual(['EUR', 'PAID']);
  });

  it('no payment, no payment status: the invoice is issued', async () => {
    const d = desk();

    await d.world.svc.invoices.createForIntervention(d.job.id, d.admin.id, {} as any);

    expect([invoiceOf(d)[0].status, invoiceOf(d)[0].paymentStatus]).toEqual(['ISSUED', 'PENDING']);
  });

  it('a confirmation that comes in while the invoice is being made is not missed: the invoice is made with what was received then', async () => {
    const d = desk();
    const rest = plantPayment(d, { amount: 120 });
    const { seen } = await whileHolding(
      d.world,
      (tx) => lockJob(tx, d.job.id),
      () => d.world.svc.invoices.createForIntervention(d.job.id, d.admin.id, {} as any),
      () => invoiceOf(d).length,
      async (tx) => {
        await tx.payment.update({ where: { id: rest.id }, data: { status: 'PAID' } });
      },
    );

    expect(seen).toBe(0);
    expect(invoiceOf(d)[0].status).toBe('PAID');
  });
});

describe('money that went back and is paid again is paid for once (P2-03, after the second review)', () => {
  beforeEach(() => resetLocale());

  const figures = (d: Desk) => {
    const [row] = financialsOf(d);

    return [num(row.totalPrice), num(row.platformCommission), num(row.artisanPayout), num(row.refundAmount), num(row.netRevenue)];
  };

  it('120 paid, 20 given back, 20 paid again: the job is 120, the refund was an overpayment given back, not a cost', async () => {
    const d = desk();
    const first = await pay(d, 120);

    await d.world.svc.payments.refund(first, d.admin.id, { amount: 20 });
    expect(figures(d)).toEqual([120, 24, 96, 20, 4]);

    await pay(d, 20);
    expect(figures(d)).toEqual([120, 24, 96, 20, 24]);
  });

  it('everything given back and paid again: 120, not 240', async () => {
    const d = desk();
    const first = await pay(d, 120);

    await d.world.svc.payments.refund(first, d.admin.id, {});
    await pay(d, 120);

    expect(figures(d)).toEqual([120, 24, 96, 120, 24]);
  });

  it('a refund of more than the overpayment costs the platform the rest', async () => {
    const d = desk();
    const first = await pay(d, 120);

    await d.world.svc.payments.refund(first, d.admin.id, { amount: 20 });
    await pay(d, 20);
    // 140 received, 120 the job: 20 above. A second refund of 30 on the same job: 50 given back, 30 of it above the overpayment
    await d.world.svc.payments.refund(first, d.admin.id, { amount: 30 });

    expect(figures(d)).toEqual([120, 24, 96, 50, -6]);
  });

  it('with no document to compare with, or one in another currency, everything received is the price', async () => {
    const none = desk({ quote: null });

    await pay(none, 150);
    await pay(none, 50);
    expect(figures(none)).toEqual([200, 40, 160, 0, 40]);

    const foreign = desk({ quote: 100 });

    rowsOf(foreign.world, 'quote')[0].currency = 'EUR';

    const received = plantPayment(foreign, { amount: 150 });

    await foreign.world.svc.payments.confirm(received.id, foreign.admin.id, {});
    expect(figures(foreign)).toEqual([150, 30, 120, 0, 30]);
  });

  it('the latest accepted quote is what the job asks for; a quote that was not accepted asks for nothing', async () => {
    const d = desk();

    d.world.memory.plant('quote', { interventionId: d.job.id, createdById: d.artisan.id, status: 'ACCEPTED', amountHT: 80, taxAmount: 0, amountTTC: 80, currency: 'TND', createdAt: new Date('2026-01-01T09:00:00.000Z') });
    d.world.memory.plant('quote', { interventionId: d.job.id, createdById: d.artisan.id, status: 'REJECTED', amountHT: 60, taxAmount: 0, amountTTC: 60, currency: 'TND', createdAt: new Date('2026-12-01T09:00:00.000Z') });
    await pay(d, 100);

    expect(figures(d)).toEqual([100, 20, 80, 0, 20]);
  });

  it('the invoice is what the job asks for when there is one; a cancelled invoice is not', async () => {
    const d = desk({ invoice: 100 });
    const first = await pay(d, 100);

    await d.world.svc.payments.refund(first, d.admin.id, { amount: 20 });
    await pay(d, 20);
    expect(figures(d)).toEqual([100, 20, 80, 20, 20]);

    // the invoice is cancelled: the accepted quote (120) is what the job asks for, and 20 are left to pay on it
    rowsOf(d.world, 'invoice')[0].status = 'CANCELLED';
    await pay(d, 20);
    expect(figures(d)).toEqual([120, 24, 96, 20, 24]);
  });
});

describe('a request that does not say how much asks for what is left to pay (P2-03, after the second review)', () => {
  beforeEach(() => resetLocale());

  const ask = (d: Desk, dto: Record<string, unknown>) => d.world.svc.payments.createClientPaymentRequest(d.client.id, d.job.id, dto as any);
  const askAsAdmin = (d: Desk, dto: Record<string, unknown>) => d.world.svc.payments.createAdminManualPayment(d.admin.id, d.job.id, dto as any);
  const askAsVisitor = (d: Desk, dto: Record<string, unknown>) => d.world.svc.guest.createGuestPayment(d.job.id, d.token, dto as any);

  it('after a deposit of 30 on 120, the customer, the visitor and the back office are asked for 90, and 90 can be confirmed', async () => {
    const asked: number[] = [];

    for (const who of ['customer', 'visitor', 'admin']) {
      const d = desk();

      plantPayment(d, { status: 'PAID', amount: 30 });

      const answer: any = who === 'customer' ? await ask(d, { method: 'BANK_TRANSFER' }) : who === 'visitor' ? await askAsVisitor(d, { method: 'BANK_TRANSFER' }) : await askAsAdmin(d, { method: 'BANK_TRANSFER' });
      const id = answer.payment?.id ?? answer.id;

      asked.push(num(payment(d.world, id).amount));
      expect(await refusal(() => d.world.svc.payments.confirm(id, d.admin.id, {}))).toBe(null);
      expect(jobRow(d).status).toBe('PAID');
    }

    expect(asked).toEqual([90, 90, 90]);
  });

  it('asking again is the same request: the open payment of 90 comes back', async () => {
    const d = desk();

    plantPayment(d, { status: 'PAID', amount: 30 });

    const first: any = await ask(d, { method: 'BANK_TRANSFER' });
    const again: any = await ask(d, { method: 'BANK_TRANSFER' });

    expect([again.replayed, again.id, num(again.amount)]).toEqual([true, first.id, 90]);
    expect(rowsOf(d.world, 'payment').length).toBe(2);
  });

  it('what was given back is asked for again: 120 paid and 20 refunded leaves 20', async () => {
    const d = desk();
    const first = await pay(d, 120);

    await d.world.svc.payments.refund(first, d.admin.id, { amount: 20 });

    const answer: any = await ask(d, { method: 'BANK_TRANSFER' });

    expect(num(payment(d.world, answer.id).amount)).toBe(20);
  });

  it('a job that is paid in full is not asked for again, by anyone; nothing is written', async () => {
    const d = desk();

    await pay(d, 120);

    const refused = [await refusal(() => ask(d, { method: 'BANK_TRANSFER' })), await refusal(() => askAsVisitor(d, { method: 'BANK_TRANSFER' })), await refusal(() => askAsAdmin(d, { method: 'BANK_TRANSFER' }))];

    expect(refused).toEqual(Array(3).fill({ status: 400, message: 'Cette mission est déjà payée.' }));
    expect(rowsOf(d.world, 'payment').length).toBe(1);
  });

  it('an amount that is typed is the amount asked, as before', async () => {
    const d = desk();

    plantPayment(d, { status: 'PAID', amount: 30 });

    const answer: any = await ask(d, { method: 'BANK_TRANSFER', amount: 40 });

    expect(num(payment(d.world, answer.id).amount)).toBe(40);

    // even above what is left: it is asked as typed, and refused when it is confirmed
    const other = desk();

    plantPayment(other, { status: 'PAID', amount: 30 });

    const above: any = await ask(other, { method: 'BANK_TRANSFER', amount: 100 });

    expect(num(payment(other.world, above.id).amount)).toBe(100);
    expect((await refusal(() => other.world.svc.payments.confirm(above.id, other.admin.id, {})))?.status).toBe(409);
  });

  it('what is left never goes above the document: an invoice of 100 on a quote of 120 asks for 100', async () => {
    const d = desk({ invoice: 100 });
    const answer: any = await ask(d, { method: 'BANK_TRANSFER' });

    expect(num(payment(d.world, answer.id).amount)).toBe(100);
  });

  it('a document in another currency cannot be set against the payments: the whole amount is asked', async () => {
    const d = desk({ quote: 100 });

    rowsOf(d.world, 'quote')[0].currency = 'EUR';
    plantPayment(d, { status: 'PAID', amount: 30 });

    const answer: any = await askAsVisitor(d, { method: 'BANK_TRANSFER' });

    expect([num(payment(d.world, answer.payment.id).amount), payment(d.world, answer.payment.id).currency]).toEqual([100, 'EUR']);
  });
});

describe('asking again moves the job when it can, and confirming uses what is found under the lock (P2-03, after the second review)', () => {
  beforeEach(() => resetLocale());

  const ask = (d: Desk, dto: Record<string, unknown>) => d.world.svc.payments.createClientPaymentRequest(d.client.id, d.job.id, dto as any);
  const askAsVisitor = (d: Desk, dto: Record<string, unknown>) => d.world.svc.guest.createGuestPayment(d.job.id, d.token, dto as any);

  it('a request during the work, then again when the work is done: the job moves to PAYMENT_PENDING and the day is written, for both', async () => {
    for (const who of ['customer', 'visitor']) {
      const d = desk({ status: 'IN_PROGRESS' });
      const go = () => (who === 'visitor' ? askAsVisitor(d, { method: 'BANK_TRANSFER' }) : ask(d, { method: 'BANK_TRANSFER' }));

      await go();
      expect(`${who}: ${jobRow(d).status} ${jobRow(d).paymentPendingAt ?? null}`).toBe(`${who}: IN_PROGRESS null`);

      jobRow(d).status = 'COMPLETED';

      const second: any = await go();

      expect(second.replayed).toBe(true);
      expect(`${who}: ${jobRow(d).status}`).toBe(`${who}: PAYMENT_PENDING`);
      expect(jobRow(d).paymentPendingAt).toBeInstanceOf(Date);
      expect(rowsOf(d.world, 'payment').length).toBe(1);
    }
  });

  it('asking again once the job is waiting for payment changes nothing: the day stays', async () => {
    const d = desk({ status: 'COMPLETED' });

    await ask(d, { method: 'BANK_TRANSFER' });

    const movedAt = jobRow(d).paymentPendingAt;

    await new Promise((resolve) => setTimeout(resolve, 5));
    await ask(d, { method: 'BANK_TRANSFER' });
    expect([jobRow(d).status, jobRow(d).paymentPendingAt]).toEqual(['PAYMENT_PENDING', movedAt]);
  });

  it('a reference sent while the confirmation waits for the job is kept, and the line says the amount found then', async () => {
    const d = desk();
    const waiting = plantPayment(d, { amount: 100, method: 'CASH' });
    const { answer } = await whileHolding(
      d.world,
      (tx) => lockJob(tx, d.job.id),
      () => d.world.svc.payments.confirm(waiting.id, d.admin.id, {}),
      () => payment(d.world, waiting.id).status,
      async (tx) => {
        await tx.payment.update({ where: { id: waiting.id }, data: { amount: 30, reference: 'REF-NOUVELLE', clientNote: 'Note du client' } });
      },
    );

    expect(answer).toBe(null);
    expect([payment(d.world, waiting.id).status, num(payment(d.world, waiting.id).amount), payment(d.world, waiting.id).reference, payment(d.world, waiting.id).clientNote]).toEqual(['PAID', 30, 'REF-NOUVELLE', 'Note du client']);
    expect(events(d, 'PAYMENT_CONFIRMED')[0].message).toBe('Le paiement de 30,000 TND a été confirmé.');
    expect(events(d, 'PAYMENT_CONFIRMED')[0].metadata).toMatchObject({ amount: 30, reference: 'REF-NOUVELLE' });
    expect(num(financialsOf(d)[0].totalPrice)).toBe(30);
  });
});
