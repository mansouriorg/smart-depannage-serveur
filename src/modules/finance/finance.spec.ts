import * as fs from 'fs';
import * as path from 'path';

import { TICKET_STAFF_ROLES } from '../../common/auth/role-policy';
import { resetLocale } from '../../common/locale/locale';
import { World, emptyWorld } from '../../common/testing/world';
import { routeKey, scanController } from '../../common/testing/route-roles';
import { readSource, stripComments } from '../../common/testing/source-scan';
import { EXPORT_LIMIT, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE, SUMMARY_LIMIT, pageOf, tooMany } from './finance.service';

/**
 * The finance console (P2-08), run on the real service and a database that answers DECIMAL columns as Decimal objects.
 *
 * One book of a week (19 to 25 October 2026, on the clock of Tunis) with the cases an accountant meets: payments that wait, money
 * that came in on the first and the last instant of the week, a partial refund, one in full that was received before the week, a
 * payment in another currency, a credit note, cash declared by an artisan, payouts open and paid.
 */
const NOW = new Date('2026-10-24T20:00:00.000Z');
const WEEK = { from: '2026-10-19', to: '2026-10-25' };

const at = (iso: string) => new Date(iso);

interface Book {
  world: World;
  ids: Record<string, number>;
  pay: Record<string, any>;
  inv: Record<string, any>;
}

function book(): Book {
  const world = emptyWorld();
  const m = world.memory;
  const user = (role: string, name: string, phone: string | null = null) => m.plant('user', { role, name, phone });
  const clientA = user('CLIENT', 'Ben Salah', '20111222');
  const clientB = user('CLIENT', 'Amel Trabelsi', '55333444');
  const artisan = user('ARTISAN', 'Karim Plombier');
  const artisan2 = user('ARTISAN', 'Slim Électricien');
  const job = (clientId: number, artisanId: number | null = artisan.id) => m.plant('intervention', { clientId, artisanId, status: 'PAID', serviceType: 'PLOMBIER' });
  const job1 = job(clientA.id);
  const job2 = job(clientB.id);
  const job3 = job(clientA.id);

  const invoice = (data: Record<string, any>) => m.plant('invoice', { currency: 'TND', amountHT: 0, taxAmount: 0, stampDuty: 1, creditedAmount: 0, ...data });
  const inv: Record<string, any> = {
    inv1: invoice({ interventionId: job1.id, invoiceNumber: 'F-2026-0001', status: 'ISSUED', amountTTC: 119, issuedAt: at('2026-10-20T08:00:00Z'), clientName: 'Ben Salah', clientPhone: '20111222' }),
    inv2: invoice({ interventionId: job2.id, invoiceNumber: 'F-2026-0002', status: 'PAID', paymentStatus: 'PAID', amountTTC: 238, creditedAmount: 100, issuedAt: at('2026-10-21T08:00:00Z'), clientName: 'Amel Trabelsi', clientPhone: '55333444' }),
    draft: invoice({ interventionId: job2.id, invoiceNumber: 'F-2026-0003', status: 'DRAFT', amountTTC: 10, issuedAt: null, clientName: 'Amel Trabelsi' }),
    cancelled: invoice({ interventionId: job1.id, invoiceNumber: 'F-2026-0004', status: 'CANCELLED', amountTTC: 50, issuedAt: at('2026-10-15T08:00:00Z'), clientName: 'Ben Salah', cancelReason: 'Erreur' }),
    old: invoice({ interventionId: job3.id, invoiceNumber: 'F-2026-0005', status: 'ISSUED', amountTTC: 59.5, issuedAt: at('2026-09-01T08:00:00Z'), clientName: 'Ben Salah' }),
  };

  m.plant('creditNote', { invoiceId: inv.inv2.id, interventionId: job2.id, creditNoteNumber: 'AV-2026-0001', numberYear: 2026, sequence: 1, reason: 'Remise', currency: 'TND', amountHT: 84.034, taxRate: 19, taxAmount: 15.966, amountTTC: 100, stampDuty: 0, issuedAt: at('2026-10-23T08:00:00Z') });

  const payment = (data: Record<string, any>) => m.plant('payment', { provider: 'MANUAL', currency: 'TND', amountRefunded: 0, ...data, requestedAt: data.requestedAt ?? data.confirmedAt ?? at('2026-10-18T09:00:00Z') });
  const pay: Record<string, any> = {
    A: payment({ interventionId: job1.id, method: 'CASH', provider: 'CASH', status: 'AWAITING_CONFIRMATION', amount: 100, requestedAt: at('2026-10-19T08:00:00Z') }),
    B: payment({ interventionId: job2.id, method: 'BANK_TRANSFER', status: 'PENDING', amount: 250, requestedAt: at('2026-10-10T08:00:00Z'), reference: 'VIR-777' }),
    C: payment({ interventionId: job1.id, method: 'ONLINE_CARD', status: 'PAID', amount: 80, confirmedAt: at('2026-10-20T10:00:00Z'), receiptNumber: 'REC-0001', invoiceId: inv.inv1.id }),
    D: payment({ interventionId: job2.id, method: 'CASH', provider: 'CASH', status: 'PAID', amount: 60, confirmedAt: at('2026-10-21T22:30:00Z') }),
    E: payment({ interventionId: job2.id, method: 'BANK_TRANSFER', status: 'PARTIALLY_REFUNDED', amount: 300, amountRefunded: 100, confirmedAt: at('2026-10-22T09:00:00Z'), refundedAt: at('2026-10-23T09:00:00Z'), refundReason: 'Geste commercial' }),
    F: payment({ interventionId: job1.id, method: 'ONLINE', status: 'FAILED', amount: 40, requestedAt: at('2026-10-21T09:00:00Z'), failureReason: 'Carte refusée' }),
    G: payment({ interventionId: job3.id, method: 'ONLINE', status: 'PAID', amount: 55, confirmedAt: at('2026-10-30T09:00:00Z') }),
    H: payment({ interventionId: job1.id, method: 'ONLINE', status: 'PAID', amount: 20, currency: 'EUR', confirmedAt: at('2026-10-20T11:00:00Z') }),
    I: payment({ interventionId: job2.id, method: 'CASH', provider: 'CASH', status: 'PAID', amount: 10, confirmedAt: at('2026-10-21T23:00:00.000Z') }),
    J: payment({ interventionId: job2.id, method: 'CASH', provider: 'CASH', status: 'PAID', amount: 5, confirmedAt: at('2026-10-25T22:59:59.999Z') }),
    K: payment({ interventionId: job2.id, method: 'CASH', provider: 'CASH', status: 'PAID', amount: 7, confirmedAt: at('2026-10-25T23:00:00.000Z') }),
    L: payment({ interventionId: job1.id, method: 'ONLINE_CARD', status: 'REFUNDED', amount: 30, amountRefunded: 30, confirmedAt: at('2026-10-12T09:00:00Z'), refundedAt: at('2026-10-21T10:00:00Z'), refundReason: 'Annulation' }),
  };

  // The cash the artisan said they took for payment A, a remittance, and a second artisan who owes nothing.
  m.plant('cashLedgerEntry', { artisanId: artisan.id, type: 'COLLECTION', interventionId: job1.id, paymentId: pay.A.id, cashAmount: 100, commissionAmount: 20 });
  m.plant('cashLedgerEntry', { artisanId: artisan.id, type: 'REMITTANCE', cashAmount: 0, commissionAmount: -8 });
  m.plant('cashLedgerEntry', { artisanId: artisan2.id, type: 'COLLECTION', cashAmount: 50, commissionAmount: 10 });
  m.plant('cashLedgerEntry', { artisanId: artisan2.id, type: 'REMITTANCE', cashAmount: 0, commissionAmount: -10 });

  const payout = (data: Record<string, any>) => m.plant('artisanPayout', { artisanId: artisan.id, currency: 'TND', ...data });

  payout({ status: 'PENDING', netAmount: 50 });
  payout({ status: 'READY', netAmount: 30 });
  payout({ status: 'PAID', netAmount: 70, paidAt: at('2026-10-22T12:00:00Z') });
  payout({ status: 'PAID', netAmount: 90, paidAt: at('2026-10-02T12:00:00Z') });
  payout({ status: 'CANCELLED', netAmount: 40 });

  return { world, ids: { clientA: clientA.id, clientB: clientB.id, artisan: artisan.id, artisan2: artisan2.id, job1: job1.id, job2: job2.id, job3: job3.id }, pay, inv };
}

async function refusal(work: () => Promise<unknown>): Promise<{ status: number; message: string } | null> {
  try {
    await work();
  } catch (error) {
    const known = error as { getStatus?: () => number; message?: string };

    return { status: typeof known.getStatus === 'function' ? known.getStatus() : 500, message: String(known.message) };
  }

  return null;
}

const idsOf = (page: { items: Array<{ id: number }> }) => page.items.map((item) => item.id);

describe('the totals of a week (P2-08)', () => {
  beforeEach(() => resetLocale());

  it('adds up what was received, what went back and what is left, for the week as the clock of Tunis has it', async () => {
    const { world } = book();
    const summary = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);

    expect(summary.currency).toBe('TND');
    expect(summary.period).toEqual({ from: '2026-10-19', to: '2026-10-25', days: 7 });
    expect(summary.received.count).toBe(5);
    expect(summary.received.amount).toBe(455);
    expect(summary.refunded).toEqual({ count: 2, amount: 130 });
    expect(summary.net).toBe(325);
  });

  it('counts a payment on the day it was confirmed on the clock of the business, on the edges of the week too', async () => {
    const { world } = book();
    const { days } = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);

    expect(days.map((day: any) => day.day)).toEqual(['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']);
    expect(days.map((day: any) => [day.received, day.refunded, day.count])).toEqual([
      [0, 0, 0],
      [80, 0, 1],
      // 22:30 UTC is 23:30 on the 21st in Tunis; 23:00 UTC is midnight, the 22nd.
      [60, 30, 1],
      [310, 0, 2],
      [0, 100, 0],
      [0, 0, 0],
      // the last instant of the 25th is in; the first of the 26th (7 TND) is not.
      [5, 0, 1],
    ]);
  });

  it('adds up the days to the totals of the week', async () => {
    const { world } = book();
    const summary = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);

    expect(summary.days.reduce((sum: number, day: any) => sum + day.received, 0)).toBe(summary.received.amount);
    expect(summary.days.reduce((sum: number, day: any) => sum + day.refunded, 0)).toBe(summary.refunded.amount);
    expect(summary.days.reduce((sum: number, day: any) => sum + day.count, 0)).toBe(summary.received.count);
  });

  it('splits what was received by the way it was paid', async () => {
    const { world } = book();
    const { received } = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);

    expect(received.byMethod).toEqual([
      { method: 'BANK_TRANSFER', count: 1, amount: 300 },
      { method: 'CASH', count: 3, amount: 75 },
      { method: 'ONLINE_CARD', count: 1, amount: 80 },
    ]);
  });

  it('counts a refund on the day of the last refund of the payment, even if the money came in before the week', async () => {
    const { world } = book();
    const { refunded, days } = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);

    // L (30, received on the 12th, given back in full on the 21st) and E (100 of 300, on the 23rd).
    expect(refunded.amount).toBe(130);
    expect(days[2].refunded).toBe(30);
    expect(days[4].refunded).toBe(100);
  });

  it('counts a payment that was refunded in full as received in the week it was confirmed, not in the week it was refunded', async () => {
    const { world } = book();
    const early = await world.svc.finance.summary('ACCOUNTANT', { from: '2026-10-12', to: '2026-10-12' }, NOW);

    expect(early.received).toMatchObject({ count: 1, amount: 30 });
    expect(early.refunded).toEqual({ count: 0, amount: 0 });
  });

  it('leaves out money in another currency than the company\'s: it cannot be added to dinars', async () => {
    const { world } = book();
    const summary = await world.svc.finance.summary('ACCOUNTANT', { from: '2026-10-20', to: '2026-10-20' }, NOW);

    expect(summary.received).toMatchObject({ count: 1, amount: 80 });
  });

  it('shows what waits whatever the week: asked for before, still not decided', async () => {
    const { world, pay } = book();
    const { awaiting } = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);

    expect(awaiting.count).toBe(2);
    expect(awaiting.amount).toBe(350);
    expect(awaiting.oldestAt).toEqual(pay.B.requestedAt);
    expect(awaiting.byMethod).toEqual([
      { method: 'BANK_TRANSFER', count: 1, amount: 250 },
      { method: 'CASH', count: 1, amount: 100 },
    ]);

    const another = await world.svc.finance.summary('ACCOUNTANT', { from: '2026-01-01', to: '2026-01-07' }, NOW);

    expect(another.awaiting.count).toBe(2);
    expect(another.received.count).toBe(0);
  });

  it('counts the invoices and credit notes issued in the week, with the stamp duty, and not drafts or cancelled ones', async () => {
    const { world } = book();
    const { invoices } = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);

    // F-0001: 119 + 1; F-0002: 238 + 1. The draft and the cancelled invoice (issued the 15th) are not in.
    expect(invoices.issued).toEqual({ count: 2, total: 359 });
    expect(invoices.creditNotes).toEqual({ count: 1, total: 100 });
  });

  it('counts the invoices that are out and not paid whenever they were issued, and what is left on them after what the job holds', async () => {
    const { world } = book();
    const { invoices } = await world.svc.finance.summary('ACCOUNTANT', { from: '2026-01-01', to: '2026-01-07' }, NOW);

    // F-0001: 120 to pay, 80 held on its job (the card payment; the refunded one holds nothing; the euros are not counted) -> 40.
    // F-0005: 60.5 to pay, 55 held -> 5.5.
    expect(invoices.unpaid).toEqual({ count: 2, left: 45.5 });
  });

  it('says what is to give back after credit notes', async () => {
    const { world } = book();
    const { refundsDue } = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);

    // Job 2 holds 60 + 200 + 10 + 5 + 7 = 282 and its invoice asks 238 - 100 + 1 = 139.
    expect(refundsDue).toEqual({ count: 1, amount: 143 });
  });

  it('counts the artisans who owe commission on cash, and what the cash they hold comes to', async () => {
    const { world } = book();
    const { cash } = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);

    expect(cash).toEqual({ artisansOwing: 1, commissionOwed: 12, cashCollected: 150 });
  });

  it('counts the payouts that are open (pending or ready), and the ones paid in the week, not cancelled ones or ones paid before', async () => {
    const { world } = book();
    const { payouts } = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);

    expect(payouts.open).toEqual({ count: 2, net: 80 });
    expect(payouts.paid).toEqual({ count: 1, net: 70 });
  });

  it('is the last seven days when no week is named', async () => {
    const { world } = book();
    const summary = await world.svc.finance.summary('ACCOUNTANT', {}, NOW);

    expect(summary.period).toEqual({ from: '2026-10-18', to: '2026-10-24', days: 7 });
    // J (the 25th) is not in the last seven days.
    expect(summary.received.count).toBe(4);
  });

  it('answers a book with nothing in it with zeros, not with errors', async () => {
    const world = emptyWorld();
    const summary = await world.svc.finance.summary('ADMIN', WEEK, NOW);

    expect(summary.received).toEqual({ count: 0, amount: 0, byMethod: [] });
    expect(summary.awaiting).toEqual({ count: 0, amount: 0, oldestAt: null, byMethod: [] });
    expect(summary.refunded).toEqual({ count: 0, amount: 0 });
    expect(summary.net).toBe(0);
    expect(summary.invoices).toEqual({ issued: { count: 0, total: 0 }, creditNotes: { count: 0, total: 0 }, unpaid: { count: 0, left: 0 } });
    expect(summary.refundsDue).toEqual({ count: 0, amount: 0 });
    expect(summary.cash).toEqual({ artisansOwing: 0, commissionOwed: 0, cashCollected: 0 });
    expect(summary.payouts).toEqual({ open: { count: 0, net: 0 }, paid: { count: 0, net: 0 } });
    expect(summary.days).toHaveLength(7);
  });

  it('answers plain numbers, never Decimal objects', async () => {
    const { world } = book();
    const summary = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);

    for (const value of [summary.net, summary.received.amount, summary.awaiting.amount, summary.invoices.issued.total, summary.cash.commissionOwed, summary.payouts.open.net]) expect(typeof value).toBe('number');
  });

  it('refuses a week that goes backwards, is too long, or is not a date', async () => {
    const { world } = book();

    expect((await refusal(() => world.svc.finance.summary('ACCOUNTANT', { from: '2026-10-25', to: '2026-10-19' }, NOW)))?.status).toBe(400);
    expect((await refusal(() => world.svc.finance.summary('ACCOUNTANT', { from: '2026-01-01', to: '2026-12-31' }, NOW)))?.status).toBe(400);
    expect((await refusal(() => world.svc.finance.summary('ACCOUNTANT', { from: '2026-02-30' }, NOW)))?.status).toBe(400);
  });
});

describe('the payments of a week (P2-08)', () => {
  beforeEach(() => resetLocale());

  it('lists what waits for the team, the longest wait first, whatever the date', async () => {
    const { world, pay } = book();
    const page = await world.svc.finance.listPayments('ACCOUNTANT', { view: 'awaiting' }, NOW);

    expect(idsOf(page)).toEqual([pay.B.id, pay.A.id]);
    expect(page.total).toBe(2);
    expect(page.amount).toBe(350);
    expect(page.period.explicit).toBe(false);
  });

  it('puts the newest first in the "awaiting" tab when asked', async () => {
    const { world, pay } = book();

    expect(idsOf(await world.svc.finance.listPayments('ACCOUNTANT', { view: 'awaiting', sort: 'newest' }, NOW))).toEqual([pay.A.id, pay.B.id]);
  });

  it('shows what waits whatever the week named: a transfer asked for before the week is still in the list, as the summary counts it', async () => {
    const { world, pay } = book();
    const page = await world.svc.finance.listPayments('ACCOUNTANT', { view: 'awaiting', ...WEEK }, NOW);

    expect(idsOf(page)).toEqual([pay.B.id, pay.A.id]);
    expect(page.total).toBe((await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW)).awaiting.count);
    expect(page.period).toEqual({ from: '2026-10-19', to: '2026-10-25', explicit: true, applied: false });
  });

  it('lists the money received in the week by the day it was confirmed, newest first', async () => {
    const { world, pay } = book();
    const page = await world.svc.finance.listPayments('ACCOUNTANT', { view: 'received', ...WEEK }, NOW);

    expect(idsOf(page)).toEqual([pay.J.id, pay.E.id, pay.I.id, pay.D.id, pay.H.id, pay.C.id]);
  });

  it('adds up in the currency of the company only, though the list shows every currency', async () => {
    const { world } = book();
    const page = await world.svc.finance.listPayments('ACCOUNTANT', { view: 'received', ...WEEK }, NOW);

    expect(page.total).toBe(6);
    expect(page.amount).toBe(455);
    expect(page.items.find((item: any) => item.currency === 'EUR')).toBeDefined();
  });

  it('lists the money given back, by the day of the refund', async () => {
    const { world, pay } = book();

    expect(idsOf(await world.svc.finance.listPayments('ACCOUNTANT', { view: 'refunded', ...WEEK }, NOW))).toEqual([pay.E.id, pay.L.id]);
    expect(idsOf(await world.svc.finance.listPayments('ACCOUNTANT', { view: 'refunded', from: '2026-10-22', to: '2026-10-25' }, NOW))).toEqual([pay.E.id]);
  });

  it('says what can still go back on each payment', async () => {
    const { world, pay } = book();
    const page = await world.svc.finance.listPayments('ACCOUNTANT', { view: 'refunded', ...WEEK }, NOW);
    const byId = new Map<number, any>(page.items.map((item: any) => [item.id, item]));

    expect(byId.get(pay.E.id).refundable).toBe(200);
    expect(byId.get(pay.E.id).reason).toBe('Geste commercial');
    expect(byId.get(pay.L.id).refundable).toBe(0);
  });

  it('shows the cash that the artisan said they took on a payment that waits, and who', async () => {
    const { world, pay, ids } = book();
    const page = await world.svc.finance.listPayments('ACCOUNTANT', { view: 'awaiting' }, NOW);
    const byId = new Map<number, any>(page.items.map((item: any) => [item.id, item]));

    expect(byId.get(pay.A.id).declared).toEqual({ artisanId: ids.artisan, amount: 100 });
    expect(byId.get(pay.B.id).declared).toBeNull();
  });

  it('no longer shows cash as declared once the line that declared it was taken back', async () => {
    const { world, pay, ids } = book();
    const line = world.memory.rows('cashLedgerEntry').find((row: any) => row.paymentId === pay.A.id);

    world.memory.plant('cashLedgerEntry', { artisanId: ids.artisan, type: 'REVERSAL', interventionId: ids.job1, paymentId: pay.A.id, reversesId: line.id, cashAmount: -100, commissionAmount: -20 });

    const page = await world.svc.finance.listPayments('ACCOUNTANT', { view: 'awaiting' }, NOW);

    expect(page.items.find((item: any) => item.id === pay.A.id).declared).toBeNull();
  });

  it('filters by method and by status', async () => {
    const { world, pay } = book();

    expect(idsOf(await world.svc.finance.listPayments('ACCOUNTANT', { method: 'CASH', ...WEEK }, NOW)).sort()).toEqual([pay.A.id, pay.D.id, pay.I.id, pay.J.id].sort());
    expect(idsOf(await world.svc.finance.listPayments('ACCOUNTANT', { status: 'FAILED' }, NOW))).toEqual([pay.F.id]);
    expect(idsOf(await world.svc.finance.listPayments('ACCOUNTANT', { view: 'awaiting', status: 'PENDING' }, NOW))).toEqual([pay.B.id]);
    // a status that the tab cannot hold: nothing, not everything.
    expect((await world.svc.finance.listPayments('ACCOUNTANT', { view: 'awaiting', status: 'PAID' }, NOW)).total).toBe(0);
  });

  it('finds a payment by its reference, its receipt, its invoice, its customer\'s name or phone', async () => {
    const { world, pay } = book();
    const search = async (text: string) => idsOf(await world.svc.finance.listPayments('ACCOUNTANT', { search: text }, NOW)).sort((a: number, b: number) => a - b);

    expect(await search('vir-777')).toEqual([pay.B.id]);
    expect(await search('rec-0001')).toEqual([pay.C.id]);
    expect(await search('F-2026-0001')).toEqual([pay.C.id]);
    expect(await search('55333')).toEqual([pay.B.id, pay.D.id, pay.E.id, pay.I.id, pay.J.id, pay.K.id].sort((a, b) => a - b));
    expect(await search('BEN sal')).toEqual([pay.A.id, pay.C.id, pay.F.id, pay.G.id, pay.H.id, pay.L.id].sort((a, b) => a - b));
    expect(await search('personne')).toEqual([]);
  });

  it('finds the payments of a job by its number', async () => {
    const { world, pay, ids } = book();
    const found = idsOf(await world.svc.finance.listPayments('ACCOUNTANT', { search: `#${ids.job3}` }, NOW));

    expect(found).toContain(pay.G.id);
  });

  it('shows only the payments of one job when it is asked for by its number, where the search shows every payment with that number', async () => {
    const { world } = book();
    const planted: any[] = world.memory.rows('payment');
    const jobs = [...new Set(planted.map((row) => row.interventionId))];
    const idsOfJob = (job: number) => planted.filter((row) => row.interventionId === job).map((row) => row.id).sort((a, b) => a - b);
    let wider = 0;

    expect(jobs.length).toBeGreaterThan(2);

    for (const job of jobs) {
      const filtered = idsOf(await world.svc.finance.listPayments('ACCOUNTANT', { interventionId: job, view: 'all' }, NOW)).sort((a: number, b: number) => a - b);
      const searched = idsOf(await world.svc.finance.listPayments('ACCOUNTANT', { search: String(job) }, NOW));

      expect(filtered).toEqual(idsOfJob(job));
      // The search also finds the payment that has the number of the job, whichever job it belongs to.
      if (searched.length > filtered.length) wider += 1;
    }

    expect(wider).toBeGreaterThan(0);
  });

  it('combines the job with the tab, the way of payment and the file, and reads a number sent as text', async () => {
    const { world, pay } = book();
    const job = pay.G.interventionId;
    const all = (query: Record<string, unknown>) => world.svc.finance.listPayments('ACCOUNTANT', query, NOW);

    expect(idsOf(await all({ interventionId: String(job) })).sort()).toEqual(idsOf(await all({ interventionId: job })).sort());
    expect(idsOf(await all({ interventionId: job, status: 'FAILED' }))).toEqual((world.memory.rows('payment') as any[]).filter((row) => row.interventionId === job && row.status === 'FAILED').map((row) => row.id));
    expect((await all({ interventionId: job, view: 'awaiting', status: 'PAID' })).total).toBe(0);

    const file = await world.svc.finance.exportPayments('ACCOUNTANT', { interventionId: job } as any, NOW);

    expect(file.buffer.toString('utf8').trim().split('\n').length - 1).toBe((world.memory.rows('payment') as any[]).filter((row) => row.interventionId === job).length);
  });

  it('shows no payment for a job number that is no job, not every payment', async () => {
    const { world } = book();

    for (const interventionId of [0, -1, 'abc', 2.5, 99_999_999_999]) {
      expect((await world.svc.finance.listPayments('ACCOUNTANT', { interventionId } as any, NOW)).total).toBe(0);
    }

    // Not given at all, or left empty: no filter.
    expect((await world.svc.finance.listPayments('ACCOUNTANT', { interventionId: undefined }, NOW)).total).toBe(12);
    expect((await world.svc.finance.listPayments('ACCOUNTANT', { interventionId: '' } as any, NOW)).total).toBe(12);
  });

  it('does not match everything on a search of only spaces, or a search that is a percent sign', async () => {
    const { world } = book();

    expect((await world.svc.finance.listPayments('ACCOUNTANT', { search: '   ' }, NOW)).total).toBe(12);
    expect((await world.svc.finance.listPayments('ACCOUNTANT', { search: '%' }, NOW)).total).toBe(0);
  });

  it('pages: 20 rows by default, at most 100, a page past the end is empty', async () => {
    const { world } = book();
    const all = await world.svc.finance.listPayments('ACCOUNTANT', {}, NOW);

    expect(all.total).toBe(12);
    expect(all.items).toHaveLength(12);
    expect(all.limit).toBe(DEFAULT_PAGE_SIZE);
    expect(all.pages).toBe(1);

    const first = await world.svc.finance.listPayments('ACCOUNTANT', { limit: 5 }, NOW);
    const last = await world.svc.finance.listPayments('ACCOUNTANT', { limit: 5, page: 3 }, NOW);
    const past = await world.svc.finance.listPayments('ACCOUNTANT', { limit: 5, page: 99 }, NOW);

    expect([first.items.length, first.pages, first.page]).toEqual([5, 3, 1]);
    expect(last.items).toHaveLength(2);
    expect(past.items).toEqual([]);
    expect(past.total).toBe(12);
    expect(new Set([...idsOf(first), ...idsOf(await world.svc.finance.listPayments('ACCOUNTANT', { limit: 5, page: 2 }, NOW)), ...idsOf(last)]).size).toBe(12);
  });

  it('is 20 rows by default and 100 at most, as the screens and the DTO say', () => {
    expect(DEFAULT_PAGE_SIZE).toBe(20);
    expect(MAX_PAGE_SIZE).toBe(100);
    expect(pageOf({ limit: 100 }).limit).toBe(100);
    expect(pageOf({ limit: 101 }).limit).toBe(100);
  });

  it('reads page and limit sensibly: from 1, never over 100, a nonsense value is the default', () => {
    expect(pageOf({})).toEqual({ page: 1, limit: DEFAULT_PAGE_SIZE });
    expect(pageOf({ page: 0, limit: 0 })).toEqual({ page: 1, limit: DEFAULT_PAGE_SIZE });
    expect(pageOf({ page: -4, limit: -1 })).toEqual({ page: 1, limit: DEFAULT_PAGE_SIZE });
    expect(pageOf({ page: 'x', limit: 'y' })).toEqual({ page: 1, limit: DEFAULT_PAGE_SIZE });
    expect(pageOf({ page: 3.9, limit: 1000 })).toEqual({ page: 3, limit: MAX_PAGE_SIZE });
    expect(pageOf({ page: '2', limit: '7' })).toEqual({ page: 2, limit: 7 });
  });

  it('answers plain numbers and the names of the people, with no password or token in it', async () => {
    const { world } = book();
    const page = await world.svc.finance.listPayments('ACCOUNTANT', { view: 'received', ...WEEK }, NOW);
    const text = JSON.stringify(page);

    for (const item of page.items) {
      expect(typeof item.amount).toBe('number');
      expect(typeof item.refundable).toBe('number');
    }

    expect(text).not.toMatch(/password|token|email/i);
  });

  it('keeps the same order from one call to the next when two payments share a date', async () => {
    const { world, ids } = book();
    const when = at('2026-10-22T09:00:00Z');

    world.memory.plant('payment', { interventionId: ids.job2, method: 'CASH', status: 'PAID', amount: 1, currency: 'TND', confirmedAt: when, requestedAt: when });
    world.memory.plant('payment', { interventionId: ids.job2, method: 'CASH', status: 'PAID', amount: 2, currency: 'TND', confirmedAt: when, requestedAt: when });

    const a = idsOf(await world.svc.finance.listPayments('ACCOUNTANT', { view: 'received', ...WEEK }, NOW));
    const b = idsOf(await world.svc.finance.listPayments('ACCOUNTANT', { view: 'received', ...WEEK }, NOW));

    expect(a).toEqual(b);
  });
});

describe('the payments of a week as a file (P2-08)', () => {
  beforeEach(() => resetLocale());

  it('is a CSV, oldest first, named for the view and the week', async () => {
    const { world } = book();
    const file = await world.svc.finance.exportPayments('ACCOUNTANT', { view: 'received', ...WEEK }, NOW);
    const text = file.buffer.toString('utf8');
    const lines = text.split('\r\n');

    expect(file.filename).toBe('paiements-received-2026-10-19_2026-10-25.csv');
    expect(file.contentType).toBe('text/csv; charset=utf-8');
    expect([...file.buffer.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(lines).toHaveLength(8);
    expect(lines.slice(1, 7).map((line) => line.split(';')[2])).toEqual(['2026-10-20 11:00', '2026-10-20 12:00', '2026-10-21 23:30', '2026-10-22 00:00', '2026-10-22 10:00', '2026-10-25 23:59']);
  });

  it('holds the same payments as the list of the same filter', async () => {
    const { world } = book();
    const filter = { view: 'received', ...WEEK };
    const list = await world.svc.finance.listPayments('ACCOUNTANT', { ...filter, limit: 100 }, NOW);
    const file = await world.svc.finance.exportPayments('ACCOUNTANT', filter, NOW);
    const exported = file.buffer.toString('utf8').split('\r\n').slice(1, -1).map((line: string) => Number(line.split(';')[0]));

    expect([...exported].sort((a, b) => a - b)).toEqual(idsOf(list).sort((a: number, b: number) => a - b));
  });

  it('is named for the view alone when no week is named', async () => {
    const { world } = book();

    expect((await world.svc.finance.exportPayments('ACCOUNTANT', { view: 'awaiting' }, NOW)).filename).toBe('paiements-awaiting.csv');
    expect((await world.svc.finance.exportPayments('ACCOUNTANT', {}, NOW)).filename).toBe('paiements-all.csv');
  });

  it('writes the amounts with a comma and three decimals', async () => {
    const { world } = book();
    const text = (await world.svc.finance.exportPayments('ACCOUNTANT', { view: 'refunded', ...WEEK }, NOW)).buffer.toString('utf8');

    expect(text).toContain(';300,000;100,000;2026-10-23 10:00;TND;');
    expect(text).toContain(';30,000;30,000;2026-10-21 11:00;TND;');
  });

  it('shows a customer name that starts like a formula as text', async () => {
    const { world, ids } = book();

    await world.prisma.user.update({ where: { id: ids.clientB }, data: { name: '=1+1' } });

    const text = (await world.svc.finance.exportPayments('ACCOUNTANT', { view: 'received', ...WEEK }, NOW)).buffer.toString('utf8');

    expect(text).toContain(";'=1+1;");
    expect(text).not.toContain(';=1+1;');
  });

  it('is only a header for a week with nothing in it', async () => {
    const { world } = book();
    const text = (await world.svc.finance.exportPayments('ACCOUNTANT', { view: 'received', from: '2026-01-01', to: '2026-01-07' }, NOW)).buffer.toString('utf8');

    expect(text.split('\r\n')).toHaveLength(2);
  });

  it('builds a file of exactly the most rows a spreadsheet should be given, and refuses one more, saying to cut the period', async () => {
    const world = emptyWorld();
    const client = world.memory.plant('user', { role: 'CLIENT', name: 'Client' });
    const job = world.memory.plant('intervention', { clientId: client.id, status: 'PAID', serviceType: 'PLOMBIER' });
    const one = () => world.memory.plant('payment', { interventionId: job.id, method: 'CASH', status: 'PAID', amount: 1, currency: 'TND', confirmedAt: at('2026-10-20T10:00:00Z'), requestedAt: at('2026-10-20T10:00:00Z') });

    for (let index = 0; index < EXPORT_LIMIT; index += 1) one();

    const file = await world.svc.finance.exportPayments('ACCOUNTANT', { view: 'received', ...WEEK }, NOW);

    expect(file.buffer.toString('utf8').split('\r\n')).toHaveLength(EXPORT_LIMIT + 2);

    one();

    const refused = await refusal(() => world.svc.finance.exportPayments('ACCOUNTANT', { view: 'received', ...WEEK }, NOW));

    expect(refused?.status).toBe(400);
    expect(refused?.message).toMatch(/Trop de lignes/);
    expect(refused?.message).toContain(String(EXPORT_LIMIT + 1));
  });
});

describe('the invoices of a week (P2-08)', () => {
  beforeEach(() => resetLocale());

  it('lists the invoices that were issued, newest first, and never a draft', async () => {
    const { world, inv } = book();
    const page = await world.svc.finance.listInvoices('ACCOUNTANT', {}, NOW);

    expect(idsOf(page)).toEqual([inv.inv2.id, inv.inv1.id, inv.cancelled.id, inv.old.id]);
    expect(page.items.map((item: any) => item.number)).toEqual(['F-2026-0002', 'F-2026-0001', 'F-2026-0004', 'F-2026-0005']);
  });

  it('says what each asks, what the job holds, what is left, and the credit notes it has', async () => {
    const { world, inv } = book();
    const page = await world.svc.finance.listInvoices('ACCOUNTANT', {}, NOW);
    const byId = new Map<number, any>(page.items.map((item: any) => [item.id, item]));

    expect(byId.get(inv.inv1.id)).toMatchObject({ toPay: 120, received: 80, left: 40, credited: 0, creditNotes: [] });
    expect(byId.get(inv.inv2.id)).toMatchObject({ toPay: 139, received: 282, left: 0, credited: 100 });
    expect(byId.get(inv.inv2.id).creditNotes.map(({ id, ...note }: any) => note)).toEqual([{ number: 'AV-2026-0001', amountTTC: 100, stampDuty: 0, reason: 'Remise', issuedAt: at('2026-10-23T08:00:00Z') }]);
    expect(byId.get(inv.old.id)).toMatchObject({ toPay: 60.5, received: 55, left: 5.5 });
    expect(byId.get(inv.cancelled.id)).toMatchObject({ toPay: 0, left: 0, cancelReason: 'Erreur' });
  });

  it('adds up what is to pay on the invoices of the filter, not counting the cancelled one', async () => {
    const { world } = book();

    expect((await world.svc.finance.listInvoices('ACCOUNTANT', {}, NOW)).amount).toBe(319.5);
  });

  it('holds the invoices that ask money in "unpaid", and the ones with a credit note in "credited"', async () => {
    const { world, inv } = book();

    expect(idsOf(await world.svc.finance.listInvoices('ACCOUNTANT', { view: 'unpaid' }, NOW))).toEqual([inv.inv1.id, inv.old.id]);
    expect(idsOf(await world.svc.finance.listInvoices('ACCOUNTANT', { view: 'credited' }, NOW))).toEqual([inv.inv2.id]);
  });

  it('keeps to the week when one is named, by the day of issue', async () => {
    const { world, inv } = book();

    expect(idsOf(await world.svc.finance.listInvoices('ACCOUNTANT', WEEK, NOW))).toEqual([inv.inv2.id, inv.inv1.id]);
    expect(idsOf(await world.svc.finance.listInvoices('ACCOUNTANT', { from: '2026-10-21', to: '2026-10-21' }, NOW))).toEqual([inv.inv2.id]);
  });

  it('filters by status, and a draft is not reachable by asking for drafts', async () => {
    const { world, inv } = book();

    expect(idsOf(await world.svc.finance.listInvoices('ACCOUNTANT', { status: 'CANCELLED' }, NOW))).toEqual([inv.cancelled.id]);
    expect((await world.svc.finance.listInvoices('ACCOUNTANT', { status: 'DRAFT' }, NOW)).total).toBe(0);
  });

  it('finds an invoice by its number, its credit note\'s number, its customer', async () => {
    const { world, inv } = book();

    expect(idsOf(await world.svc.finance.listInvoices('ACCOUNTANT', { search: 'f-2026-0001' }, NOW))).toEqual([inv.inv1.id]);
    expect(idsOf(await world.svc.finance.listInvoices('ACCOUNTANT', { search: 'AV-2026-0001' }, NOW))).toEqual([inv.inv2.id]);
    expect(idsOf(await world.svc.finance.listInvoices('ACCOUNTANT', { search: 'ben' }, NOW))).toEqual([inv.inv1.id, inv.cancelled.id, inv.old.id]);
    expect(idsOf(await world.svc.finance.listInvoices('ACCOUNTANT', { search: '55333' }, NOW))).toEqual([inv.inv2.id]);
  });

  it('pages like the payments do', async () => {
    const { world } = book();
    const page = await world.svc.finance.listInvoices('ACCOUNTANT', { limit: 3, page: 2 }, NOW);

    expect([page.items.length, page.total, page.pages, page.page]).toEqual([1, 4, 2, 2]);
  });
});

/** Jobs that have a credit note, in the cases an accountant meets. */
function owing() {
  const world = emptyWorld();
  const m = world.memory;
  const client = m.plant('user', { role: 'CLIENT', name: 'Client', phone: '20999888' });
  const jobs: Record<string, any> = {};
  const invoices: Record<string, any> = {};
  const payments: Record<string, any> = {};
  let sequence = 0;

  const job = (name: string) => (jobs[name] = m.plant('intervention', { clientId: client.id, status: 'PAID', serviceType: 'PLOMBIER' }));
  const invoice = (name: string, jobName: string, data: Record<string, any>) =>
    (invoices[name] = m.plant('invoice', { interventionId: jobs[jobName].id, currency: 'TND', amountHT: 0, taxAmount: 0, stampDuty: 1, creditedAmount: 0, status: 'ISSUED', issuedAt: at('2026-10-10T08:00:00Z'), ...data }));
  const note = (name: string, invoiceName: string, amountTTC: number, issuedAt: string, stampDuty = 0) => {
    sequence += 1;

    return m.plant('creditNote', { invoiceId: invoices[invoiceName].id, interventionId: invoices[invoiceName].interventionId, creditNoteNumber: `AV-2026-${String(sequence).padStart(4, '0')}`, numberYear: 2026, sequence, reason: name, currency: 'TND', amountHT: 0, taxRate: 19, taxAmount: 0, amountTTC, stampDuty, issuedAt: at(issuedAt) });
  };
  const paid = (name: string, jobName: string, amount: number, data: Record<string, any> = {}) =>
    (payments[name] = m.plant('payment', { interventionId: jobs[jobName].id, method: 'BANK_TRANSFER', provider: 'MANUAL', status: 'PAID', amount, amountRefunded: 0, currency: 'TND', confirmedAt: at('2026-10-11T08:00:00Z'), requestedAt: at('2026-10-11T08:00:00Z'), ...data }));

  // A: credited 100 of 239: the customer paid all of it -> 100 to give back.
  job('A');
  invoice('A', 'A', { invoiceNumber: 'F-2026-0101', amountTTC: 238, creditedAmount: 100 });
  note('A', 'A', 100, '2026-10-15T08:00:00Z');
  paid('A', 'A', 239);

  // B: a credit note closed the invoice (cancelled): the customer owes nothing and paid 120 -> 120.
  job('B');
  invoice('B', 'B', { invoiceNumber: 'F-2026-0102', status: 'CANCELLED', amountTTC: 119, creditedAmount: 119 });
  note('B', 'B', 119, '2026-10-12T08:00:00Z', 1);
  paid('B', 'B', 120);

  // C: closed, then replaced by a live invoice of 100 (no stamp duty): paid 120 -> 20.
  job('C');
  invoice('C-old', 'C', { invoiceNumber: 'F-2026-0103', status: 'CANCELLED', amountTTC: 119, creditedAmount: 119 });
  invoice('C', 'C', { invoiceNumber: 'F-2026-0104', amountTTC: 100, stampDuty: 0 });
  note('C', 'C-old', 119, '2026-10-20T08:00:00Z', 1);
  paid('C', 'C', 120);

  // D: credited 100 and the customer paid exactly what is left (139): nothing to give back.
  job('D');
  invoice('D', 'D', { invoiceNumber: 'F-2026-0105', status: 'PAID', amountTTC: 238, creditedAmount: 100 });
  note('D', 'D', 100, '2026-10-16T08:00:00Z');
  paid('D', 'D', 139);

  // E: credited, and the customer paid less than is left: nothing to give back (they owe).
  job('E');
  invoice('E', 'E', { invoiceNumber: 'F-2026-0106', amountTTC: 238, creditedAmount: 100 });
  note('E', 'E', 100, '2026-10-17T08:00:00Z');
  paid('E', 'E', 50);

  // F: 100 of 239 already given back: it holds 139 = what is left to pay.
  job('F');
  invoice('F', 'F', { invoiceNumber: 'F-2026-0107', status: 'PAID', amountTTC: 238, creditedAmount: 100 });
  note('F', 'F', 100, '2026-10-18T08:00:00Z');
  paid('F', 'F', 239, { status: 'PARTIALLY_REFUNDED', amountRefunded: 100 });

  // G: an invoice in euros: it cannot be set against dinars, the accountant reads it.
  job('G');
  invoice('G', 'G', { invoiceNumber: 'F-2026-0108', currency: 'EUR', amountTTC: 100, creditedAmount: 50 });
  note('G', 'G', 50, '2026-10-19T08:00:00Z');
  paid('G', 'G', 500);

  // H: no credit note, paid too much: not a refund due for this screen (nobody took anything back).
  job('H');
  invoice('H', 'H', { invoiceNumber: 'F-2026-0109', amountTTC: 100 });
  paid('H', 'H', 500);

  return { world, jobs, invoices, payments, client };
}

describe('the refunds that are due (P2-08)', () => {
  beforeEach(() => resetLocale());

  it('lists the jobs where a credit note leaves the customer having paid more than is owed, and by how much', async () => {
    const { world, jobs } = owing();
    const answer = await world.svc.finance.refundsDue('ACCOUNTANT');
    const due = new Map<number, number>(answer.items.map((row: any) => [row.interventionId, row.due]));

    expect([...due.keys()].sort((a, b) => a - b)).toEqual([jobs.A.id, jobs.B.id, jobs.C.id].sort((a, b) => a - b));
    expect(due.get(jobs.A.id)).toBe(100);
    expect(due.get(jobs.B.id)).toBe(120);
    expect(due.get(jobs.C.id)).toBe(20);
    expect(answer.total).toBe(3);
    expect(answer.amount).toBe(240);
  });

  it('puts the one who has waited longest first: by the date of the first credit note', async () => {
    const { world, jobs } = owing();
    const answer = await world.svc.finance.refundsDue('ACCOUNTANT');

    expect(answer.items.map((row: any) => row.interventionId)).toEqual([jobs.B.id, jobs.A.id, jobs.C.id]);
    expect(answer.items[0].since).toEqual(at('2026-10-12T08:00:00Z'));
  });

  it('says what the job holds, what is owed now, and which invoice stands', async () => {
    const { world, jobs, invoices } = owing();
    const answer = await world.svc.finance.refundsDue('ACCOUNTANT');
    const row = (job: any) => answer.items.find((item: any) => item.interventionId === job.id);

    expect(row(jobs.A)).toMatchObject({ kept: 239, owed: 139, due: 100, invoice: { id: invoices.A.id, number: 'F-2026-0101' } });
    expect(row(jobs.B)).toMatchObject({ kept: 120, owed: 0, due: 120, invoice: null });
    expect(row(jobs.C)).toMatchObject({ kept: 120, owed: 100, due: 20, invoice: { id: invoices.C.id, number: 'F-2026-0104' } });
    expect(row(jobs.A).client).toMatchObject({ name: 'Client', phone: '20999888' });
    expect(row(jobs.A).creditNotes.map((note: any) => [note.amount, note.issuedAt])).toEqual([[100, at('2026-10-15T08:00:00Z')]]);
    // the credit note that closed an invoice took back its stamp duty too.
    expect(row(jobs.B).creditNotes[0].amount).toBe(120);
  });

  it('names the payments the money can go back on, with what each can still return', async () => {
    const { world, jobs, payments } = owing();
    const answer = await world.svc.finance.refundsDue('ACCOUNTANT');
    const row = answer.items.find((item: any) => item.interventionId === jobs.A.id);

    expect(row.payments).toEqual([{ id: payments.A.id, method: 'BANK_TRANSFER', status: 'PAID', amount: 239, refundable: 239, confirmedAt: at('2026-10-11T08:00:00Z') }]);
  });

  it('does not list a job once the money was given back, in part or in full', async () => {
    const { world, jobs, payments } = owing();

    await world.prisma.payment.update({ where: { id: payments.A.id }, data: { status: 'PARTIALLY_REFUNDED', amountRefunded: 100 } });

    const answer = await world.svc.finance.refundsDue('ACCOUNTANT');

    expect(answer.items.find((item: any) => item.interventionId === jobs.A.id)).toBeUndefined();
  });

  it('lists a job whose refund was only part of what is due, with what is left', async () => {
    const { world, jobs, payments } = owing();

    await world.prisma.payment.update({ where: { id: payments.B.id }, data: { status: 'PARTIALLY_REFUNDED', amountRefunded: 50 } });

    const row = (await world.svc.finance.refundsDue('ACCOUNTANT')).items.find((item: any) => item.interventionId === jobs.B.id);

    expect(row).toMatchObject({ kept: 70, due: 70 });
    expect(row.payments[0].refundable).toBe(70);
  });

  it('is the figure the week\'s totals show', async () => {
    const { world } = owing();
    const summary = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);

    expect(summary.refundsDue).toEqual({ count: 3, amount: 240 });
  });

  it('is empty when no credit note was ever issued', async () => {
    const world = emptyWorld();

    expect(await world.svc.finance.refundsDue('ADMIN')).toEqual({ items: [], total: 0, amount: 0 });
  });
});

describe('who may read the finance console (P2-08)', () => {
  beforeEach(() => resetLocale());

  const calls: Array<[string, (world: World, role: string) => Promise<unknown>]> = [
    ['summary', (world, role) => world.svc.finance.summary(role, WEEK, NOW)],
    ['payments', (world, role) => world.svc.finance.listPayments(role, {}, NOW)],
    ['export', (world, role) => world.svc.finance.exportPayments(role, {}, NOW)],
    ['invoices', (world, role) => world.svc.finance.listInvoices(role, {}, NOW)],
    ['refunds due', (world, role) => world.svc.finance.refundsDue(role)],
  ];

  it('is for the administrators and the accountant', async () => {
    const { world } = book();

    for (const [, call] of calls) {
      for (const role of ['ADMIN', 'SUPER_ADMIN', 'ACCOUNTANT']) expect(await refusal(() => call(world, role))).toBeNull();
    }
  });

  it('is not for support, dispatchers, customers or artisans, and the refusal is a 403', async () => {
    const { world } = book();

    for (const [name, call] of calls) {
      for (const role of ['SUPPORT', 'DISPATCHER', 'CLIENT', 'ARTISAN']) {
        const refused = await refusal(() => call(world, role));

        expect(refused === null ? `${name}/${role} answered` : refused.status).toBe(403);
      }
    }
  });
});

describe('the finance routes (P2-08)', () => {
  const controller = fs.readFileSync(path.join(__dirname, 'finance.controller.ts'), 'utf8');
  const dto = fs.readFileSync(path.join(__dirname, 'dto/finance.dto.ts'), 'utf8');
  const routes = scanController(controller, TICKET_STAFF_ROLES);

  it('are the five reads, each for the administrators and the accountant, with the guard that enforces it', () => {
    expect(routes.map((route) => routeKey(route.method, route.path)).sort()).toEqual(['GET /finance/invoices', 'GET /finance/payments', 'GET /finance/payments/export', 'GET /finance/refunds-due', 'GET /finance/summary']);

    for (const route of routes) {
      expect([...route.roles].sort()).toEqual(['ACCOUNTANT', 'ADMIN', 'SUPER_ADMIN']);
      expect(route.rolesEnforced).toBe(true);
    }
  });

  it('write nothing: no route of the module changes a row', () => {
    expect(controller).not.toMatch(/@(Post|Patch|Put|Delete)\(/);
  });

  it('check each field with its own decorators (class-validator reads them), field by field', () => {
    const decorators = (cls: string, prop: string): string[] => {
      const body = new RegExp(`export class ${cls}[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(dto)?.[1] ?? '';
      const found = new RegExp(`((?:\\n\\s*@[^\\n]+)+)\\n\\s*${prop}\\?:`).exec(body)?.[1] ?? '';

      return found.split('\n').map((text) => text.trim()).filter(Boolean);
    };
    const day = ['@IsOptional()', '@IsString()', '@Matches(DAY, { message: DAY_WORDS })'];
    const search = ['@IsOptional()', '@IsString()', '@MaxLength(100)'];

    expect(decorators('FinancePeriodQueryDto', 'from')).toEqual(day);
    expect(decorators('FinancePeriodQueryDto', 'to')).toEqual(day);
    expect(decorators('FinancePageQueryDto', 'page')).toEqual(['@IsOptional()', '@Type(() => Number)', '@IsInt()', '@Min(1)', '@Max(100_000)']);
    expect(decorators('FinancePageQueryDto', 'limit')).toEqual(['@IsOptional()', '@Type(() => Number)', '@IsInt()', '@Min(1)', '@Max(100)']);
    expect(decorators('FinancePageQueryDto', 'search')).toEqual(search);
    expect(decorators('FinancePaymentsQueryDto', 'view')).toEqual(['@IsOptional()', '@IsIn(PAYMENT_VIEWS)']);
    expect(decorators('FinancePaymentsQueryDto', 'status')).toEqual(['@IsOptional()', '@IsEnum(PaymentStatus)']);
    expect(decorators('FinancePaymentsQueryDto', 'method')).toEqual(['@IsOptional()', '@IsEnum(PaymentMethod)']);
    expect(decorators('FinancePaymentsQueryDto', 'sort')).toEqual(['@IsOptional()', '@IsIn(PAYMENT_SORTS)']);
    expect(decorators('FinanceInvoicesQueryDto', 'view')).toEqual(['@IsOptional()', '@IsIn(INVOICE_VIEWS)']);
    expect(decorators('FinanceInvoicesQueryDto', 'status')).toEqual(['@IsOptional()', '@IsEnum(InvoiceStatus)']);
    expect(decorators('FinancePaymentsExportQueryDto', 'view')).toEqual(['@IsOptional()', '@IsIn(PAYMENT_VIEWS)']);
    expect(decorators('FinancePaymentsExportQueryDto', 'status')).toEqual(['@IsOptional()', '@IsEnum(PaymentStatus)']);
    expect(decorators('FinancePaymentsExportQueryDto', 'method')).toEqual(['@IsOptional()', '@IsEnum(PaymentMethod)']);
    expect(decorators('FinancePaymentsExportQueryDto', 'search')).toEqual(search);
  });

  it('check the dates, the page and the filters before the service sees them (class-validator reads these decorators)', () => {
    expect(dto).toMatch(/const DAY = \/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/;/);
    expect((dto.match(/@Matches\(DAY, \{ message: DAY_WORDS \}\)/g) ?? []).length).toBe(2);
    expect(dto).toContain('@Max(100)');
    expect(dto).toContain('@Max(100_000)');
    expect(dto).toContain('@MaxLength(100)');
    expect(dto).toContain('@IsIn(PAYMENT_VIEWS)');
    expect(dto).toContain('@IsIn(PAYMENT_SORTS)');
    expect(dto).toContain('@IsIn(INVOICE_VIEWS)');
    expect(dto).toContain('@IsEnum(PaymentStatus)');
    expect(dto).toContain('@IsEnum(PaymentMethod)');
    expect(dto).toContain('@IsEnum(InvoiceStatus)');
  });

  it('take the filters of the list on the export and none of its paging', () => {
    const body = /export class FinancePaymentsExportQueryDto[^{]*\{([\s\S]*?)\n\}/.exec(dto)?.[1] ?? '';

    expect(body).toContain('view?: string;');
    expect(body).toContain('search?: string;');
    expect(body).not.toContain('page?');
    expect(body).not.toContain('limit?');
  });

  it('send the file with its name, and the CORS headers let a page on another address read it', () => {
    expect(controller).toContain("res.setHeader('Content-Type', file.contentType);");
    expect(controller).toContain("res.setHeader('Content-Disposition', `attachment; filename=\"${file.filename}\"`);");
    expect(stripComments(readSource('main.ts'))).toContain("exposedHeaders: ['Content-Disposition']");
  });
});

// ---------------------------------------------------------------------------------------------------------------- the edges

/** Plants more rows on the book of the week and compares the answer before and after: what must move moves, and nothing else does. */
const plantPayment = (world: World, data: Record<string, any>) => world.memory.plant('payment', { provider: 'MANUAL', currency: 'TND', amountRefunded: 0, ...data });

/** `count` copies of a planted row, added to its table without the checks of `plant` (which take a quadratic time on a table of 50,000 rows). */
function plantCopies(world: World, model: string, sample: Record<string, any>, count: number, change: (copy: Record<string, any>, index: number) => void = () => undefined): void {
  const table = world.memory.rows(model);
  let id = table.reduce((highest: number, entry: Record<string, any>) => Math.max(highest, Number(entry.id ?? 0)), 0);

  for (let index = 0; index < count; index += 1) {
    id += 1;

    const copy = { ...sample, id };

    change(copy, index);
    table.push(copy);
  }
}

describe('the edges of the totals of a week (P2-08)', () => {
  beforeEach(() => resetLocale());

  it('counts money received by the day it was confirmed, not by the day it was asked for', async () => {
    const { world, ids } = book();
    const before = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);
    const listBefore = await world.svc.finance.listPayments('ACCOUNTANT', { view: 'received', ...WEEK, limit: 100 }, NOW);

    // Asked for on the 1st and confirmed on the 22nd: in the week. Asked for in the week and confirmed on the 28th: not in it.
    plantPayment(world, { interventionId: ids.job1, method: 'ONLINE_CARD', status: 'PAID', amount: 13, requestedAt: at('2026-10-01T09:00:00Z'), confirmedAt: at('2026-10-22T09:00:00Z') });
    plantPayment(world, { interventionId: ids.job1, method: 'ONLINE_CARD', status: 'PAID', amount: 17, requestedAt: at('2026-10-20T09:00:00Z'), confirmedAt: at('2026-10-28T09:00:00Z') });

    const after = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);
    const listAfter = await world.svc.finance.listPayments('ACCOUNTANT', { view: 'received', ...WEEK, limit: 100 }, NOW);

    expect(after.received.count).toBe(before.received.count + 1);
    expect(after.received.amount).toBe(before.received.amount + 13);
    expect(after.days[3].received).toBe(before.days[3].received + 13);
    expect(after.received.byMethod.find((entry: any) => entry.method === 'ONLINE_CARD')).toEqual({ method: 'ONLINE_CARD', count: 2, amount: 93 });
    expect(listAfter.total).toBe(listBefore.total + 1);
    expect(listAfter.amount).toBe(listBefore.amount + 13);
  });

  it('reads every payment of the week, however many there are', async () => {
    const { world, ids } = book();
    const before = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);

    for (let index = 0; index < 12; index += 1) plantPayment(world, { interventionId: ids.job1, method: 'CASH', provider: 'CASH', status: 'PAID', amount: 2, confirmedAt: at('2026-10-22T09:00:00Z'), requestedAt: at('2026-10-22T09:00:00Z') });

    const after = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);

    expect(after.received.count).toBe(before.received.count + 12);
    expect(after.received.amount).toBe(before.received.amount + 24);
    expect(after.days[3].count).toBe(before.days[3].count + 12);
  });

  it('refuses to build an answer from more rows than it can hold in memory, and says to choose a shorter period', () => {
    expect(() => tooMany(new Array(SUMMARY_LIMIT).fill(0), 'paiements')).not.toThrow();
    expect(() => tooMany(new Array(SUMMARY_LIMIT + 1).fill(0), 'paiements')).toThrow(/Trop de paiements/);
    expect(() => tooMany([], 'paiements')).not.toThrow();
  });

  it('does not tell to choose a shorter period for the figures that have no period: they are what waits, whatever the date', () => {
    expect(() => tooMany(new Array(SUMMARY_LIMIT + 1).fill(0), 'avoirs', false)).toThrow(/prévenez l’équipe technique/);

    let message = '';

    try {
      tooMany(new Array(SUMMARY_LIMIT + 1).fill(0), 'avoirs', false);
    } catch (error) {
      message = String((error as Error).message);
    }

    expect(message).not.toContain('période');
    expect(() => tooMany(new Array(SUMMARY_LIMIT + 1).fill(0), 'paiements reçus')).toThrow(/période plus courte/);
  });

  it('adds up the refunds of one day, and puts a refund made after midnight in Tunis on the next day', async () => {
    const { world, ids } = book();
    const before = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);

    // 23:30 UTC on the 21st is 00:30 on the 22nd in Tunis; and a second refund on the 21st, next to the 30 already there.
    plantPayment(world, { interventionId: ids.job1, method: 'ONLINE_CARD', status: 'PARTIALLY_REFUNDED', amount: 50, amountRefunded: 12, confirmedAt: at('2026-10-10T09:00:00Z'), refundedAt: at('2026-10-21T23:30:00Z') });
    plantPayment(world, { interventionId: ids.job1, method: 'ONLINE_CARD', status: 'PARTIALLY_REFUNDED', amount: 20, amountRefunded: 4, confirmedAt: at('2026-10-10T09:00:00Z'), refundedAt: at('2026-10-21T15:00:00Z') });

    const after = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);

    expect(after.days[2].refunded).toBe(before.days[2].refunded + 4);
    expect(after.days[3].refunded).toBe(before.days[3].refunded + 12);
    expect(after.refunded).toEqual({ count: before.refunded.count + 2, amount: before.refunded.amount + 16 });
    expect(after.net).toBe(before.net - 16);
  });

  it('leaves out of the totals everything in another currency than the company\'s, and counts the unpaid invoices of it without adding them up', async () => {
    const { world, ids, inv } = book();
    const before = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);

    plantPayment(world, { interventionId: ids.job1, method: 'CASH', provider: 'CASH', status: 'PENDING', amount: 9, currency: 'EUR', requestedAt: at('2026-10-20T08:00:00Z') });
    plantPayment(world, { interventionId: ids.job1, method: 'ONLINE_CARD', status: 'REFUNDED', amount: 20, amountRefunded: 20, currency: 'EUR', confirmedAt: at('2026-10-20T09:00:00Z'), refundedAt: at('2026-10-22T09:00:00Z') });
    world.memory.plant('creditNote', { invoiceId: inv.inv1.id, interventionId: ids.job1, creditNoteNumber: 'AV-2026-0090', numberYear: 2026, sequence: 90, reason: 'Euro', currency: 'EUR', amountHT: 0, taxRate: 19, taxAmount: 0, amountTTC: 40, stampDuty: 1, issuedAt: at('2026-10-22T08:00:00Z') });
    world.memory.plant('invoice', { interventionId: ids.job3, currency: 'EUR', invoiceNumber: 'F-2026-0090', status: 'ISSUED', amountHT: 0, taxAmount: 0, amountTTC: 500, stampDuty: 1, creditedAmount: 0, issuedAt: at('2026-10-22T08:00:00Z') });
    world.memory.plant('artisanPayout', { artisanId: ids.artisan, currency: 'EUR', status: 'PENDING', netAmount: 11 });
    world.memory.plant('artisanPayout', { artisanId: ids.artisan, currency: 'EUR', status: 'PAID', netAmount: 13, paidAt: at('2026-10-22T12:00:00Z') });

    const after = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);

    expect(after.awaiting).toEqual(before.awaiting);
    expect(after.refunded).toEqual(before.refunded);
    expect(after.invoices.issued).toEqual(before.invoices.issued);
    expect(after.invoices.creditNotes).toEqual(before.invoices.creditNotes);
    expect(after.invoices.unpaid).toEqual({ count: before.invoices.unpaid.count + 1, left: before.invoices.unpaid.left });
    expect(after.payouts).toEqual(before.payouts);
  });

  it('counts as issued an invoice that stands: not a draft and not a cancelled one, whatever date they carry', async () => {
    const { world, ids } = book();
    const before = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);
    const invoice = (data: Record<string, any>) => world.memory.plant('invoice', { interventionId: ids.job3, currency: 'TND', amountHT: 0, taxAmount: 0, amountTTC: 10, stampDuty: 1, creditedAmount: 0, issuedAt: at('2026-10-22T08:00:00Z'), ...data });

    invoice({ invoiceNumber: 'F-2026-0091', status: 'DRAFT' });
    invoice({ invoiceNumber: 'F-2026-0092', status: 'CANCELLED', cancelReason: 'Erreur' });
    invoice({ invoiceNumber: 'F-2026-0093', status: 'SENT', amountTTC: 19, stampDuty: 1 });

    const after = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);

    // only the sent one is new: 19 + 1; and it is out and unpaid, with 55 held on its job (job 3) against its 20.
    expect(after.invoices.issued).toEqual({ count: before.invoices.issued.count + 1, total: before.invoices.issued.total + 20 });
    expect(after.invoices.unpaid.count).toBe(before.invoices.unpaid.count + 1);
    expect(after.invoices.unpaid.left).toBe(before.invoices.unpaid.left);
  });

  it('counts the credit notes of the week by the day they were issued, with their stamp duty, and not the ones of another week', async () => {
    const { world, ids, inv } = book();
    const before = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);
    const note = (sequence: number, issuedAt: string, amountTTC: number, stampDuty: number) =>
      world.memory.plant('creditNote', { invoiceId: inv.inv1.id, interventionId: ids.job1, creditNoteNumber: `AV-2026-${String(sequence).padStart(4, '0')}`, numberYear: 2026, sequence, reason: 'Test', currency: 'TND', amountHT: 0, taxRate: 19, taxAmount: 0, amountTTC, stampDuty, issuedAt: at(issuedAt) });

    note(90, '2026-09-02T08:00:00Z', 70, 1);
    note(91, '2026-10-22T08:00:00Z', 40, 1);

    const after = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);

    expect(after.invoices.creditNotes).toEqual({ count: before.invoices.creditNotes.count + 1, total: before.invoices.creditNotes.total + 41 });
  });

  it('counts the invoices that are out whether they were issued or sent, and an invoice paid over is not owed below zero', async () => {
    const { world, ids } = book();
    const before = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);
    const job = () => world.memory.plant('intervention', { clientId: ids.clientA, artisanId: ids.artisan, status: 'PAID', serviceType: 'PLOMBIER' });
    const invoice = (jobId: number, data: Record<string, any>) => world.memory.plant('invoice', { interventionId: jobId, currency: 'TND', amountHT: 0, taxAmount: 0, stampDuty: 1, creditedAmount: 0, issuedAt: at('2026-09-02T08:00:00Z'), ...data });
    const sent = job();
    const over = job();

    invoice(sent.id, { invoiceNumber: 'F-2026-0094', status: 'SENT', amountTTC: 19 });
    invoice(over.id, { invoiceNumber: 'F-2026-0095', status: 'ISSUED', amountTTC: 10 });
    plantPayment(world, { interventionId: over.id, method: 'ONLINE_CARD', status: 'PAID', amount: 50, confirmedAt: at('2026-09-02T09:00:00Z'), requestedAt: at('2026-09-02T09:00:00Z') });

    const after = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);

    expect(after.invoices.unpaid).toEqual({ count: before.invoices.unpaid.count + 2, left: before.invoices.unpaid.left + 20 });
  });

  it('counts the artisans who owe commission, not the ones who gave more than they owed', async () => {
    const { world } = book();
    const before = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);
    const third = world.memory.plant('user', { role: 'ARTISAN', name: 'Nizar' });

    world.memory.plant('cashLedgerEntry', { artisanId: third.id, type: 'COLLECTION', cashAmount: 10, commissionAmount: 2 });
    world.memory.plant('cashLedgerEntry', { artisanId: third.id, type: 'REMITTANCE', cashAmount: 0, commissionAmount: -30 });

    const after = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);

    expect(after.cash).toEqual({ artisansOwing: before.cash.artisansOwing, commissionOwed: before.cash.commissionOwed, cashCollected: before.cash.cashCollected + 10 });
  });

  it('counts as paid in the week only the payouts that are paid, and as open only the ones that wait', async () => {
    const { world, ids } = book();
    const before = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);

    world.memory.plant('artisanPayout', { artisanId: ids.artisan, currency: 'TND', status: 'CANCELLED', netAmount: 17, paidAt: at('2026-10-22T12:00:00Z') });
    world.memory.plant('artisanPayout', { artisanId: ids.artisan, currency: 'TND', status: 'FAILED', netAmount: 19 });

    const after = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);

    expect(after.payouts).toEqual(before.payouts);
  });
});

describe('the order of the totals by way of payment (P2-08)', () => {
  beforeEach(() => resetLocale());

  it('lists the ways of payment by name, whatever the order the payments came in, and counts every payment the team can decide', async () => {
    const world = emptyWorld();
    const client = world.memory.plant('user', { role: 'CLIENT', name: 'Client' });
    const job = world.memory.plant('intervention', { clientId: client.id, status: 'PAID', serviceType: 'PLOMBIER' });
    const paid = (method: string, amount: number) => plantPayment(world, { interventionId: job.id, method, status: 'PAID', amount, confirmedAt: at('2026-10-20T10:00:00Z'), requestedAt: at('2026-10-20T10:00:00Z') });
    const waiting = (method: string, amount: number, status = 'PENDING') => plantPayment(world, { interventionId: job.id, method, status, amount, requestedAt: at('2026-10-20T10:00:00Z') });

    paid('CASH', 10);
    paid('ONLINE_CARD', 20);
    paid('BANK_TRANSFER', 30);
    waiting('CASH', 1);
    waiting('ONLINE_CARD', 2, 'AWAITING_CONFIRMATION');
    waiting('BANK_TRANSFER', 4);
    waiting('CASH', 8);
    waiting('ONLINE_CARD', 16); // a card request nobody can pay: not in the queue

    const summary = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);

    expect(summary.received.byMethod.map((entry: any) => entry.method)).toEqual(['BANK_TRANSFER', 'CASH', 'ONLINE_CARD']);
    expect(summary.awaiting.byMethod).toEqual([
      { method: 'BANK_TRANSFER', count: 1, amount: 4 },
      { method: 'CASH', count: 2, amount: 9 },
      { method: 'ONLINE_CARD', count: 1, amount: 2 },
    ]);
    expect(summary.awaiting.count).toBe(4);
    expect(summary.awaiting.amount).toBe(15);
  });
});

describe('the edges of the lists (P2-08)', () => {
  beforeEach(() => resetLocale());

  it('tells whether the period was asked for, and gives a page count of one for a list with nothing in it', async () => {
    const { world } = book();
    const named = await world.svc.finance.listPayments('ACCOUNTANT', { ...WEEK }, NOW);
    const unnamed = await world.svc.finance.listPayments('ACCOUNTANT', {}, NOW);
    const none = await world.svc.finance.listPayments('ACCOUNTANT', { view: 'received', from: '2026-01-01', to: '2026-01-07' }, NOW);
    const invoices = await world.svc.finance.listInvoices('ACCOUNTANT', { from: '2026-01-01', to: '2026-01-07' }, NOW);

    expect(named.period).toEqual({ from: '2026-10-19', to: '2026-10-25', explicit: true, applied: true });
    expect(unnamed.period).toMatchObject({ explicit: false, applied: false });
    expect([none.total, none.pages, none.items]).toEqual([0, 1, []]);
    expect([invoices.total, invoices.pages, invoices.items]).toEqual([0, 1, []]);
    expect((await world.svc.finance.listInvoices('ACCOUNTANT', { ...WEEK }, NOW)).period.explicit).toBe(true);
    expect((await world.svc.finance.listInvoices('ACCOUNTANT', {}, NOW)).period.explicit).toBe(false);
  });

  it('lists the credit notes of an invoice in the order they were issued', async () => {
    const { world, ids } = book();
    const job = world.memory.plant('intervention', { clientId: ids.clientA, artisanId: ids.artisan, status: 'PAID', serviceType: 'PLOMBIER' });
    const invoice = world.memory.plant('invoice', { interventionId: job.id, currency: 'TND', invoiceNumber: 'F-2026-0096', status: 'ISSUED', amountHT: 0, taxAmount: 0, amountTTC: 500, stampDuty: 1, creditedAmount: 60, issuedAt: at('2026-10-24T08:00:00Z') });
    const note = (sequence: number, issuedAt: string) =>
      world.memory.plant('creditNote', { invoiceId: invoice.id, interventionId: job.id, creditNoteNumber: `AV-2026-${String(sequence).padStart(4, '0')}`, numberYear: 2026, sequence, reason: `Avoir ${sequence}`, currency: 'TND', amountHT: 0, taxRate: 19, taxAmount: 0, amountTTC: 30, stampDuty: 0, issuedAt: at(issuedAt) });

    const first = note(81, '2026-10-24T09:00:00Z');
    const second = note(82, '2026-10-24T10:00:00Z');
    const row = (await world.svc.finance.listInvoices('ACCOUNTANT', { search: 'F-2026-0096' }, NOW)).items[0];

    expect(row.creditNotes.map((entry: any) => entry.id)).toEqual([first.id, second.id]);
  });

  it('breaks a tie between invoices issued at the same instant by putting the later number first, and adds up in dinars only', async () => {
    const { world, ids } = book();
    const before = await world.svc.finance.listInvoices('ACCOUNTANT', { ...WEEK }, NOW);
    const invoice = (number: string, data: Record<string, any> = {}) =>
      world.memory.plant('invoice', { interventionId: ids.job3, currency: 'TND', invoiceNumber: number, status: 'ISSUED', amountHT: 0, taxAmount: 0, amountTTC: 10, stampDuty: 1, creditedAmount: 0, issuedAt: at('2026-10-24T09:00:00Z'), ...data });

    const a = invoice('F-2026-0097');
    const b = invoice('F-2026-0098');

    invoice('F-2026-0099', { currency: 'EUR', amountTTC: 500 });

    const after = await world.svc.finance.listInvoices('ACCOUNTANT', { ...WEEK, limit: 100 }, NOW);

    expect(idsOf(after).filter((id: number) => id === a.id || id === b.id)).toEqual([b.id, a.id]);
    expect(after.amount).toBe(before.amount + 22);
  });
});

describe('the edges of the refunds that are due (P2-08)', () => {
  beforeEach(() => resetLocale());

  const plantJob = (world: any, client: any) => world.memory.plant('intervention', { clientId: client.id, status: 'PAID', serviceType: 'PLOMBIER' });
  const plantInvoice = (world: any, job: any, data: Record<string, any>) =>
    world.memory.plant('invoice', { interventionId: job.id, currency: 'TND', amountHT: 0, taxAmount: 0, stampDuty: 0, creditedAmount: 0, status: 'ISSUED', issuedAt: at('2026-10-10T08:00:00Z'), ...data });
  const plantNote = (world: any, invoice: any, sequence: number, issuedAt: string) =>
    world.memory.plant('creditNote', { invoiceId: invoice.id, interventionId: invoice.interventionId, creditNoteNumber: `AV-2026-${String(sequence).padStart(4, '0')}`, numberYear: 2026, sequence, reason: `Avoir ${sequence}`, currency: 'TND', amountHT: 0, taxRate: 19, taxAmount: 0, amountTTC: 10, stampDuty: 0, issuedAt: at(issuedAt) });
  const plantPaid = (world: any, job: any, amount: number, data: Record<string, any> = {}) =>
    plantPayment(world, { interventionId: job.id, method: 'BANK_TRANSFER', status: 'PAID', amount, confirmedAt: at('2026-10-11T08:00:00Z'), requestedAt: at('2026-10-11T08:00:00Z'), ...data });

  it('puts two jobs that have waited since the same moment in the order of their numbers', async () => {
    const { world, jobs, client } = owing();
    const p = plantJob(world, client);
    const q = plantJob(world, client);

    for (const job of [p, q]) {
      const invoice = plantInvoice(world, job, { invoiceNumber: `F-2026-02${job.id}`, amountTTC: 100 });

      plantNote(world, invoice, 40 + job.id, '2026-10-14T08:00:00Z');
      plantPaid(world, job, 150);
    }

    const answer = await world.svc.finance.refundsDue('ACCOUNTANT');

    expect(answer.items.map((row: any) => row.interventionId)).toEqual([jobs.B.id, p.id, q.id, jobs.A.id, jobs.C.id]);
  });

  it('tells every credit note of a job, in the order they were issued, and waits since the first of them', async () => {
    const { world, jobs, invoices } = owing();
    const later = plantNote(world, invoices.A, 60, '2026-10-25T08:00:00Z');
    const row = (await world.svc.finance.refundsDue('ACCOUNTANT')).items.find((item: any) => item.interventionId === jobs.A.id);

    expect(row.creditNotes).toHaveLength(2);
    expect(row.creditNotes[1].id).toBe(later.id);
    expect(row.creditNotes[0].issuedAt).toEqual(at('2026-10-15T08:00:00Z'));
    expect(row.since).toEqual(at('2026-10-15T08:00:00Z'));
  });

  it('sets the money held against the invoice that stands now: the latest one that is not cancelled or a draft', async () => {
    const { world, client } = owing();
    const job = plantJob(world, client);
    const old = plantInvoice(world, job, { invoiceNumber: 'F-2026-0301', amountTTC: 500 });
    const live = plantInvoice(world, job, { invoiceNumber: 'F-2026-0302', amountTTC: 100 });

    plantNote(world, old, 70, '2026-10-14T08:00:00Z');
    plantPaid(world, job, 150);

    const row = (await world.svc.finance.refundsDue('ACCOUNTANT')).items.find((item: any) => item.interventionId === job.id);

    expect(row).toMatchObject({ kept: 150, owed: 100, due: 50, invoice: { id: live.id, number: 'F-2026-0302' } });
  });

  it('offers to give back only money that was received, in the currency of the company', async () => {
    const { world, client } = owing();
    const job = plantJob(world, client);
    const closed = plantInvoice(world, job, { invoiceNumber: 'F-2026-0303', status: 'CANCELLED', amountTTC: 100, creditedAmount: 100 });

    plantNote(world, closed, 71, '2026-10-14T08:00:00Z');

    const good = plantPaid(world, job, 100);

    plantPaid(world, job, 80, { status: 'PENDING', confirmedAt: null });
    plantPaid(world, job, 70, { currency: 'EUR' });

    const row = (await world.svc.finance.refundsDue('ACCOUNTANT')).items.find((item: any) => item.interventionId === job.id);

    expect(row).toMatchObject({ kept: 100, due: 100 });
    expect(row.payments.map((payment: any) => [payment.id, payment.refundable])).toEqual([[good.id, 100]]);
  });
});

describe('what the reviews of the console found (P2-08)', () => {
  beforeEach(() => resetLocale());

  const job = (world: World, clientId: number) => world.memory.plant('intervention', { clientId, status: 'PAID', serviceType: 'PLOMBIER' });
  const invoiceOf = (world: World, jobId: number, data: Record<string, any>) =>
    world.memory.plant('invoice', { interventionId: jobId, currency: 'TND', amountHT: 0, taxAmount: 0, stampDuty: 1, creditedAmount: 0, status: 'ISSUED', ...data });
  const noteOf = (world: World, invoice: Record<string, any>, sequence: number, amountTTC: number, issuedAt: string, stampDuty = 0) =>
    world.memory.plant('creditNote', {
      invoiceId: invoice.id,
      interventionId: invoice.interventionId,
      creditNoteNumber: `AV-2026-${String(sequence).padStart(4, '0')}`,
      numberYear: 2026,
      sequence,
      reason: 'Erreur',
      currency: 'TND',
      amountHT: 0,
      taxRate: 19,
      taxAmount: 0,
      amountTTC,
      stampDuty,
      issuedAt: at(issuedAt),
    });

  describe('the invoices of the week and their credit notes', () => {
    it('counts as issued an invoice that a credit note closed, so that issued less credit notes is what the customers were asked for', async () => {
      const { world, ids } = book();
      const closed = invoiceOf(world, job(world, ids.clientA).id, { invoiceNumber: 'F-2026-0090', status: 'CANCELLED', amountTTC: 119, stampDuty: 1, creditedAmount: 120, issuedAt: at('2026-10-20T08:00:00Z'), cancelReason: 'Avoir AV-2026-0090' });

      noteOf(world, closed, 90, 119, '2026-10-21T08:00:00Z', 1);

      const { invoices } = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);

      // 359 from the book, and 120 closed; the credit notes: 100 from the book, and 120.
      expect(invoices.issued).toEqual({ count: 3, total: 479 });
      expect(invoices.creditNotes).toEqual({ count: 2, total: 220 });
      expect(invoices.issued.total - invoices.creditNotes.total).toBe(259);
    });

    it('does not count an invoice that the back office cancelled with nothing credited: it asks nothing and nothing offsets it', async () => {
      const { world, ids } = book();

      invoiceOf(world, job(world, ids.clientA).id, { invoiceNumber: 'F-2026-0091', status: 'CANCELLED', amountTTC: 500, creditedAmount: 0, issuedAt: at('2026-10-20T08:00:00Z'), cancelReason: 'Doublon' });

      expect((await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW)).invoices.issued).toEqual({ count: 2, total: 359 });
    });

    it('lists in the credited tab the invoices that had a credit note in the period, by the date of the credit note, however old the invoice', async () => {
      const { world, inv } = book();

      // The old invoice (issued on 1 September) is credited on the 22nd; F-0002 (issued on the 21st) was credited on the 23rd.
      noteOf(world, inv.old, 91, 10, '2026-10-22T08:00:00Z');
      await world.prisma.invoice.update({ where: { id: inv.old.id }, data: { creditedAmount: 10 } });

      const credited = (query: Record<string, any>) => world.svc.finance.listInvoices('ACCOUNTANT', { view: 'credited', ...query }, NOW);

      expect(idsOf(await credited(WEEK))).toEqual([inv.inv2.id, inv.old.id]);
      expect(idsOf(await credited({ from: '2026-10-22', to: '2026-10-22' }))).toEqual([inv.old.id]);
      // F-0002 was issued on the 21st, but its credit note is of the 23rd: the 21st is not the day of a credit note.
      expect(idsOf(await credited({ from: '2026-10-21', to: '2026-10-21' }))).toEqual([]);
      expect(idsOf(await credited({ from: '2026-10-23', to: '2026-10-23' }))).toEqual([inv.inv2.id]);
      expect(idsOf(await credited({}))).toEqual([inv.inv2.id, inv.old.id]);
      expect((await credited(WEEK)).period).toMatchObject({ explicit: true, applied: true });
    });

    it('has as many invoices in the credited tab as the summary has credit notes, when each invoice has one', async () => {
      const { world } = book();
      const summary = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);
      const credited = await world.svc.finance.listInvoices('ACCOUNTANT', { view: 'credited', ...WEEK }, NOW);

      expect(credited.total).toBe(summary.invoices.creditNotes.count);
    });

    it('shows the unpaid invoices whatever the period named, with the figure of the summary for what is left to pay', async () => {
      const { world, inv } = book();
      const page = await world.svc.finance.listInvoices('ACCOUNTANT', { view: 'unpaid', from: '2026-01-01', to: '2026-01-07' }, NOW);
      const { invoices } = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);

      expect(idsOf(page)).toEqual([inv.inv1.id, inv.old.id]);
      expect(page.total).toBe(invoices.unpaid.count);
      expect(page.amount).toBe(invoices.unpaid.left);
      expect(page.amount).toBe(45.5);
      expect(page.period).toMatchObject({ explicit: true, applied: false });
    });

    it('adds up in the other tabs what the invoices ask less their credit notes, the cancelled ones left out', async () => {
      const { world } = book();

      // F-0001: 120. F-0002: 239 less 100. The cancelled F-0004 and the draft are not in.
      expect((await world.svc.finance.listInvoices('ACCOUNTANT', WEEK, NOW)).amount).toBe(259);
      // The credited tab adds up what the credit notes took back (the summary's figure), not what is still asked.
      expect((await world.svc.finance.listInvoices('ACCOUNTANT', { view: 'credited', ...WEEK }, NOW)).amount).toBe(100);
    });

    it('narrows the unpaid sum with the search too, as the list is narrowed', async () => {
      const { world } = book();

      expect((await world.svc.finance.listInvoices('ACCOUNTANT', { view: 'unpaid', search: 'F-2026-0005' }, NOW)).amount).toBe(5.5);
    });
  });

  describe('the sum under each payments tab', () => {
    it('is what is asked in the waiting tab, what came in in the received tab, what went back in the refunded tab, and nothing in the tab of all', async () => {
      const { world } = book();
      const page = (query: Record<string, any>) => world.svc.finance.listPayments('ACCOUNTANT', query, NOW);

      expect((await page({ view: 'awaiting', ...WEEK })).amount).toBe(350);
      expect((await page({ view: 'received', ...WEEK })).amount).toBe(455);
      // E gave back 100 of 300; L gave back all of its 30.
      expect((await page({ view: 'refunded', ...WEEK })).amount).toBe(130);
      expect((await page({ view: 'all', ...WEEK })).amount).toBeNull();
      expect((await page({})).amount).toBeNull();
    });

    it('is the figure of the summary for the same week', async () => {
      const { world } = book();
      const summary = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);
      const refunded = await world.svc.finance.listPayments('ACCOUNTANT', { view: 'refunded', ...WEEK }, NOW);
      const received = await world.svc.finance.listPayments('ACCOUNTANT', { view: 'received', ...WEEK }, NOW);

      expect(refunded.amount).toBe(summary.refunded.amount);
      expect(received.amount).toBe(summary.received.amount);
    });

    it('counts all of a payment marked as refunded as given back, whatever refunded amount was written, as the summary does', async () => {
      const { world, ids } = book();

      // A refund in full whose refunded amount was never written (a payment from before partial refunds).
      const legacy = plantPayment(world, { interventionId: ids.job1, method: 'ONLINE_CARD', status: 'REFUNDED', amount: 40, amountRefunded: 0, confirmedAt: at('2026-10-10T09:00:00Z'), refundedAt: at('2026-10-22T09:00:00Z') });
      const page = await world.svc.finance.listPayments('ACCOUNTANT', { view: 'refunded', ...WEEK }, NOW);
      const summary = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);
      const row = page.items.find((item: any) => item.id === legacy.id);

      expect(row).toMatchObject({ amount: 40, amountRefunded: 40, refundable: 0 });
      expect(page.amount).toBe(170);
      expect(summary.refunded.amount).toBe(170);
    });

    it('writes the refunded amount of that payment in the file as the screen shows it, with the day of the refund', async () => {
      const { world, ids } = book();

      plantPayment(world, { interventionId: ids.job1, method: 'ONLINE_CARD', status: 'REFUNDED', amount: 40, amountRefunded: 0, confirmedAt: at('2026-10-10T09:00:00Z'), refundedAt: at('2026-10-22T09:00:00Z') });

      const text = (await world.svc.finance.exportPayments('ACCOUNTANT', { view: 'refunded', ...WEEK }, NOW)).buffer.toString('utf8');

      expect(text).toContain(';40,000;40,000;2026-10-22 10:00;TND;');
    });
  });

  describe('the waiting tab and the file', () => {
    it('writes the file of the waiting payments without the dates of the week, and says so in its name', async () => {
      const { world } = book();
      const file = await world.svc.finance.exportPayments('ACCOUNTANT', { view: 'awaiting', ...WEEK }, NOW);
      const lines = file.buffer.toString('utf8').split('\r\n').filter(Boolean);

      expect(file.filename).toBe('paiements-awaiting.csv');
      expect(lines).toHaveLength(3);
    });

    it('keeps the dates of the week in the name of the file of the other tabs', async () => {
      const { world } = book();

      expect((await world.svc.finance.exportPayments('ACCOUNTANT', { view: 'received', ...WEEK }, NOW)).filename).toBe('paiements-received-2026-10-19_2026-10-25.csv');
    });
  });

  describe('the search', () => {
    const search = async (world: World, text: string) => (await world.svc.finance.listPayments('ACCOUNTANT', { search: text }, NOW)).items.map((item: any) => item.id).sort((a: number, b: number) => a - b);

    it('finds a customer by the phone number however it is written, the way the queue of requests does', async () => {
      const { world, pay } = book();
      const clientA = [pay.A.id, pay.C.id, pay.F.id, pay.G.id, pay.H.id, pay.L.id].sort((a, b) => a - b);

      expect(await search(world, '20111222')).toEqual(clientA);
      expect(await search(world, '20 111 222')).toEqual(clientA);
      expect(await search(world, '+216 20 111 222')).toEqual(clientA);
      expect(await search(world, '+21620111222')).toEqual(clientA);
    });

    it('finds a customer kept with spaces by the digits, and one whose number is only kept as the account\'s key', async () => {
      const { world, ids } = book();
      const spaced = world.memory.plant('user', { role: 'CLIENT', name: 'Nour', phone: '+216 22 123 456' });
      const keyed = world.memory.plant('user', { role: 'CLIENT', name: 'Sami', phone: null, phoneKey: '21644555666' });
      const spacedPayment = plantPayment(world, { interventionId: job(world, spaced.id).id, method: 'CASH', status: 'PAID', amount: 9, confirmedAt: at('2026-10-20T09:00:00Z') });
      const keyedPayment = plantPayment(world, { interventionId: job(world, keyed.id).id, method: 'CASH', status: 'PAID', amount: 8, confirmedAt: at('2026-10-20T09:00:00Z') });

      expect(ids.job1).toBeGreaterThan(0);
      expect(await search(world, '22123456')).toEqual([spacedPayment.id]);
      expect(await search(world, '44 555 666')).toEqual([keyedPayment.id]);
      expect(await search(world, '+216 44555666')).toEqual([keyedPayment.id]);
    });

    it('finds an invoice by the phone written on it, however it is typed', async () => {
      const { world, inv } = book();
      const invoices = async (text: string) => (await world.svc.finance.listInvoices('ACCOUNTANT', { search: text }, NOW)).items.map((item: any) => item.id);

      expect(await invoices('55 333 444')).toEqual([inv.inv2.id]);
      expect(await invoices('+216 55333444')).toEqual([inv.inv2.id]);
    });

    it('takes a percent sign and an underscore as the letters they are, not as wildcards', async () => {
      const { world, ids } = book();
      const literal = plantPayment(world, { interventionId: ids.job1, method: 'BANK_TRANSFER', status: 'PAID', amount: 3, reference: 'VIR_50%', confirmedAt: at('2026-10-20T09:00:00Z') });
      const other = plantPayment(world, { interventionId: ids.job1, method: 'BANK_TRANSFER', status: 'PAID', amount: 3, reference: 'VIR-500', confirmedAt: at('2026-10-20T09:00:00Z') });

      expect(await search(world, '50%')).toEqual([literal.id]);
      expect(await search(world, 'VIR_')).toEqual([literal.id]);
      expect(await search(world, 'VIR-5')).toEqual([other.id]);
      expect(await search(world, '%')).toEqual([literal.id]);
      expect(await search(world, '_')).toEqual([literal.id]);
    });

    it('drops a NUL byte instead of handing it to the database, which would refuse it with an error 500', async () => {
      const { world, pay } = book();

      expect(await search(world, 'vir\u0000-777')).toEqual([pay.B.id]);
      expect((await world.svc.finance.listPayments('ACCOUNTANT', { search: '\u0000\u0000' }, NOW)).total).toBe(12);
    });
  });

  describe('the guard on the number of rows a total is built from', () => {
    const refusal = async (call: () => Promise<unknown>) => {
      try {
        await call();
      } catch (error) {
        return String((error as Error).message);
      }

      return '';
    };

    it('builds the week from as many received payments as the guard allows, and refuses one more, telling to choose a shorter period', async () => {
      const { world, ids } = book();
      const held = (await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW)).received.count + 1;
      const sample = plantPayment(world, { interventionId: ids.job1, method: 'ONLINE_CARD', status: 'PAID', amount: 1, confirmedAt: at('2026-10-22T09:00:00Z'), requestedAt: at('2026-10-22T09:00:00Z') });

      plantCopies(world, 'payment', sample, SUMMARY_LIMIT - held);

      expect((await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW)).received.count).toBe(SUMMARY_LIMIT);

      plantCopies(world, 'payment', sample, 1);

      const message = await refusal(() => world.svc.finance.summary('ACCOUNTANT', WEEK, NOW));

      expect(message).toMatch(/^Trop de paiements reçus pour un résumé/);
      expect(message).toContain('choisissez une période plus courte');
    });

    it('refuses a week with too many refunds, telling to choose a shorter period', async () => {
      const { world, ids } = book();

      const sample = plantPayment(world, { interventionId: ids.job1, method: 'ONLINE_CARD', status: 'PARTIALLY_REFUNDED', amount: 2, amountRefunded: 1, confirmedAt: at('2026-10-01T09:00:00Z'), requestedAt: at('2026-10-01T09:00:00Z'), refundedAt: at('2026-10-22T09:00:00Z') });

      plantCopies(world, 'payment', sample, SUMMARY_LIMIT);

      const message = await refusal(() => world.svc.finance.summary('ACCOUNTANT', WEEK, NOW));

      expect(message).toMatch(/^Trop de remboursements pour un résumé/);
      expect(message).toContain('choisissez une période plus courte');
    });

    it('refuses to add up too many unpaid invoices, and does not tell to cut a period they do not have', async () => {
      const { world, ids } = book();

      const sample = world.memory.plant('invoice', { interventionId: ids.job3, currency: 'TND', amountHT: 0, taxAmount: 0, stampDuty: 0, creditedAmount: 0, status: 'ISSUED', amountTTC: 1, invoiceNumber: 'F-X', issuedAt: at('2026-08-01T08:00:00Z') });

      plantCopies(world, 'invoice', sample, SUMMARY_LIMIT, (copy, index) => (copy.invoiceNumber = `F-X-${index}`));

      for (const call of [() => world.svc.finance.summary('ACCOUNTANT', WEEK, NOW), () => world.svc.finance.listInvoices('ACCOUNTANT', { view: 'unpaid' }, NOW)]) {
        const message = await refusal(call);

        expect(message).toMatch(/^Trop de factures impayées pour un résumé/);
        expect(message).toContain('prévenez l’équipe technique');
        expect(message).not.toContain('période');
      }
    });

    it('refuses to look for refunds among too many credit notes, and says it with the right article', async () => {
      const { world, inv } = book();
      const sample = world.memory.plant('creditNote', { invoiceId: inv.inv2.id, interventionId: inv.inv2.interventionId, creditNoteNumber: 'AV-X', numberYear: 2026, sequence: 100, reason: 'Remise', currency: 'TND', amountHT: 1, taxRate: 19, taxAmount: 0, amountTTC: 1, stampDuty: 0, issuedAt: at('2026-10-20T08:00:00Z') });

      plantCopies(world, 'creditNote', sample, SUMMARY_LIMIT, (copy, index) => {
        copy.creditNoteNumber = `AV-X-${index}`;
        copy.sequence = 101 + index;
      });

      for (const call of [() => world.svc.finance.refundsDue('ACCOUNTANT'), () => world.svc.finance.summary('ACCOUNTANT', WEEK, NOW)]) {
        const message = await refusal(call);

        expect(message).toMatch(/^Trop d’avoirs pour un résumé/);
        expect(message).toContain('prévenez l’équipe technique');
        expect(message).not.toContain('période');
      }
    });
  });

  describe('the cash that artisans declared on the payments of a page', () => {
    it('shows no declared cash on a payment that is not cash, whatever the ledger holds for it', async () => {
      const { world, pay, ids } = book();

      world.memory.plant('cashLedgerEntry', { artisanId: ids.artisan, type: 'COLLECTION', interventionId: ids.job2, paymentId: pay.B.id, cashAmount: 250, commissionAmount: 50, commissionRate: 20, currency: 'TND' });

      const page = await world.svc.finance.listPayments('ACCOUNTANT', { view: 'awaiting' }, NOW);

      expect(page.items.find((item: any) => item.id === pay.B.id).declared).toBeNull();
      expect(page.items.find((item: any) => item.id === pay.A.id).declared).toEqual({ artisanId: ids.artisan, amount: 100 });
    });

    it('reads the ledger lines of the cash payments of the page only, not the whole ledger', async () => {
      const { world, pay } = book();
      const delegate = (world.svc.finance as any).prisma.cashLedgerEntry;
      const original = delegate.findMany;
      const asked: any[] = [];

      delegate.findMany = (args: any) => {
        asked.push(args);

        return original.call(delegate, args);
      };

      await world.svc.finance.listPayments('ACCOUNTANT', { view: 'awaiting' }, NOW);
      delegate.findMany = original;

      expect(asked.length).toBeGreaterThan(0);
      expect(asked[0].where.type).toBe('COLLECTION');
      expect(asked[0].where.paymentId).toEqual({ in: [pay.A.id] });
    });
  });
});

describe('what the second reviews of the console found (P2-08)', () => {
  beforeEach(() => resetLocale());

  /** A job with a client, and a way to plant payments and invoices on it. */
  function desk() {
    const world = emptyWorld();
    const client = world.memory.plant('user', { role: 'CLIENT', name: 'Client' });
    const job = world.memory.plant('intervention', { clientId: client.id, status: 'PAID', serviceType: 'PLOMBIER' });
    const payment = (method: string, status: string, amount: number, requestedAt: string, more: Record<string, any> = {}) =>
      plantPayment(world, { interventionId: job.id, method, status, amount, requestedAt: at(requestedAt), ...more });

    return { world, job, payment };
  }

  describe('the payments that wait for the team', () => {
    it('leaves a card request that nobody can pay out of the count, the sum, the oldest date and the waiting list', async () => {
      const { world, payment } = desk();
      const placeholder = payment('ONLINE_CARD', 'PENDING', 500, '2026-09-01T08:00:00Z');
      const online = payment('ONLINE', 'PENDING', 300, '2026-09-02T08:00:00Z');
      const cash = payment('CASH', 'AWAITING_CONFIRMATION', 40, '2026-10-19T08:00:00Z');
      const transfer = payment('BANK_TRANSFER', 'PENDING', 60, '2026-10-20T08:00:00Z');

      const summary = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);

      expect(summary.awaiting.count).toBe(2);
      expect(summary.awaiting.amount).toBe(100);
      expect(summary.awaiting.oldestAt).toEqual(cash.requestedAt);
      expect(summary.awaiting.byMethod).toEqual([
        { method: 'BANK_TRANSFER', count: 1, amount: 60 },
        { method: 'CASH', count: 1, amount: 40 },
      ]);

      const waiting = await world.svc.finance.listPayments('ACCOUNTANT', { view: 'awaiting' }, NOW);

      expect(idsOf(waiting).sort()).toEqual([cash.id, transfer.id].sort());
      expect([waiting.total, waiting.amount]).toEqual([2, 100]);

      // It is still a payment: the list of all of them has it, and so do the filters of its method.
      expect(idsOf(await world.svc.finance.listPayments('ACCOUNTANT', {}, NOW)).sort()).toEqual([placeholder.id, online.id, cash.id, transfer.id].sort());
      expect(idsOf(await world.svc.finance.listPayments('ACCOUNTANT', { method: 'ONLINE_CARD' }, NOW))).toEqual([placeholder.id]);
    });

    it('keeps in the queue a payment that someone declared paid, whatever its way of payment, and a transfer or cash that was asked for first', async () => {
      const { world, payment } = desk();
      const declared = payment('ONLINE_CARD', 'AWAITING_CONFIRMATION', 25, '2026-10-20T08:00:00Z');
      const cash = payment('CASH', 'PENDING', 15, '2026-10-21T08:00:00Z');
      const transfer = payment('BANK_TRANSFER', 'AWAITING_CONFIRMATION', 10, '2026-10-22T08:00:00Z');

      payment('CASH', 'FAILED', 99, '2026-10-20T08:00:00Z');
      payment('BANK_TRANSFER', 'CANCELLED', 98, '2026-10-20T08:00:00Z');
      payment('CASH', 'PAID', 97, '2026-10-20T08:00:00Z', { confirmedAt: at('2026-10-20T09:00:00Z') });

      const summary = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);

      expect([summary.awaiting.count, summary.awaiting.amount]).toEqual([3, 50]);
      expect(idsOf(await world.svc.finance.listPayments('ACCOUNTANT', { view: 'awaiting' }, NOW)).sort()).toEqual([declared.id, cash.id, transfer.id].sort());
    });

    it('writes the same queue in the file of the waiting payments as the list shows', async () => {
      const { world, payment } = desk();
      const cash = payment('CASH', 'AWAITING_CONFIRMATION', 40, '2026-10-19T08:00:00Z');

      payment('ONLINE_CARD', 'PENDING', 500, '2026-09-01T08:00:00Z');

      const lines = (await world.svc.finance.exportPayments('ACCOUNTANT', { view: 'awaiting' }, NOW)).buffer.toString('utf8').split('\r\n').slice(1).filter(Boolean);

      expect(lines.map((line) => Number(line.split(';')[0]))).toEqual([cash.id]);
    });

    it('does not count a card request in the tab of the payments to confirm when the way of payment filter asks for cards', async () => {
      const { world, payment } = desk();

      payment('ONLINE_CARD', 'PENDING', 500, '2026-09-01T08:00:00Z');

      const page = await world.svc.finance.listPayments('ACCOUNTANT', { view: 'awaiting', method: 'ONLINE_CARD' }, NOW);

      expect([page.total, page.items, page.amount]).toEqual([0, [], 0]);
    });
  });

  describe('the credited invoices', () => {
    function credited(creditedOnClosed = 119) {
      const { world, job } = desk();
      const closed = world.memory.plant('invoice', { interventionId: job.id, currency: 'TND', amountHT: 100, taxAmount: 19, stampDuty: 1, creditedAmount: creditedOnClosed, status: 'CANCELLED', invoiceNumber: 'F-C-1', issuedAt: at('2026-10-05T08:00:00Z') });
      const open = world.memory.plant('invoice', { interventionId: job.id, currency: 'TND', amountHT: 200, taxAmount: 38, stampDuty: 1, creditedAmount: 50, status: 'ISSUED', invoiceNumber: 'F-C-2', issuedAt: at('2026-10-06T08:00:00Z') });
      const note = (invoice: Record<string, any>, sequence: number, amountTTC: number, stampDuty: number, issuedAt: string, currency = 'TND') =>
        world.memory.plant('creditNote', { invoiceId: invoice.id, interventionId: job.id, creditNoteNumber: `AV-C-${sequence}`, numberYear: 2026, sequence, reason: 'Erreur', currency, amountHT: 0, taxRate: 19, taxAmount: 0, amountTTC, stampDuty, issuedAt: at(issuedAt) });

      return { world, closed, open, note };
    }

    it('adds up what the credit notes took back, so that an invoice they closed does not show 0', async () => {
      const { world, closed, note } = credited();

      note(closed, 1, 119, 1, '2026-10-21T08:00:00Z');

      const page = await world.svc.finance.listInvoices('ACCOUNTANT', { view: 'credited', ...WEEK }, NOW);
      const summary = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);

      expect(idsOf(page)).toEqual([closed.id]);
      expect(page.amount).toBe(120);
      expect([page.total, page.amount]).toEqual([summary.invoices.creditNotes.count, summary.invoices.creditNotes.total]);
    });

    it('counts only the credit notes of the days chosen, however many an invoice has, and all of them when no days are chosen', async () => {
      const { world, open, note } = credited(0);

      note(open, 1, 30, 0, '2026-10-20T08:00:00Z');
      note(open, 2, 20, 0, '2026-10-12T08:00:00Z');

      const week = await world.svc.finance.listInvoices('ACCOUNTANT', { view: 'credited', ...WEEK }, NOW);
      const before = await world.svc.finance.listInvoices('ACCOUNTANT', { view: 'credited', from: '2026-10-12', to: '2026-10-18' }, NOW);
      const all = await world.svc.finance.listInvoices('ACCOUNTANT', { view: 'credited' }, NOW);

      expect([week.total, week.amount]).toEqual([1, 30]);
      expect([before.total, before.amount]).toEqual([1, 20]);
      expect([all.total, all.amount]).toEqual([1, 50]);
      expect(idsOf(await world.svc.finance.listInvoices('ACCOUNTANT', { view: 'credited', from: '2026-09-01', to: '2026-09-07' }, NOW))).toEqual([]);
      expect((await world.svc.finance.listInvoices('ACCOUNTANT', { view: 'credited', from: '2026-09-01', to: '2026-09-07' }, NOW)).amount).toBe(0);
    });

    it('does not add a credit note of another currency, a credit note on the edge of the days, or the invoices left out by the filters of the list', async () => {
      const { world, closed, open, note } = credited();

      note(closed, 1, 119, 1, '2026-10-21T08:00:00Z');
      note(open, 2, 40, 1, '2026-10-21T09:00:00Z', 'EUR');
      note(open, 3, 7, 0, '2026-10-24T23:00:00.000Z'); // 25 October 00:00 in Tunis: inside the week
      note(open, 4, 9, 0, '2026-10-25T23:00:00.000Z'); // 26 October 00:00 in Tunis: the week is over
      note(open, 5, 3, 0, '2026-10-18T23:00:00.000Z'); // 19 October 00:00 in Tunis: the first instant of the week
      note(open, 6, 2, 0, '2026-10-18T22:59:59.999Z'); // the last instant of the week before

      const week = await world.svc.finance.listInvoices('ACCOUNTANT', { view: 'credited', ...WEEK }, NOW);
      const onlyClosed = await world.svc.finance.listInvoices('ACCOUNTANT', { view: 'credited', status: 'CANCELLED', ...WEEK }, NOW);
      const searched = await world.svc.finance.listInvoices('ACCOUNTANT', { view: 'credited', search: 'F-C-2', ...WEEK }, NOW);

      expect(week.amount).toBe(130); // 120 + 7 + 3
      expect(onlyClosed.amount).toBe(120);
      expect(searched.amount).toBe(10); // 7 + 3
    });

    it('does not add a credit note that has no date when days are chosen, as the list does not find an invoice by it', async () => {
      const { world, open, note } = credited();

      note(open, 1, 30, 0, '2026-10-20T08:00:00Z');
      world.memory.plant('creditNote', { invoiceId: open.id, interventionId: open.interventionId, creditNoteNumber: 'AV-C-9', numberYear: 2026, sequence: 9, reason: 'Sans date', currency: 'TND', amountHT: 0, taxRate: 19, taxAmount: 0, amountTTC: 11, stampDuty: 0, issuedAt: null });

      expect((await world.svc.finance.listInvoices('ACCOUNTANT', { view: 'credited', ...WEEK }, NOW)).amount).toBe(30);
      expect((await world.svc.finance.listInvoices('ACCOUNTANT', { view: 'credited' }, NOW)).amount).toBe(41);
    });

    it('adds up the credit notes of as many invoices as the guard allows', async () => {
      const { world, closed, note } = credited();

      note(closed, 1, 119, 1, '2026-10-21T08:00:00Z');
      plantCopies(world, 'invoice', { ...closed, creditNotes: undefined }, SUMMARY_LIMIT - 2, (copy, index) => (copy.invoiceNumber = `F-X-${index}`));

      // the closed invoice, the open one and SUMMARY_LIMIT - 2 copies: SUMMARY_LIMIT invoices in all, none of the copies with a credit note
      const page = await world.svc.finance.listInvoices('ACCOUNTANT', { view: 'credited' }, NOW);

      expect(page.total).toBe(SUMMARY_LIMIT);
      expect(page.amount).toBe(120);
    });

    it('refuses to add up the credit notes of too many invoices, and says it is a matter for the technical team', async () => {
      const { world, closed } = credited();

      plantCopies(world, 'invoice', closed, SUMMARY_LIMIT, (copy, index) => (copy.invoiceNumber = `F-X-${index}`));

      const failure = await refusal(() => world.svc.finance.listInvoices('ACCOUNTANT', { view: 'credited' }, NOW));

      expect(failure?.status).toBe(400);
      expect(failure?.message).toMatch(/^Trop de factures pour un résumé/);
      expect(failure?.message).toContain('prévenez l’équipe technique');
    });
  });
});

describe('the refunds that a complaint accepted (P2-09)', () => {
  beforeEach(() => resetLocale());

  /** A job that holds 120 received on one payment, with a complaint of the given decision. */
  function accepted(promised: number | null, decision = 'APPROVED') {
    const { world, client, jobs } = owing();
    const m = world.memory;
    const job = m.plant('intervention', { clientId: client.id, status: 'PAID', serviceType: 'PLOMBIER' });
    const payment = plantPayment(world, { interventionId: job.id, method: 'BANK_TRANSFER', status: 'PAID', amount: 120, confirmedAt: at('2026-10-11T08:00:00Z'), requestedAt: at('2026-10-11T08:00:00Z') });
    const complaint = (data: Record<string, any> = {}) =>
      m.plant('complaint', { interventionId: job.id, userId: client.id, title: 'Fuite', description: 'Toujours là', status: 'REFUNDED', refundRequested: true, refundDecision: decision, refundApproved: true, refundAmount: promised, refundDecidedAt: at('2026-10-22T08:00:00Z'), ...data });

    return { world, m, client, job, payment, jobs, complaint: complaint(), another: complaint };
  }

  const rowOf = async (world: World, job: any) => (await world.svc.finance.refundsDue('ACCOUNTANT')).items.find((item: any) => item.interventionId === job.id);

  it('lists a refund that was accepted for an amount and has not gone back, as what the complaint still lacks', async () => {
    const { world, job, complaint, payment } = accepted(50);
    const row = await rowOf(world, job);

    expect(row).toMatchObject({ kept: 120, fromCreditNotes: 0, fromComplaints: 50, due: 50, creditNotes: [] });
    expect(row.complaints).toEqual([{ id: complaint.id, title: 'Fuite', accepted: 50, remaining: 50, decidedAt: at('2026-10-22T08:00:00Z') }]);
    expect(row.payments.map((entry: any) => [entry.id, entry.refundable])).toEqual([[payment.id, 120]]);
  });

  it('lists it when there is no credit note at all: the complaint alone is a reason to give money back', async () => {
    const { world, job } = accepted(50);

    world.clear('creditNote');

    const page = await world.svc.finance.refundsDue('ACCOUNTANT');

    expect(page.items.map((item: any) => [item.interventionId, item.fromCreditNotes, item.fromComplaints, item.due])).toEqual([[job.id, 0, 50, 50]]);
  });

  it('subtracts what already went back on the job: the refund that reaches the amount settles the complaint', async () => {
    const { world, job, payment } = accepted(50);

    await world.prisma.payment.update({ where: { id: payment.id }, data: { status: 'PARTIALLY_REFUNDED', amountRefunded: 30 } });
    expect(await rowOf(world, job)).toMatchObject({ fromComplaints: 20, due: 20, kept: 90 });

    await world.prisma.payment.update({ where: { id: payment.id }, data: { status: 'PARTIALLY_REFUNDED', amountRefunded: 50 } });
    expect(await rowOf(world, job)).toBeUndefined();

    await world.prisma.payment.update({ where: { id: payment.id }, data: { status: 'PARTIALLY_REFUNDED', amountRefunded: 80 } });
    expect(await rowOf(world, job)).toBeUndefined();
  });

  it('lists, among the complaints of a job, only those that still lack money, and dates the line from them', async () => {
    const { world, job, payment, complaint, another } = accepted(50);
    const small = another({ title: 'Petit geste', refundAmount: 20, refundDecidedAt: at('2026-10-10T08:00:00Z') });

    await world.prisma.payment.update({ where: { id: payment.id }, data: { status: 'PARTIALLY_REFUNDED', amountRefunded: 30 } });

    const row = await rowOf(world, job);

    expect(row.complaints.map((entry: any) => [entry.id, entry.remaining])).toEqual([[complaint.id, 20]]);
    expect(row.complaints.some((entry: any) => entry.id === small.id)).toBe(false);
    expect(row.since).toEqual(at('2026-10-22T08:00:00Z'));
  });

  it('dates a job from the earliest decision among the complaints that still lack money', async () => {
    const { world, job, complaint, another } = accepted(50);
    const older = another({ title: 'Plus ancienne', refundAmount: 30, refundDecidedAt: at('2026-10-12T08:00:00Z') });

    const row = await rowOf(world, job);

    expect(row.complaints.map((entry: any) => entry.id).sort()).toEqual([complaint.id, older.id].sort());
    expect(row.since).toEqual(at('2026-10-12T08:00:00Z'));
  });

  it('does not price an acceptance that states no amount: the complaints screen holds it, not the money to give back', async () => {
    for (const promised of [null, 0]) {
      const { world, job } = accepted(promised as any);

      expect(await rowOf(world, job)).toBeUndefined();
    }
  });

  it('leaves an acceptance with no amount out of the line of a job that owes for a credit note', async () => {
    const { world, jobs, client } = owing();

    for (const promised of [null, 0]) {
      world.memory.plant('complaint', { interventionId: jobs.A.id, userId: client.id, title: 'Sans montant', description: 'x', status: 'REFUNDED', refundRequested: true, refundDecision: 'APPROVED', refundApproved: true, refundAmount: promised, refundDecidedAt: at('2026-10-23T08:00:00Z') });
    }

    const row = (await world.svc.finance.refundsDue('ACCOUNTANT')).items.find((item: any) => item.interventionId === jobs.A.id);

    expect(row).toMatchObject({ fromCreditNotes: 100, fromComplaints: 0, due: 100 });
    expect(row.complaints).toEqual([]);
  });

  it('lists only the refunds that were accepted: not a request, a refusal, nor a refund that was made', async () => {
    for (const decision of ['PENDING', 'REJECTED', 'NOT_REQUESTED', 'PARTIAL_REFUND', 'REFUNDED']) {
      const { world, job } = accepted(50, decision);

      expect(await rowOf(world, job)).toBeUndefined();
    }
  });

  it('owes the larger of what the credit notes leave and what the complaint lacks: money that goes back answers both', async () => {
    const { world, jobs, client } = owing();
    const m = world.memory;
    const complaint = (jobName: string, promised: number) => m.plant('complaint', { interventionId: jobs[jobName].id, userId: client.id, title: `Sur ${jobName}`, description: 'x', status: 'REFUNDED', refundRequested: true, refundDecision: 'APPROVED', refundApproved: true, refundAmount: promised, refundDecidedAt: at('2026-10-23T08:00:00Z') });

    // A: the credit note leaves 100 to give back; the complaint asks 150 -> 150, and 60 -> still 100.
    complaint('A', 150);

    const first = (await world.svc.finance.refundsDue('ACCOUNTANT')).items.find((item: any) => item.interventionId === jobs.A.id);

    expect(first).toMatchObject({ fromCreditNotes: 100, fromComplaints: 150, due: 150 });

    world.set('complaint', { refundAmount: 60 }, () => true);

    const second = (await world.svc.finance.refundsDue('ACCOUNTANT')).items.find((item: any) => item.interventionId === jobs.A.id);

    expect(second).toMatchObject({ fromCreditNotes: 100, fromComplaints: 60, due: 100 });
    expect(second.creditNotes).toHaveLength(1);
    expect(second.complaints).toHaveLength(1);
  });

  it('owes, for several complaints on one job, what the largest of them still lacks, and tells each', async () => {
    const { world, job, payment, another } = accepted(50);
    const second = another({ title: 'Peinture', refundAmount: 80 });

    await world.prisma.payment.update({ where: { id: payment.id }, data: { status: 'PARTIALLY_REFUNDED', amountRefunded: 30 } });

    const row = await rowOf(world, job);

    expect(row.due).toBe(50);
    expect(row.fromComplaints).toBe(50);
    expect(row.complaints.map((entry: any) => [entry.remaining, entry.accepted])).toEqual([[20, 50], [50, 80]]);
    expect(row.complaints[1].id).toBe(second.id);
  });

  it('is counted in the totals of the week like any refund that is due, once per job', async () => {
    const before = await owing().world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);
    const { world } = accepted(50);
    const summary = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);

    expect(summary.refundsDue).toEqual({ count: before.refundsDue.count + 1, amount: before.refundsDue.amount + 50 });
  });

  it('waits since the day the refund was accepted, when no credit note came first', async () => {
    const { world, job, complaint } = accepted(50);
    const old = (await world.svc.finance.refundsDue('ACCOUNTANT')).items;

    expect(old.find((item: any) => item.interventionId === job.id).since).toEqual(at('2026-10-22T08:00:00Z'));

    world.set('complaint', { refundDecidedAt: null }, complaint.id);
    expect((await rowOf(world, job)).since).toBeNull();
  });

  it('never lists more than the job still holds: a refund accepted for more than was paid is capped, and gone once all went back', async () => {
    const { world, job, payment } = accepted(500);

    expect(await rowOf(world, job)).toMatchObject({ kept: 120, fromComplaints: 120, due: 120 });
    expect((await rowOf(world, job)).complaints.map((entry: any) => [entry.accepted, entry.remaining])).toEqual([[500, 120]]);

    await world.prisma.payment.update({ where: { id: payment.id }, data: { status: 'PARTIALLY_REFUNDED', amountRefunded: 70 } });
    expect(await rowOf(world, job)).toMatchObject({ kept: 50, fromComplaints: 50, due: 50 });

    await world.prisma.payment.update({ where: { id: payment.id }, data: { status: 'REFUNDED', amountRefunded: 120 } });
    expect(await rowOf(world, job)).toBeUndefined();
  });

  it('counts the capped amount, not the accepted one, in the totals of the week', async () => {
    const before = await owing().world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);
    const { world } = accepted(500);
    const summary = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);

    expect(summary.refundsDue).toEqual({ count: before.refundsDue.count + 1, amount: before.refundsDue.amount + 120 });
  });

  it('dates the line from the complaint, not from a credit note that the invoice already covers', async () => {
    const { world, job, m } = accepted(50);
    const invoice = m.plant('invoice', { interventionId: job.id, invoiceNumber: 'F-2026-0300', currency: 'TND', amountHT: 0, taxAmount: 0, amountTTC: 130, stampDuty: 0, creditedAmount: 10, status: 'ISSUED', issuedAt: at('2026-10-10T08:00:00Z') });

    m.plant('creditNote', { invoiceId: invoice.id, interventionId: job.id, creditNoteNumber: 'AV-2026-0300', numberYear: 2026, sequence: 300, reason: 'Geste', currency: 'TND', amountHT: 0, taxRate: 19, taxAmount: 0, amountTTC: 10, stampDuty: 0, issuedAt: at('2026-10-15T08:00:00Z') });

    const row = await rowOf(world, job);

    // The customer paid 120 and owes 130 - 10: the credit note leaves nothing to give back, so only the complaint is waited for.
    expect(row).toMatchObject({ fromCreditNotes: 0, fromComplaints: 50, due: 50 });
    expect(row.creditNotes).toHaveLength(1);
    expect(row.since).toEqual(at('2026-10-22T08:00:00Z'));
  });

  it('dates the line from the oldest of the credit note and the complaints that each make the job owe something', async () => {
    const { world, jobs, client } = owing();

    // A: the credit note (15 Oct) leaves 100 to give back and a complaint accepted on 1 Oct lacks 60: both make the job owe, the older dates it.
    world.memory.plant('complaint', { interventionId: jobs.A.id, userId: client.id, title: 'Petit geste', description: 'x', status: 'REFUNDED', refundRequested: true, refundDecision: 'APPROVED', refundApproved: true, refundAmount: 60, refundDecidedAt: at('2026-10-01T08:00:00Z') });

    const row = (await world.svc.finance.refundsDue('ACCOUNTANT')).items.find((item: any) => item.interventionId === jobs.A.id);

    expect(row).toMatchObject({ fromCreditNotes: 100, fromComplaints: 60, due: 100 });
    expect(row.since).toEqual(at('2026-10-01T08:00:00Z'));
  });

  it('sets the credit note part aside when the invoice is in another currency, and still tells what the complaint lacks', async () => {
    const { world, jobs, client } = owing();

    world.memory.plant('complaint', { interventionId: jobs.G.id, userId: client.id, title: 'Euro', description: 'x', status: 'REFUNDED', refundRequested: true, refundDecision: 'APPROVED', refundApproved: true, refundAmount: 30, refundDecidedAt: at('2026-10-23T08:00:00Z') });

    const row = (await world.svc.finance.refundsDue('ACCOUNTANT')).items.find((item: any) => item.interventionId === jobs.G.id);

    expect(row).toMatchObject({ fromCreditNotes: 0, fromComplaints: 30, due: 30 });
    expect(row.creditNotes).toHaveLength(1);
  });

  it('reads only the complaints of its own query: no complaint, no credit note, no row', async () => {
    const world = emptyWorld();

    expect(await world.svc.finance.refundsDue('ADMIN')).toEqual({ items: [], total: 0, amount: 0 });
  });

  it('refuses to look for refunds among too many complaints, with the right article, and says it is a matter for the technical team', async () => {
    const { world, complaint } = accepted(50);

    plantCopies(world, 'complaint', complaint, SUMMARY_LIMIT, () => undefined);

    const failure = await refusal(() => world.svc.finance.refundsDue('ACCOUNTANT'));

    expect(failure?.status).toBe(400);
    expect(failure?.message).toMatch(/^Trop de réclamations pour un résumé/);
    expect(failure?.message).toContain('prévenez l’équipe technique');
  });

  it('reads the complaints with the same rule for the summary and for the list', async () => {
    const { world } = accepted(50);
    const summary = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);
    const list = await world.svc.finance.refundsDue('ACCOUNTANT');

    expect(summary.refundsDue).toEqual({ count: list.total, amount: list.amount });
  });
});

describe('the money that a cancelled job still holds (P3-01)', () => {
  beforeEach(() => resetLocale());

  /** A customer, and a job cancelled on 22 October 2026 for "Plus besoin". */
  function cancelledJob(status = 'CANCELLED') {
    const world = emptyWorld();
    const m = world.memory;
    const client = m.plant('user', { role: 'CLIENT', name: 'Salma', phone: '20999888' });
    const job = m.plant('intervention', { clientId: client.id, status, serviceType: 'PLOMBIER', cancelledAt: at('2026-10-22T08:00:00Z'), cancelledReason: 'Plus besoin' });
    const pay = (data: Record<string, any>) =>
      m.plant('payment', { interventionId: job.id, method: 'BANK_TRANSFER', provider: 'MANUAL', status: 'PAID', amount: 50, amountRefunded: 0, currency: 'TND', confirmedAt: at('2026-10-11T08:00:00Z'), requestedAt: at('2026-10-11T08:00:00Z'), ...data });

    return { world, m, client, job, pay };
  }

  const rowOf = async (world: World, job: any) => (await world.svc.finance.refundsDue('ACCOUNTANT')).items.find((item: any) => item.interventionId === job.id);

  it('lists a cancelled job that holds money, for all of it, with when and why it was cancelled', async () => {
    const { world, job, pay } = cancelledJob();
    const payment = pay({ amount: 80 });

    const row = await rowOf(world, job);

    expect(row).toMatchObject({ kept: 80, fromCreditNotes: 0, fromComplaints: 0, fromCancellation: 80, due: 80 });
    expect(row.cancelled).toEqual({ at: at('2026-10-22T08:00:00Z'), reason: 'Plus besoin' });
    expect(row.since).toEqual(at('2026-10-22T08:00:00Z'));
    expect(row.payments.map((entry: any) => [entry.id, entry.refundable])).toEqual([[payment.id, 80]]);
  });

  it('counts what already went back: only what the job still holds is owed', async () => {
    const { world, job, pay } = cancelledJob();

    pay({ amount: 80, amountRefunded: 30, status: 'PARTIALLY_REFUNDED' });
    pay({ amount: 10, method: 'CASH', provider: 'CASH' });

    expect(await rowOf(world, job)).toMatchObject({ kept: 60, fromCancellation: 60, due: 60 });
  });

  it('a job whose money all went back, or that took none in, is not listed', async () => {
    const { world, job, pay } = cancelledJob();

    pay({ amount: 40, amountRefunded: 40, status: 'REFUNDED' });
    pay({ amount: 25, status: 'PENDING' });
    pay({ amount: 15, status: 'FAILED' });

    expect(await rowOf(world, job)).toBeUndefined();
  });

  it('a payment in another currency is not counted with the money of the company', async () => {
    const { world, job, pay } = cancelledJob();

    pay({ amount: 20, currency: 'EUR' });

    expect(await rowOf(world, job)).toBeUndefined();
  });

  it('a job that is not cancelled is not listed for being paid', async () => {
    for (const status of ['ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'PAID', 'DISPUTED']) {
      const { world, job, pay } = cancelledJob(status);

      pay({ amount: 80 });

      expect(await rowOf(world, job)).toBeUndefined();
    }
  });

  it('a cancelled job with an invoice that still asks for money owes only what is held above it', async () => {
    const { world, m, job, pay } = cancelledJob();

    pay({ amount: 80 });
    m.plant('invoice', { interventionId: job.id, invoiceNumber: 'F-2026-0300', currency: 'TND', amountHT: 0, taxAmount: 0, stampDuty: 0, creditedAmount: 0, status: 'ISSUED', amountTTC: 30, issuedAt: at('2026-10-21T08:00:00Z') });

    expect(await rowOf(world, job)).toMatchObject({ kept: 80, owed: 30, fromCancellation: 50, due: 50 });
  });

  it('the stamp duty of the invoice is part of what it still asks', async () => {
    const { world, m, job, pay } = cancelledJob();

    pay({ amount: 80 });
    m.plant('invoice', { interventionId: job.id, invoiceNumber: 'F-2026-0301', currency: 'TND', amountHT: 0, taxAmount: 0, stampDuty: 1, creditedAmount: 0, status: 'ISSUED', amountTTC: 29, issuedAt: at('2026-10-21T08:00:00Z') });

    expect(await rowOf(world, job)).toMatchObject({ kept: 80, owed: 30, fromCancellation: 50, due: 50 });
  });

  it('an invoice that asks for all of what is held, or more, leaves nothing to give back: the job is not listed', async () => {
    for (const asked of [80, 100]) {
      const { world, m, job, pay } = cancelledJob();

      pay({ amount: 80 });
      m.plant('invoice', { interventionId: job.id, invoiceNumber: 'F-2026-0302', currency: 'TND', amountHT: 0, taxAmount: 0, stampDuty: 0, creditedAmount: 0, status: 'ISSUED', amountTTC: asked, issuedAt: at('2026-10-21T08:00:00Z') });

      expect(await rowOf(world, job)).toBeUndefined();
    }
  });

  it('an invoice that was cancelled, or is only a draft, asks nothing: all that is held is to be given back', async () => {
    const { world, m, job, pay } = cancelledJob();

    pay({ amount: 80 });
    m.plant('invoice', { interventionId: job.id, invoiceNumber: 'F-2026-0303', currency: 'TND', amountHT: 0, taxAmount: 0, stampDuty: 0, creditedAmount: 0, status: 'CANCELLED', amountTTC: 70, issuedAt: at('2026-10-21T08:00:00Z') });
    m.plant('invoice', { interventionId: job.id, invoiceNumber: 'F-2026-0304', currency: 'TND', amountHT: 0, taxAmount: 0, stampDuty: 0, creditedAmount: 0, status: 'DRAFT', amountTTC: 60 });

    expect(await rowOf(world, job)).toMatchObject({ owed: 0, fromCancellation: 80, due: 80 });
  });

  it('an invoice in another currency cannot be set against the money of the company: no sum is worked out, the job is not listed', async () => {
    const { world, m, job, pay } = cancelledJob();

    pay({ amount: 80 });
    m.plant('invoice', { interventionId: job.id, invoiceNumber: 'F-2026-0305', currency: 'EUR', amountHT: 0, taxAmount: 0, stampDuty: 0, creditedAmount: 0, status: 'ISSUED', amountTTC: 30, issuedAt: at('2026-10-21T08:00:00Z') });

    expect(await rowOf(world, job)).toBeUndefined();
  });

  it('a credit note on the job and the cancellation say the same money: it is given back once', async () => {
    const { world, m, job, pay } = cancelledJob();

    pay({ amount: 200 });

    const invoice = m.plant('invoice', { interventionId: job.id, invoiceNumber: 'F-2026-0306', currency: 'TND', amountHT: 0, taxAmount: 0, stampDuty: 1, creditedAmount: 100, status: 'ISSUED', amountTTC: 238, issuedAt: at('2026-10-21T08:00:00Z') });

    m.plant('creditNote', { invoiceId: invoice.id, interventionId: job.id, creditNoteNumber: 'AV-2026-0300', numberYear: 2026, sequence: 300, reason: 'Remise', currency: 'TND', amountHT: 0, taxRate: 19, taxAmount: 0, amountTTC: 100, stampDuty: 0, issuedAt: at('2026-10-21T09:00:00Z') });

    const row = await rowOf(world, job);

    expect(row).toMatchObject({ kept: 200, owed: 139, fromCreditNotes: 61, fromCancellation: 61, due: 61 });
  });

  it('a cancelled job that owes for another reason only carries no cancellation: the standing invoice asks for all it holds, and an accepted refund is what is due', async () => {
    const { world, m, client, job, pay } = cancelledJob();

    pay({ amount: 100 });
    m.plant('invoice', { interventionId: job.id, invoiceNumber: 'F-2026-0307', currency: 'TND', amountHT: 0, taxAmount: 0, stampDuty: 0, creditedAmount: 0, status: 'ISSUED', amountTTC: 100, issuedAt: at('2026-10-21T08:00:00Z') });
    m.plant('complaint', { interventionId: job.id, userId: client.id, title: 'Fuite', description: 'Toujours là', status: 'REFUNDED', refundRequested: true, refundDecision: 'APPROVED', refundApproved: true, refundAmount: 50, refundDecidedAt: at('2026-10-20T08:00:00Z') });

    const row = await rowOf(world, job);

    expect(row).toMatchObject({ fromCancellation: 0, fromComplaints: 50, due: 50 });
    expect(row.cancelled).toBeNull();
    // the line is as old as the refund, not as the cancellation that adds nothing
    expect(row.since).toEqual(at('2026-10-20T08:00:00Z'));
  });

  it('the line is as old as the oldest of the reasons: a refund accepted before the cancellation, or a cancellation before it', async () => {
    const early = cancelledJob();

    early.pay({ amount: 120 });
    early.m.plant('complaint', { interventionId: early.job.id, userId: early.client.id, title: 'Fuite', description: 'Toujours là', status: 'REFUNDED', refundRequested: true, refundDecision: 'APPROVED', refundApproved: true, refundAmount: 50, refundDecidedAt: at('2026-10-20T08:00:00Z') });

    expect((await rowOf(early.world, early.job)).since).toEqual(at('2026-10-20T08:00:00Z'));

    const late = cancelledJob();

    late.pay({ amount: 120 });
    late.m.plant('complaint', { interventionId: late.job.id, userId: late.client.id, title: 'Fuite', description: 'Toujours là', status: 'REFUNDED', refundRequested: true, refundDecision: 'APPROVED', refundApproved: true, refundAmount: 50, refundDecidedAt: at('2026-10-24T08:00:00Z') });

    expect((await rowOf(late.world, late.job)).since).toEqual(at('2026-10-22T08:00:00Z'));
  });

  it('the look at the cancelled jobs is capped, and a payment marked as refunded does not bring its job into it (the list does not grow with every job that was ever paid)', async () => {
    const { world, pay } = cancelledJob();
    const asked: any[] = [];
    const watching = new Proxy(world.prisma, {
      get: (target, key) =>
        key === 'intervention'
          ? new Proxy(target.intervention, {
              get: (jobs, method) => (method === 'findMany' ? async (args: any) => (args?.select?.cancelledAt ? (asked.push(args), jobs.findMany(args)) : jobs.findMany(args)) : jobs[method]),
            })
          : target[key],
    });

    pay({ amount: 40, amountRefunded: 40, status: 'REFUNDED' });

    await new (world.svc.finance.constructor as any)(watching).refundsDue('ACCOUNTANT');

    expect(asked).toHaveLength(1);
    expect(asked[0].where.payments.some.status.in).toEqual(['PAID', 'PARTIALLY_REFUNDED']);
    // and the look is capped, one above the limit, so that a list that is too long is told and not loaded
    expect(asked[0].take).toBe(SUMMARY_LIMIT + 1);
  });

  it('a cancelled job that also has an accepted refund owes the larger of the two, never the sum', async () => {
    const { world, m, client, job, pay } = cancelledJob();

    pay({ amount: 120 });
    m.plant('complaint', { interventionId: job.id, userId: client.id, title: 'Fuite', description: 'Toujours là', status: 'REFUNDED', refundRequested: true, refundDecision: 'APPROVED', refundApproved: true, refundAmount: 50, refundDecidedAt: at('2026-10-23T08:00:00Z') });

    const row = await rowOf(world, job);

    expect(row).toMatchObject({ fromComplaints: 50, fromCancellation: 120, due: 120 });
  });

  it('is counted in the summary of the finance console, with the others', async () => {
    const { world, pay } = cancelledJob();

    pay({ amount: 80 });

    const summary = await world.svc.finance.summary('ACCOUNTANT', WEEK, NOW);

    expect(summary.refundsDue).toEqual({ count: 1, amount: 80 });
  });

  it('refuses to list too many cancelled jobs, like the other reasons, and says it is a matter for the technical team', async () => {
    const { world } = cancelledJob();
    // The look at the cancelled jobs finds one more than the limit (planting that many rows one by one takes minutes).
    const crowded = new Proxy(world.prisma, {
      get: (target, key) =>
        key === 'intervention'
          ? new Proxy(target.intervention, {
              get: (jobs, method) => (method === 'findMany' ? async (args: any) => (args?.select?.cancelledAt ? Array.from({ length: SUMMARY_LIMIT + 1 }, (_, index) => ({ id: index + 1 })) : jobs.findMany(args)) : jobs[method]),
            })
          : target[key],
    });
    const finance = new (world.svc.finance.constructor as any)(crowded);

    const failure = await refusal(() => finance.refundsDue('ACCOUNTANT'));

    expect(failure?.status).toBe(400);
    expect(failure?.message).toMatch(/^Trop de missions annulées pour un résumé/);
    expect(failure?.message).toContain('prévenez l’équipe technique');
  });
});
