import { Decimal } from '../../common/testing/decimal-double';
import { World, emptyWorld } from '../../common/testing/world';
import { resetLocale } from '../../common/locale/locale';
import { lockPayouts } from '../assignment/artisan-lock';
import { payoutDecisions } from './payout-holds';

/**
 * What a payout pays, what it leaves out and why, and paying it twice (P2-02), on the real services and a database that
 * answers DECIMAL columns as Decimal objects.
 */
const PERIOD = { periodStart: '2026-10-01T00:00:00', periodEnd: '2026-10-31T23:59:59' };
const INSIDE = new Date('2026-10-15T10:00:00.000Z');

function desk() {
  const world = emptyWorld();
  const make = (role: string, name: string) => world.memory.plant('user', { role, name });
  const admin = make('ADMIN', 'Admin');
  const accountant = make('ACCOUNTANT', 'Comptable');
  const support = make('SUPPORT', 'Support');
  const dispatcher = make('DISPATCHER', 'Dispatcher');
  const superAdmin = make('SUPER_ADMIN', 'Super');
  const client = make('CLIENT', 'Client');
  const artisan = make('ARTISAN', 'Artisan');
  const other = make('ARTISAN', 'Autre artisan');

  world.memory.plant('artisanProfile', { userId: artisan.id, verificationStatus: 'APPROVED' });
  world.memory.plant('artisanProfile', { userId: other.id, verificationStatus: 'APPROVED' });

  let jobs = 0;
  const job = (amount: number, options: { status?: string; owner?: typeof artisan; at?: Date; refundAmount?: number; share?: number } = {}) => {
    jobs += 1;
    const owner = options.owner ?? artisan;
    const intervention = world.memory.plant('intervention', { clientId: client.id, artisanId: owner.id, status: options.status ?? 'PAID', serviceType: 'PLOMBIER', description: `Mission ${jobs}` });
    const financials = world.memory.plant('interventionFinancials', {
      interventionId: intervention.id,
      totalPrice: amount,
      platformCommission: 0,
      artisanPayout: options.share ?? amount,
      netRevenue: 0,
      companyMargin: 0,
      refundAmount: options.refundAmount ?? 0,
      createdAt: options.at ?? INSIDE,
    });

    return { intervention, financials };
  };

  return { world, admin, accountant, support, dispatcher, superAdmin, client, artisan, other, job };
}

type Desk = ReturnType<typeof desk>;

const rowsOf = (world: World, model: string) => world.memory.rows(model);

async function refusal(work: () => Promise<unknown>): Promise<{ status: number; message: string } | null> {
  try {
    await work();
  } catch (error) {
    const known = error as { getStatus?: () => number; message?: string };

    return { status: typeof known.getStatus === 'function' ? known.getStatus() : 500, message: String(known.message) };
  }

  return null;
}

const preview = (d: Desk, artisanId = d.artisan.id) => d.world.svc.business.previewArtisanPayout(d.admin.id, 'ADMIN', { artisanId, ...PERIOD });
const create = (d: Desk, artisanId = d.artisan.id) => d.world.svc.business.createArtisanPayout(d.admin.id, 'ADMIN', { artisanId, ...PERIOD } as any);
const heldReasons = async (d: Desk, interventionId: number) => ((await preview(d)).held.find((item) => item.interventionId === interventionId)?.reasons ?? null) as string[] | null;
const isIncluded = async (d: Desk, interventionId: number) => (await preview(d)).included.some((item) => item.interventionId === interventionId);

let taps = 0;

/**
 * The work is done and the job has an accepted quote of this amount, so its artisan may say they were paid; `online` of it was
 * paid by the customer and confirmed. A payout waits for the work and for the whole price (P2-03): cash the artisan declares
 * counts once the back office has confirmed it.
 */
const underWay = (d: Desk, interventionId: number, total: number, online = 0) => {
  d.world.memory.plant('quote', { interventionId, createdById: d.artisan.id, status: 'ACCEPTED', amountHT: total, taxAmount: 0, amountTTC: total });
  rowsOf(d.world, 'intervention').find((row) => row.id === interventionId)!.status = 'COMPLETED';

  if (online > 0) d.world.memory.plant('payment', { interventionId, method: 'ONLINE', status: 'PAID', amount: online, amountRefunded: 0, createdById: d.client.id });
};

/** The back office has confirmed the payment (set directly, so that the financials typed in the fixture stay as they are). */
const confirmed = (d: Desk, paymentId: number) => {
  rowsOf(d.world, 'payment').find((row) => row.id === paymentId)!.status = 'PAID';
};

/** The customer paid it all online and was given 30 back (recorded in the financials): 30 are still to be paid, and may be paid in cash. */
const advanceRefunded = (d: Desk, interventionId: number) => {
  underWay(d, interventionId, 100);
  d.world.memory.plant('payment', { interventionId, method: 'ONLINE', status: 'PARTIALLY_REFUNDED', amount: 100, amountRefunded: 30, createdById: d.client.id });
  rowsOf(d.world, 'interventionFinancials').find((row) => row.interventionId === interventionId)!.refundAmount = 30;
};

const collect = (d: Desk, interventionId: number, amount: number) => d.world.svc.cashLedger.collectCash(d.artisan.id, 'ARTISAN', interventionId, { amount, requestKey: `tap-payouts-${(taps += 1)}` });

/** Another request holds the payouts of the artisan; a test decides what it sees meanwhile. */
async function whilePayoutsLocked<T>(d: Desk, request: () => Promise<unknown>, midway: () => T): Promise<{ answer: Awaited<ReturnType<typeof refusal>>; seen: T }> {
  let release!: () => void;
  let locked!: () => void;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  const taken = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const holder = d.world.prisma.$transaction(async (tx: any) => {
    await lockPayouts(tx, d.artisan.id);
    locked();
    await open;
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

describe('a payout pays the jobs that are free, and says which are not and why (P2-02)', () => {
  beforeEach(() => resetLocale());

  it('pays every free job of the artisan in the period, once, and shows the same list before', async () => {
    const d = desk();
    const a = d.job(100);
    const b = d.job(200.5);

    d.job(999, { owner: d.other });
    d.job(888, { at: new Date('2026-09-30T10:00:00.000Z') });

    const shown = await preview(d);

    expect(shown.included.map((item) => [item.interventionId, item.amount])).toEqual([[a.intervention.id, 100], [b.intervention.id, 200.5]]);
    expect(shown.grossAmount).toBe(300.5);
    expect(shown.held).toEqual([]);
    expect(shown.currency).toBe('TND');
    expect(rowsOf(d.world, 'artisanPayout').length).toBe(0);

    const payout = await create(d);

    expect(payout.status).toBe('READY');
    expect(String(payout.grossAmount)).toBe('300.5');
    expect(String(payout.netAmount)).toBe('300.5');
    expect(rowsOf(d.world, 'artisanPayoutItem').map((item) => item.interventionId).sort()).toEqual([a.intervention.id, b.intervention.id].sort());

    // what is paid is not offered again
    expect((await preview(d)).included).toEqual([]);
    expect((await refusal(() => create(d)))?.message).toBe('Aucune intervention financière disponible pour ce payout.');
    expect(rowsOf(d.world, 'artisanPayout').length).toBe(1);
  });

  it('holds back a job while a complaint on it is being handled, and frees it when the complaint is decided', async () => {
    for (const status of ['OPEN', 'IN_REVIEW', 'WAITING_CLIENT', 'WAITING_ARTISAN']) {
      const d = desk();
      const { intervention } = d.job(100);

      d.world.memory.plant('complaint', { interventionId: intervention.id, userId: d.client.id, title: 'Souci', description: 'Fuite', status });

      expect(`${status}: ${await heldReasons(d, intervention.id)}`).toBe(`${status}: OPEN_DISPUTE`);
    }

    for (const status of ['RESOLVED', 'REJECTED']) {
      const d = desk();
      const { intervention } = d.job(100);

      d.world.memory.plant('complaint', { interventionId: intervention.id, userId: d.client.id, title: 'Souci', description: 'Fuite', status });

      expect(`${status}: ${await isIncluded(d, intervention.id)}`).toBe(`${status}: true`);
    }

    const d = desk();
    const { intervention } = d.job(100);
    d.world.memory.plant('complaint', { interventionId: intervention.id, userId: d.client.id, title: 'Souci', description: 'Fuite', status: 'OPEN' });

    expect(await isIncluded(d, intervention.id)).toBe(false);
    rowsOf(d.world, 'complaint')[0].status = 'RESOLVED';
    expect(await isIncluded(d, intervention.id)).toBe(true);
  });

  it('a job that is itself in dispute is held, even before anyone has written a complaint', async () => {
    const d = desk();
    const { intervention } = d.job(100, { status: 'DISPUTED' });

    expect(await heldReasons(d, intervention.id)).toEqual(['OPEN_DISPUTE']);
  });

  it('holds back a job whose customer asked for, was granted or got a refund; not one that was refused or never asked', async () => {
    const held: string[] = [];
    const freed: string[] = [];

    for (const refundDecision of ['NOT_REQUESTED', 'PENDING', 'APPROVED', 'REJECTED', 'PARTIAL_REFUND', 'REFUNDED']) {
      const d = desk();
      const { intervention } = d.job(100);

      d.world.memory.plant('complaint', { interventionId: intervention.id, userId: d.client.id, title: 'Souci', description: 'Fuite', status: 'RESOLVED', refundDecision });
      (await isIncluded(d, intervention.id) ? freed : held).push(refundDecision);
    }

    expect(held).toEqual(['PENDING', 'APPROVED', 'PARTIAL_REFUND', 'REFUNDED']);
    expect(freed).toEqual(['NOT_REQUESTED', 'REJECTED']);

    const d = desk();
    const { intervention } = d.job(100);

    d.world.memory.plant('complaint', { interventionId: intervention.id, userId: d.client.id, title: 'Souci', description: 'Fuite', status: 'REFUNDED' });
    expect(await heldReasons(d, intervention.id)).toEqual(['REFUND']);
  });

  it('holds back a job whose payment was refunded, wholly or in part, until the financials record the refund', async () => {
    for (const [name, change] of [
      ['payment REFUNDED', { status: 'REFUNDED', amountRefunded: 0 }],
      ['payment PARTIALLY_REFUNDED, no amount', { status: 'PARTIALLY_REFUNDED', amountRefunded: 0 }],
      ['an amount refunded', { status: 'PAID', amountRefunded: 0.001 }],
    ] as const) {
      const d = desk();
      const { intervention } = d.job(100);

      d.world.memory.plant('payment', { interventionId: intervention.id, method: 'ONLINE', amount: 100, createdById: d.client.id, ...change });

      expect(`${name}: ${await heldReasons(d, intervention.id)}`).toBe(`${name}: REFUND`);
    }

    const clean = desk();
    const free = clean.job(100);

    clean.world.memory.plant('payment', { interventionId: free.intervention.id, method: 'ONLINE', status: 'PAID', amount: 100, amountRefunded: 0, createdById: clean.client.id });
    expect(await isIncluded(clean, free.intervention.id)).toBe(true);
  });

  it('a refund that the financials record frees the job; a refund bigger than the one recorded does not', async () => {
    const outcomes: string[] = [];

    for (const [name, recorded, payment] of [
      ['all of it, recorded in full', 100, { status: 'REFUNDED', amountRefunded: 0 }],
      ['a part, recorded in full', 30, { status: 'PARTIALLY_REFUNDED', amountRefunded: 30 }],
      ['a part, recorded below', 29.999, { status: 'PARTIALLY_REFUNDED', amountRefunded: 30 }],
      ['a part, recorded above', 31, { status: 'PARTIALLY_REFUNDED', amountRefunded: 30 }],
      ['all of it, recorded below', 99.999, { status: 'REFUNDED', amountRefunded: 0 }],
      ['refunded, nothing recorded', 0, { status: 'PARTIALLY_REFUNDED', amountRefunded: 30 }],
      ['refunded, no amount, a refund recorded', 5, { status: 'PARTIALLY_REFUNDED', amountRefunded: 0 }],
    ] as const) {
      const d = desk();
      const { intervention } = d.job(100, { refundAmount: recorded });

      d.world.memory.plant('payment', { interventionId: intervention.id, method: 'ONLINE', amount: 100, createdById: d.client.id, ...payment });
      outcomes.push(`${name}: ${(await heldReasons(d, intervention.id))?.join(',') ?? 'free'}`);
    }

    expect(outcomes).toEqual([
      'all of it, recorded in full: free',
      'a part, recorded in full: free',
      'a part, recorded below: REFUND',
      'a part, recorded above: free',
      'all of it, recorded below: REFUND',
      'refunded, nothing recorded: REFUND',
      'refunded, no amount, a refund recorded: free',
    ]);
  });

  it('a refund that is still to be decided holds the job even when the financials record one; a complaint that says refunded needs an amount somewhere', async () => {
    const outcomes: string[] = [];

    for (const [name, refundDecision, status, recorded] of [
      ['asked, recorded', 'PENDING', 'RESOLVED', 20],
      ['approved, recorded', 'APPROVED', 'RESOLVED', 20],
      ['refused, recorded', 'REJECTED', 'RESOLVED', 20],
      ['refunded, no amount anywhere', 'REFUNDED', 'RESOLVED', 0],
      ['partly refunded, no amount anywhere', 'PARTIAL_REFUND', 'RESOLVED', 0],
      ['refunded, an amount recorded', 'REFUNDED', 'RESOLVED', 20],
      ['status refunded, no amount anywhere', 'NOT_REQUESTED', 'REFUNDED', 0],
    ] as const) {
      const d = desk();
      const { intervention } = d.job(100, { refundAmount: recorded });

      d.world.memory.plant('complaint', { interventionId: intervention.id, userId: d.client.id, title: 'Souci', description: 'Fuite', status, refundDecision });
      outcomes.push(`${name}: ${(await heldReasons(d, intervention.id))?.join(',') ?? 'free'}`);
    }

    expect(outcomes).toEqual([
      'asked, recorded: REFUND',
      'approved, recorded: REFUND',
      'refused, recorded: free',
      'refunded, no amount anywhere: REFUND',
      'partly refunded, no amount anywhere: REFUND',
      'refunded, an amount recorded: free',
      'status refunded, no amount anywhere: REFUND',
    ]);
  });

  it('holds back a job the artisan was paid for in cash, until that collection is taken back', async () => {
    const d = desk();
    const { intervention } = d.job(100);

    underWay(d, intervention.id, 100);

    const collected = await d.world.svc.cashLedger.collectCash(d.artisan.id, 'ARTISAN', intervention.id, { amount: 100, requestKey: 'tap-payouts-01' });

    // the cash is declared and the back office has not confirmed it yet: the job is not paid, and the cash is in the artisan's hand
    expect(await heldReasons(d, intervention.id)).toEqual(['NOT_PAID', 'PAID_IN_CASH']);
    expect((await preview(d)).included).toEqual([]);
    expect((await refusal(() => create(d)))?.message).toBe('Aucune intervention financière ne peut être payée maintenant: 1 intervention(s) sont retenues (litige, remboursement, espèces déjà encaissées, travail non terminé ou paiement incomplet).');
    expect(rowsOf(d.world, 'artisanPayout').length).toBe(0);

    await d.world.svc.payments.cancel(collected.payment.id, d.admin.id, {});

    // the cash is taken back, and nobody has paid the job: it waits for the customer
    expect(await heldReasons(d, intervention.id)).toEqual(['NOT_PAID']);

    d.world.memory.plant('payment', { interventionId: intervention.id, method: 'ONLINE', status: 'PAID', amount: 100, amountRefunded: 0, createdById: d.client.id });

    expect(await isIncluded(d, intervention.id)).toBe(true);
  });

  it('a job can be held for several reasons at once, each one named', async () => {
    const d = desk();
    const { intervention } = d.job(100, { status: 'DISPUTED' });

    d.world.memory.plant('complaint', { interventionId: intervention.id, userId: d.client.id, title: 'Souci', description: 'Fuite', status: 'RESOLVED', refundDecision: 'APPROVED' });
    d.world.memory.plant('cashLedgerEntry', { artisanId: d.artisan.id, type: 'COLLECTION', interventionId: intervention.id, cashAmount: 100, commissionAmount: 20 });

    expect(await heldReasons(d, intervention.id)).toEqual(['OPEN_DISPUTE', 'REFUND', 'PAID_IN_CASH']);
  });

  it('a payout pays the free jobs and leaves the held ones for later', async () => {
    const d = desk();
    const free = d.job(100);
    const disputed = d.job(200);
    const refunded = d.job(300);

    d.world.memory.plant('complaint', { interventionId: disputed.intervention.id, userId: d.client.id, title: 'Souci', description: 'Fuite', status: 'OPEN' });
    d.world.memory.plant('payment', { interventionId: refunded.intervention.id, method: 'ONLINE', status: 'PARTIALLY_REFUNDED', amount: 300, amountRefunded: 50, createdById: d.client.id });

    const shown = await preview(d);

    expect(shown.included.map((item) => item.interventionId)).toEqual([free.intervention.id]);
    expect(shown.held.map((item) => [item.interventionId, item.amount, item.reasons])).toEqual([
      [disputed.intervention.id, 200, ['OPEN_DISPUTE']],
      [refunded.intervention.id, 300, ['REFUND']],
    ]);
    expect(shown.grossAmount).toBe(100);

    const payout = await create(d);

    expect(String(payout.netAmount)).toBe('100');
    expect(rowsOf(d.world, 'artisanPayoutItem').map((item) => item.interventionId)).toEqual([free.intervention.id]);
    expect((await preview(d)).held.length).toBe(2);
  });

  it('the cash lines of another artisan, who had the job before, do not hold it for this one', async () => {
    const d = desk();
    const { intervention } = d.job(100, { share: 80 });

    d.world.memory.plant('cashLedgerEntry', { artisanId: d.other.id, type: 'COLLECTION', interventionId: intervention.id, cashAmount: 100, commissionAmount: 20 });

    const shown = await preview(d);

    expect(shown.held).toEqual([]);
    expect(shown.included.map((item) => [item.amount, item.cashHeld])).toEqual([[80, 0]]);
  });

  it('a job paid partly in cash is paid for the part that did not go through the artisan\'s hand', async () => {
    const d = desk();
    const { intervention } = d.job(100, { share: 80 });

    underWay(d, intervention.id, 100, 70);

    const declared = await collect(d, intervention.id, 30);

    // declared and not confirmed: the job is not paid yet
    expect(await heldReasons(d, intervention.id)).toEqual(['NOT_PAID']);
    confirmed(d, declared.payment.id);

    const shown = await preview(d);

    expect(shown.held).toEqual([]);
    expect(shown.included).toEqual([{ financialId: shown.included[0].financialId, interventionId: intervention.id, amount: 56, cashHeld: 30 }]);
    expect(shown.grossAmount).toBe(56);

    const payout = await create(d);

    expect(String(payout.grossAmount)).toBe('56');
    expect(String(payout.netAmount)).toBe('56');
    expect(rowsOf(d.world, 'artisanPayoutItem').map((item) => String(item.amount))).toEqual(['56']);
  });

  it('the part is worked out to the millime, with one rounding', async () => {
    const outcomes: string[] = [];

    for (const [total, share, cash] of [[100, 80, 99.999], [119, 101.15, 50], [33.333, 26.666, 11.111], [0.003, 0.002, 0.001]] as const) {
      const d = desk();
      const { intervention } = d.job(total, { share });

      underWay(d, intervention.id, total, Number((total - cash).toFixed(3)));
      confirmed(d, (await collect(d, intervention.id, cash)).payment.id);
      outcomes.push(`${total}/${share}/${cash}: ${(await preview(d)).included[0]?.amount}`);
    }

    expect(outcomes).toEqual(['100/80/99.999: 0.001', '119/101.15/50: 58.65', '33.333/26.666/11.111: 17.777', '0.003/0.002/0.001: 0.001']);
  });

  it('cash that the artisan declared and the back office confirmed is counted once, not twice', async () => {
    const d = desk();
    const { intervention } = d.job(100, { share: 80 });

    underWay(d, intervention.id, 100);

    const taken = await collect(d, intervention.id, 30);

    // the rest was paid online: the financials are worked out from the confirmed payments (P2-03), 30 + 70 = the 100 of the job
    d.world.memory.plant('payment', { interventionId: intervention.id, method: 'ONLINE', status: 'PAID', amount: 70, amountRefunded: 0, createdById: d.client.id });
    await d.world.svc.payments.confirm(taken.payment.id, d.admin.id, {});

    expect(rowsOf(d.world, 'payment').find((row) => row.id === taken.payment.id)?.status).toBe('PAID');
    expect((await preview(d)).included.map((item) => [item.amount, item.cashHeld])).toEqual([[56, 30]]);
  });

  it('cash payments that were confirmed with no declaration by the artisan count as cash too (data from before the ledger)', async () => {
    const outcomes: string[] = [];

    for (const [name, payments] of [
      ['all of it', [{ status: 'PAID', amount: 100, amountRefunded: 0 }]],
      ['a part', [{ status: 'PAID', amount: 30, amountRefunded: 0 }]],
      ['in two payments', [{ status: 'PAID', amount: 60, amountRefunded: 0 }, { status: 'PAID', amount: 40, amountRefunded: 0 }]],
      ['not confirmed yet', [{ status: 'AWAITING_CONFIRMATION', amount: 100, amountRefunded: 0 }]],
      ['failed', [{ status: 'FAILED', amount: 100, amountRefunded: 0 }]],
      ['refunded in full: no cash left', [{ status: 'PARTIALLY_REFUNDED', amount: 100, amountRefunded: 100 }]],
      ['refunded in part: the cash left counts', [{ status: 'PARTIALLY_REFUNDED', amount: 100, amountRefunded: 40 }]],
    ] as const) {
      const d = desk();
      const { intervention } = d.job(100, { share: 80, refundAmount: 100 });

      for (const payment of payments) d.world.memory.plant('payment', { interventionId: intervention.id, method: 'CASH', createdById: d.client.id, ...payment });

      const shown = await preview(d);

      outcomes.push(`${name}: ${shown.held[0]?.reasons.join(',') ?? shown.included[0]?.amount}`);
    }

    expect(outcomes).toEqual(['all of it: PAID_IN_CASH', 'a part: 56', 'in two payments: PAID_IN_CASH', 'not confirmed yet: 80', 'failed: 80', 'refunded in full: no cash left: 80', 'refunded in part: the cash left counts: 32']);
  });

  it('a complaint that says refunded is satisfied when the payments and the financials agree on the amount', async () => {
    const d = desk();
    const { intervention } = d.job(100, { refundAmount: 30 });

    d.world.memory.plant('payment', { interventionId: intervention.id, method: 'ONLINE', status: 'PARTIALLY_REFUNDED', amount: 100, amountRefunded: 30, createdById: d.client.id });
    d.world.memory.plant('complaint', { interventionId: intervention.id, userId: d.client.id, title: 'Souci', description: 'Fuite', status: 'RESOLVED', refundDecision: 'PARTIAL_REFUND' });

    expect(await isIncluded(d, intervention.id)).toBe(true);

    rowsOf(d.world, 'interventionFinancials')[0].refundAmount = 20;
    expect(await heldReasons(d, intervention.id)).toEqual(['REFUND']);
  });

  it('a job with no price and cash taken is held; a held job with some cash shows its whole share', async () => {
    const d = desk();
    const nothing = d.job(0, { share: 0 });

    d.world.memory.plant('cashLedgerEntry', { artisanId: d.artisan.id, type: 'COLLECTION', interventionId: nothing.intervention.id, cashAmount: 10, commissionAmount: 2 });
    expect(await heldReasons(d, nothing.intervention.id)).toEqual(['PAID_IN_CASH']);

    const disputed = d.job(100, { share: 80, status: 'DISPUTED' });

    d.world.memory.plant('cashLedgerEntry', { artisanId: d.artisan.id, type: 'COLLECTION', interventionId: disputed.intervention.id, cashAmount: 30, commissionAmount: 6 });

    const shown = await preview(d);

    expect(shown.held.find((item) => item.interventionId === disputed.intervention.id)).toEqual({ financialId: disputed.financials.id, interventionId: disputed.intervention.id, amount: 80, reasons: ['OPEN_DISPUTE'] });
  });

  it('a job that the artisan took all the cash for is held with its whole share shown', async () => {
    const d = desk();
    const { intervention } = d.job(100, { share: 80 });

    underWay(d, intervention.id, 100);
    confirmed(d, (await collect(d, intervention.id, 100)).payment.id);

    const shown = await preview(d);

    expect(shown.included).toEqual([]);
    expect(shown.held.map((item) => [item.amount, item.reasons])).toEqual([[80, ['PAID_IN_CASH']]]);
  });

  it('a payout that was cancelled gives its jobs back; one that failed does not, until it is cancelled', async () => {
    const d = desk();
    const { intervention } = d.job(100);
    const first = await create(d);

    expect((await preview(d)).included).toEqual([]);

    for (const status of ['PENDING', 'READY', 'PAID', 'FAILED']) {
      rowsOf(d.world, 'artisanPayout')[0].status = status;
      expect(`${status}: ${await isIncluded(d, intervention.id)}`).toBe(`${status}: false`);
    }

    rowsOf(d.world, 'artisanPayout')[0].status = 'CANCELLED';
    expect(await isIncluded(d, intervention.id)).toBe(true);

    const second = await create(d);

    expect(second.id).not.toBe(first.id);
    expect(rowsOf(d.world, 'artisanPayoutItem').length).toBe(2);
    expect(await isIncluded(d, intervention.id)).toBe(false);
  });

  it('two requests for a payout at the same moment pay each job once', async () => {
    const d = desk();

    d.job(100);
    d.job(250);

    const answers = await Promise.all([refusal(() => create(d)), refusal(() => create(d)), refusal(() => create(d))]);

    expect(answers.filter((answer) => answer === null).length).toBe(1);
    expect(rowsOf(d.world, 'artisanPayout').length).toBe(1);
    expect(rowsOf(d.world, 'artisanPayoutItem').length).toBe(2);
  });

  it('reads the period on the clock of the business, wherever the server runs: 1 October 00:00 in Tunis is 30 September 23:00 UTC', async () => {
    const before = process.env.TZ;

    try {
      for (const zone of ['UTC', 'Africa/Tunis', 'America/Los_Angeles', 'Pacific/Auckland']) {
        process.env.TZ = zone;

        const d = desk();
        const early = d.job(10, { at: new Date('2026-09-30T22:30:00.000Z') }); //  23:30 on 30 September in Tunis: before
        const first = d.job(20, { at: new Date('2026-09-30T23:30:00.000Z') }); //  00:30 on 1 October in Tunis: in
        const last = d.job(30, { at: new Date('2026-10-31T22:30:00.000Z') }); //   23:30 on 31 October in Tunis: in
        const late = d.job(40, { at: new Date('2026-10-31T23:30:00.000Z') }); //   00:30 on 1 November in Tunis: after

        const shown = await preview(d);

        expect(`${zone}: ${shown.included.map((item) => item.interventionId).join(',')}`).toBe(`${zone}: ${first.intervention.id},${last.intervention.id}`);
        expect(shown.periodStart.toISOString()).toBe('2026-09-30T23:00:00.000Z');
        expect(shown.periodEnd.toISOString()).toBe('2026-10-31T22:59:59.000Z');
        void early;
        void late;

        const payout = await create(d);

        expect(`${zone}: ${payout.periodStart.toISOString()}`).toBe(`${zone}: 2026-09-30T23:00:00.000Z`);
      }
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });

  it('checks the period and the artisan before anything else', async () => {
    const d = desk();

    d.job(100);

    const cases = [
      ['reversed period', await refusal(() => d.world.svc.business.previewArtisanPayout(d.admin.id, 'ADMIN', { artisanId: d.artisan.id, periodStart: PERIOD.periodEnd, periodEnd: PERIOD.periodStart }))],
      ['no date', await refusal(() => d.world.svc.business.previewArtisanPayout(d.admin.id, 'ADMIN', { artisanId: d.artisan.id, periodStart: 'hier', periodEnd: PERIOD.periodEnd }))],
      ['a customer', await refusal(() => preview(d, d.client.id))],
      ['nobody', await refusal(() => preview(d, 99999))],
      ['create, reversed period', await refusal(() => d.world.svc.business.createArtisanPayout(d.admin.id, 'ADMIN', { artisanId: d.artisan.id, periodStart: PERIOD.periodEnd, periodEnd: PERIOD.periodStart } as any))],
    ] as const;

    expect(cases.map(([name, answer]) => `${name}: ${answer?.status}`)).toEqual(['reversed period: 400', 'no date: 400', 'a customer: 404', 'nobody: 404', 'create, reversed period: 400']);
  });

  it('only the staff look at or make a payout', async () => {
    const d = desk();

    d.job(100);

    const who: Array<[string, number]> = [['CLIENT', d.client.id], ['ARTISAN', d.artisan.id]];
    const answers: string[] = [];

    for (const [role, id] of who) {
      answers.push(`${role} preview: ${(await refusal(() => d.world.svc.business.previewArtisanPayout(id, role as any, { artisanId: d.artisan.id, ...PERIOD })))?.status}`);
      answers.push(`${role} create: ${(await refusal(() => d.world.svc.business.createArtisanPayout(id, role as any, { artisanId: d.artisan.id, ...PERIOD } as any)))?.status}`);
    }

    expect(answers).toEqual(['CLIENT preview: 403', 'CLIENT create: 403', 'ARTISAN preview: 403', 'ARTISAN create: 403']);
    expect(rowsOf(d.world, 'artisanPayout').length).toBe(0);
  });
});

describe('a payout is paid once (P2-02)', () => {
  beforeEach(() => resetLocale());

  async function ready() {
    const d = desk();

    d.job(100);

    const payout = await create(d);

    return { d, payout };
  }

  const pay = (d: Desk, id: number, dto: Record<string, unknown> = {}, role = 'ACCOUNTANT', userId = d.accountant.id) => d.world.svc.business.markPayoutPaid(userId, role as any, id, dto as any);

  it('marks it paid with the date and the reference', async () => {
    const { d, payout } = await ready();
    const paid = await pay(d, payout.id, { paidAt: '2026-11-02T09:30:00.000Z', paymentReference: ' VIR-1 ' });

    expect(paid.status).toBe('PAID');
    expect(paid.paidAt.toISOString()).toBe('2026-11-02T09:30:00.000Z');
    expect(paid.paymentReference).toBe('VIR-1');
    expect(paid.items.length).toBe(1);
  });

  it('saying it twice has no effect: the date and the reference of the first call stay', async () => {
    const { d, payout } = await ready();
    const first = await pay(d, payout.id, { paidAt: '2026-11-02T09:30:00.000Z', paymentReference: 'VIR-1' });
    const again = await pay(d, payout.id, { paidAt: '2026-11-09T09:30:00.000Z', paymentReference: 'VIR-2' });
    const third = await pay(d, payout.id);

    for (const answer of [again, third]) {
      expect(answer.status).toBe('PAID');
      expect(answer.paidAt.toISOString()).toBe(first.paidAt.toISOString());
      expect(answer.paymentReference).toBe('VIR-1');
    }

    expect(rowsOf(d.world, 'artisanPayout')[0].paymentReference).toBe('VIR-1');
    expect(rowsOf(d.world, 'artisanPayout').length).toBe(1);
  });

  it('three requests at the same moment: one writes, the others get its answer', async () => {
    const { d, payout } = await ready();
    const answers = await Promise.all([
      pay(d, payout.id, { paymentReference: 'A', paidAt: '2026-11-02T09:30:00.000Z' }),
      pay(d, payout.id, { paymentReference: 'B', paidAt: '2026-11-03T09:30:00.000Z' }),
      pay(d, payout.id, { paymentReference: 'C', paidAt: '2026-11-04T09:30:00.000Z' }),
    ]);
    const stored = rowsOf(d.world, 'artisanPayout')[0];

    expect(new Set(answers.map((answer) => answer.paymentReference)).size).toBe(1);
    expect(new Set(answers.map((answer) => answer.paidAt.toISOString())).size).toBe(1);
    expect(answers[0].paymentReference).toBe(stored.paymentReference);
    expect(answers.every((answer) => answer.status === 'PAID')).toBe(true);
  });

  it('a payout that was cancelled or failed is not paid by this call', async () => {
    for (const status of ['CANCELLED', 'FAILED']) {
      const { d, payout } = await ready();

      rowsOf(d.world, 'artisanPayout')[0].status = status;

      const answer = await refusal(() => pay(d, payout.id, { paymentReference: 'X' }));

      expect(`${status}: ${answer?.status} ${answer?.message}`).toBe(`${status}: 409 Ce payout est ${status === 'CANCELLED' ? 'annulé' : 'en échec'}: il ne peut pas être marqué comme payé.`);
      expect(rowsOf(d.world, 'artisanPayout')[0].status).toBe(status);
      expect(rowsOf(d.world, 'artisanPayout')[0].paidAt ?? null).toBe(null);
    }
  });

  it('a payout that is still pending can be paid', async () => {
    const { d, payout } = await ready();

    rowsOf(d.world, 'artisanPayout')[0].status = 'PENDING';
    expect((await pay(d, payout.id)).status).toBe('PAID');
  });

  it('turns away a payout that does not exist, a date that is no date, and anyone who is not staff', async () => {
    const { d, payout } = await ready();

    expect((await refusal(() => pay(d, 99999)))?.status).toBe(404);
    expect((await refusal(() => pay(d, payout.id, { paidAt: 'bientôt' })))?.status).toBe(400);
    expect((await refusal(() => pay(d, payout.id, {}, 'CLIENT', d.client.id)))?.status).toBe(403);
    expect((await refusal(() => pay(d, payout.id, {}, 'ARTISAN', d.artisan.id)))?.status).toBe(403);
    expect(rowsOf(d.world, 'artisanPayout')[0].status).toBe('READY');

    for (const [role, id] of [['ADMIN', d.admin.id], ['SUPER_ADMIN', d.superAdmin.id], ['SUPPORT', d.support.id], ['DISPATCHER', d.dispatcher.id]] as const) {
      const fresh = await ready();

      expect(`${role}: ${(await pay(fresh.d, fresh.payout.id, {}, role, id)).status}`).toBe(`${role}: PAID`);
    }
  });

  it('a date typed without an offset is read on the clock of the business, wherever the server runs', async () => {
    const before = process.env.TZ;

    try {
      for (const zone of ['UTC', 'Africa/Tunis', 'America/Los_Angeles', 'Pacific/Auckland']) {
        process.env.TZ = zone;

        const { d, payout } = await ready();
        const paid = await pay(d, payout.id, { paidAt: '2026-11-02T09:30:00' });

        // Tunis is one hour ahead of UTC all year
        expect(`${zone}: ${paid.paidAt.toISOString()}`).toBe(`${zone}: 2026-11-02T08:30:00.000Z`);
      }
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });

  const HELD = (count: number) => `Ce payout ne peut pas être marqué comme payé: ${count} intervention(s) ont changé depuis sa création (litige, remboursement, espèces déjà encaissées, travail non terminé, paiement incomplet ou montant). Annulez-le puis refaites-le.`;

  it('a payout whose job has been disputed since it was made is not paid until the dispute is decided', async () => {
    const { d, payout } = await ready();
    const jobId = rowsOf(d.world, 'artisanPayoutItem')[0].interventionId as number;

    d.world.memory.plant('complaint', { interventionId: jobId, userId: d.client.id, title: 'Souci', description: 'Fuite', status: 'OPEN' });

    const answer = await refusal(() => pay(d, payout.id, { paymentReference: 'VIR-9' }));

    expect(answer?.status).toBe(409);
    expect(answer?.message).toBe(HELD(1));
    expect(rowsOf(d.world, 'artisanPayout')[0].status).toBe('READY');
    expect(rowsOf(d.world, 'artisanPayout')[0].paidAt ?? null).toBe(null);
    expect(rowsOf(d.world, 'artisanPayout')[0].paymentReference ?? null).toBe(null);

    rowsOf(d.world, 'complaint')[0].status = 'RESOLVED';
    expect((await pay(d, payout.id)).status).toBe('PAID');
  });

  it('... nor when a refund has been made since, until the financials record it', async () => {
    const { d, payout } = await ready();
    const jobId = rowsOf(d.world, 'artisanPayoutItem')[0].interventionId as number;

    d.world.memory.plant('payment', { interventionId: jobId, method: 'ONLINE', status: 'PARTIALLY_REFUNDED', amount: 100, amountRefunded: 40, createdById: d.client.id });

    expect((await refusal(() => pay(d, payout.id)))?.message).toBe(HELD(1));

    rowsOf(d.world, 'interventionFinancials')[0].refundAmount = 40;
    expect((await pay(d, payout.id)).status).toBe('PAID');
  });

  it('... nor when the cash for it is confirmed since: the artisan holds it, the payout would pay it again', async () => {
    const { d, payout } = await ready();
    const jobId = rowsOf(d.world, 'artisanPayoutItem')[0].interventionId as number;
    const loose = await d.world.svc.payments.createAdminManualPayment(d.admin.id, jobId, { method: 'CASH', amount: 100 });

    await d.world.svc.payments.confirm(loose.id, d.admin.id, {});

    expect(rowsOf(d.world, 'cashLedgerEntry').length).toBe(1);
    expect((await refusal(() => pay(d, payout.id)))?.message).toBe(HELD(1));
    expect(rowsOf(d.world, 'artisanPayout')[0].status).toBe('READY');
  });

  it('... nor when the artisan has declared part of the cash since: the payout would pay the whole share', async () => {
    const d = desk();
    const { intervention } = d.job(100, { share: 80 });

    advanceRefunded(d, intervention.id);

    const payout = await create(d);

    expect(String(payout.grossAmount)).toBe('80');

    const declared = await collect(d, intervention.id, 30);

    // declared and not confirmed: the job is not paid in full, the payout cannot be marked as paid
    const answer = await refusal(() => pay(d, payout.id));

    expect(answer?.status).toBe(409);
    expect(answer?.message).toBe(HELD(1));
    expect(rowsOf(d.world, 'artisanPayout')[0].status).toBe('READY');

    await d.world.svc.business.cancelPayout(d.admin.id, 'ADMIN', payout.id);

    // confirmed: the payout is made again, and pays the part that did not go through the artisan's hand
    confirmed(d, declared.payment.id);

    const again = await create(d);

    expect(String(again.grossAmount)).toBe('56');
    expect((await pay(d, again.id)).status).toBe('PAID');
  });

  it('... nor when part of the cash was confirmed since, a payment that nobody had declared', async () => {
    const d = desk();
    const { intervention } = d.job(100, { share: 80 });

    advanceRefunded(d, intervention.id);

    const payout = await create(d);

    // a cash payment confirmed the way it was before the ledger: the financials were not worked out again
    d.world.memory.plant('payment', { interventionId: intervention.id, method: 'CASH', status: 'PAID', amount: 30, amountRefunded: 0, createdById: d.client.id });

    expect((await refusal(() => pay(d, payout.id)))?.message).toBe(HELD(1));
    expect(rowsOf(d.world, 'artisanPayout')[0].status).toBe('READY');
  });

  it('... and when the back office confirms the cash through the payments, the price stays the 100 of the job: the payout is made again for 56 (P2-03)', async () => {
    const d = desk();
    const { intervention } = d.job(100, { share: 80 });

    advanceRefunded(d, intervention.id);

    const payout = await create(d);
    const loose = await d.world.svc.payments.createAdminManualPayment(d.admin.id, intervention.id, { method: 'CASH', amount: 30 });

    await d.world.svc.payments.confirm(loose.id, d.admin.id, {});

    // 130 was received but 30 of it came back and was paid again: the job is paid for once
    expect(rowsOf(d.world, 'interventionFinancials').map((row) => [String(row.totalPrice), String(row.artisanPayout), String(row.refundAmount)])).toEqual([['100', '80', '30']]);
    expect((await refusal(() => pay(d, payout.id)))?.message).toBe(HELD(1));

    await d.world.svc.business.cancelPayout(d.admin.id, 'ADMIN', payout.id);

    expect(String((await create(d)).grossAmount)).toBe('56');
  });

  it('... a cash declaration that is cancelled leaves the payout at the full share: the job was never paid in cash', async () => {
    const d = desk();
    const { intervention } = d.job(100, { share: 80 });

    advanceRefunded(d, intervention.id);

    const declared = await collect(d, intervention.id, 30);

    // the 100 paid online cover the job; the cash declared on top of it is held back from the share until it is cancelled or confirmed
    expect((await preview(d)).included.map((item) => [item.amount, item.cashHeld])).toEqual([[56, 30]]);

    await d.world.svc.payments.cancel(declared.payment.id, d.admin.id, {});

    expect((await preview(d)).included.map((item) => [item.amount, item.cashHeld])).toEqual([[80, 0]]);

    const payout = await create(d);

    expect(String(payout.grossAmount)).toBe('80');
    expect((await pay(d, payout.id)).status).toBe('PAID');
  });

  it('... nor when the share of the job was worked out again since', async () => {
    const { d, payout } = await ready();

    rowsOf(d.world, 'interventionFinancials')[0].artisanPayout = 70;

    expect((await refusal(() => pay(d, payout.id)))?.message).toBe(HELD(1));
    expect(rowsOf(d.world, 'artisanPayout')[0].status).toBe('READY');
  });

  it('... nor when the financials of one of its jobs are gone', async () => {
    const { d, payout } = await ready();

    rowsOf(d.world, 'interventionFinancials').splice(0, 1);

    expect((await refusal(() => pay(d, payout.id)))?.message).toBe(HELD(1));
    expect(rowsOf(d.world, 'artisanPayout')[0].status).toBe('READY');
  });

  it('one held job refuses the whole payout, and says how many', async () => {
    const d = desk();

    d.job(100);

    const held = d.job(200);
    const third = d.job(300);
    const payout = await create(d);

    for (const job of [held, third]) d.world.memory.plant('complaint', { interventionId: job.intervention.id, userId: d.client.id, title: 'Souci', description: 'Fuite', status: 'OPEN' });

    expect((await refusal(() => pay(d, payout.id)))?.message).toBe(HELD(2));
    expect(rowsOf(d.world, 'artisanPayout')[0].status).toBe('READY');
  });

  it('a job that is held but is not in the payout does not stop it being paid', async () => {
    const { d, payout } = await ready();
    const later = d.job(200);

    d.world.memory.plant('complaint', { interventionId: later.intervention.id, userId: d.client.id, title: 'Souci', description: 'Fuite', status: 'OPEN' });

    expect((await pay(d, payout.id)).status).toBe('PAID');
  });

  it('a payout that is paid already is answered as it is, even if a job has been held since', async () => {
    const { d, payout } = await ready();
    const first = await pay(d, payout.id, { paymentReference: 'VIR-1', paidAt: '2026-11-02T09:30:00.000Z' });
    const jobId = rowsOf(d.world, 'artisanPayoutItem')[0].interventionId as number;

    d.world.memory.plant('complaint', { interventionId: jobId, userId: d.client.id, title: 'Souci', description: 'Fuite', status: 'OPEN' });

    const again = await pay(d, payout.id, { paymentReference: 'VIR-2' });

    expect(again.status).toBe('PAID');
    expect(again.paymentReference).toBe('VIR-1');
    expect(again.paidAt.toISOString()).toBe(first.paidAt.toISOString());
  });

  it('paying waits for the payouts of the artisan and then decides on what it finds', async () => {
    const { d, payout } = await ready();
    const run = await whilePayoutsLocked(d, () => pay(d, payout.id), () => rowsOf(d.world, 'artisanPayout')[0].status);

    expect(run.seen).toBe('READY');
    expect(run.answer).toBe(null);
    expect(rowsOf(d.world, 'artisanPayout')[0].status).toBe('PAID');
  });

  it('a payout that does not exist is not found, whatever else is wrong with the call', async () => {
    const { d } = await ready();
    const answer = await refusal(() => pay(d, 99999, { paidAt: 'bientôt' }));

    expect(answer?.status).toBe(404);
    expect(answer?.message).toBe('Payout introuvable.');
  });

  it('what a payout answers is made of the stored row, whose amounts are Decimal in the database', async () => {
    const { d, payout } = await ready();

    expect(rowsOf(d.world, 'artisanPayout')[0].grossAmount).toBeInstanceOf(Decimal);
    expect(String(payout.grossAmount)).toBe('100');
  });
});

describe('a payout that was not paid can be cancelled (P2-02)', () => {
  beforeEach(() => resetLocale());

  async function ready() {
    const d = desk();
    const job = d.job(100);
    const payout = await create(d);

    return { d, job, payout };
  }

  const cancel = (d: Desk, id: number, role = 'ACCOUNTANT', userId = d.accountant.id) => d.world.svc.business.cancelPayout(userId, role as any, id);
  const pay = (d: Desk, id: number) => d.world.svc.business.markPayoutPaid(d.accountant.id, 'ACCOUNTANT' as any, id, {} as any);

  it('cancels it, keeps its lines for the record, and offers its jobs to the next payout', async () => {
    const { d, job, payout } = await ready();
    const cancelled = await cancel(d, payout.id);

    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.items.length).toBe(1);
    expect(rowsOf(d.world, 'artisanPayoutItem').length).toBe(1);
    expect(rowsOf(d.world, 'artisanPayout')[0].paidAt ?? null).toBe(null);
    expect(await isIncluded(d, job.intervention.id)).toBe(true);

    const next = await create(d);

    expect(next.status).toBe('READY');
    expect(next.id).not.toBe(payout.id);
    expect(rowsOf(d.world, 'artisanPayout').map((row) => row.status)).toEqual(['CANCELLED', 'READY']);
  });

  it('cancelling twice changes nothing; a failed or pending payout can be cancelled; a paid one cannot', async () => {
    const outcomes: string[] = [];

    for (const status of ['PENDING', 'READY', 'FAILED', 'CANCELLED', 'PAID']) {
      const { d, payout } = await ready();

      rowsOf(d.world, 'artisanPayout')[0].status = status;

      const answer = await refusal(() => cancel(d, payout.id));

      outcomes.push(`${status}: ${answer ? `${answer.status} ${answer.message}` : rowsOf(d.world, 'artisanPayout')[0].status}`);
    }

    expect(outcomes).toEqual(['PENDING: CANCELLED', 'READY: CANCELLED', 'FAILED: CANCELLED', 'CANCELLED: CANCELLED', 'PAID: 409 Ce payout est déjà payé: il ne peut plus être annulé.']);

    const { d, payout } = await ready();
    const first = await cancel(d, payout.id);
    const again = await cancel(d, payout.id);

    expect(again.status).toBe('CANCELLED');
    expect(again.items.length).toBe(first.items.length);
  });

  it('a payout that was cancelled is not paid afterwards', async () => {
    const { d, payout } = await ready();

    await cancel(d, payout.id);

    const answer = await refusal(() => pay(d, payout.id));

    expect(answer?.status).toBe(409);
    expect(answer?.message).toBe('Ce payout est annulé: il ne peut pas être marqué comme payé.');
  });

  it('turns away a payout that does not exist and anyone who is not staff; every back office role may cancel', async () => {
    const { d, payout } = await ready();

    expect((await refusal(() => cancel(d, 99999)))?.message).toBe('Payout introuvable.');
    expect((await refusal(() => cancel(d, 99999)))?.status).toBe(404);
    expect((await refusal(() => cancel(d, payout.id, 'CLIENT', d.client.id)))?.status).toBe(403);
    expect((await refusal(() => cancel(d, payout.id, 'ARTISAN', d.artisan.id)))?.status).toBe(403);
    expect(rowsOf(d.world, 'artisanPayout')[0].status).toBe('READY');

    for (const [role, id] of [['ADMIN', d.admin.id], ['SUPER_ADMIN', d.superAdmin.id], ['SUPPORT', d.support.id], ['DISPATCHER', d.dispatcher.id], ['ACCOUNTANT', d.accountant.id]] as const) {
      const fresh = await ready();

      expect(`${role}: ${(await cancel(fresh.d, fresh.payout.id, role, id)).status}`).toBe(`${role}: CANCELLED`);
    }
  });

  it('paying and cancelling at the same moment: one wins, and the payout says which', async () => {
    const { d, payout } = await ready();
    const answers = await Promise.all([refusal(() => pay(d, payout.id)), refusal(() => cancel(d, payout.id))]);
    const status = rowsOf(d.world, 'artisanPayout')[0].status;

    expect(answers.filter((answer) => answer === null).length).toBe(1);
    expect(['PAID', 'CANCELLED']).toContain(status);
    expect(answers[status === 'PAID' ? 1 : 0]?.status).toBe(409);
  });

  it('cancelling waits for the payouts of the artisan', async () => {
    const { d, payout } = await ready();
    const run = await whilePayoutsLocked(d, () => cancel(d, payout.id), () => rowsOf(d.world, 'artisanPayout')[0].status);

    expect(run.seen).toBe('READY');
    expect(run.answer).toBe(null);
    expect(rowsOf(d.world, 'artisanPayout')[0].status).toBe('CANCELLED');
  });
});

describe('a payout waits for the work and for the whole price (P2-03)', () => {
  const quoteFor = (d: Desk, interventionId: number, amountTTC: number, fields: Record<string, unknown> = {}) =>
    d.world.memory.plant('quote', { interventionId, createdById: d.artisan.id, status: 'ACCEPTED', amountHT: amountTTC, taxAmount: 0, amountTTC, ...fields });
  const paid = (d: Desk, interventionId: number, amount: number, fields: Record<string, unknown> = {}) =>
    d.world.memory.plant('payment', { interventionId, method: 'ONLINE', status: 'PAID', amount, amountRefunded: 0, createdById: d.client.id, ...fields });
  const pay = (d: Desk, id: number) => d.world.svc.business.markPayoutPaid(d.accountant.id, 'ACCOUNTANT' as any, id, {} as any);
  const HELD = (count: number) => `Ce payout ne peut pas être marqué comme payé: ${count} intervention(s) ont changé depuis sa création (litige, remboursement, espèces déjà encaissées, travail non terminé, paiement incomplet ou montant). Annulez-le puis refaites-le.`;
  const statusOf = (d: Desk, interventionId: number, status: string) => {
    rowsOf(d.world, 'intervention').find((row) => row.id === interventionId)!.status = status;
  };

  it('a deposit is not the whole price: the job is held as NOT_PAID until the rest is received', async () => {
    const d = desk();
    const { intervention } = d.job(100, { share: 80 });

    quoteFor(d, intervention.id, 100);
    paid(d, intervention.id, 40);

    expect(await heldReasons(d, intervention.id)).toEqual(['NOT_PAID']);
    expect((await refusal(() => create(d)))?.status).toBe(400);

    paid(d, intervention.id, 60);

    expect(await heldReasons(d, intervention.id)).toBe(null);
    expect(await isIncluded(d, intervention.id)).toBe(true);
  });

  it('the invoice is what the job asks for when it has one, over the quote; a cancelled invoice is not', async () => {
    const d = desk();
    const { intervention } = d.job(100, { share: 80 });

    quoteFor(d, intervention.id, 100);
    paid(d, intervention.id, 100);

    const invoice = d.world.memory.plant('invoice', { interventionId: intervention.id, status: 'ISSUED', amountHT: 150, taxAmount: 0, amountTTC: 150, currency: 'TND' });

    expect(await heldReasons(d, intervention.id)).toEqual(['NOT_PAID']);

    rowsOf(d.world, 'invoice').find((row) => row.id === invoice.id)!.status = 'CANCELLED';
    expect(await heldReasons(d, intervention.id)).toBe(null);
  });

  it('a draft invoice is not what the job asks for: the quote is, as for the payment position', async () => {
    const d = desk();
    const { intervention } = d.job(100, { share: 80 });

    quoteFor(d, intervention.id, 100);
    paid(d, intervention.id, 100);

    const invoice = d.world.memory.plant('invoice', { interventionId: intervention.id, status: 'DRAFT', amountHT: 150, taxAmount: 0, amountTTC: 150, currency: 'TND' });

    expect(await heldReasons(d, intervention.id)).toBe(null);

    rowsOf(d.world, 'invoice').find((row) => row.id === invoice.id)!.status = 'ISSUED';
    expect(await heldReasons(d, intervention.id)).toEqual(['NOT_PAID']);
  });

  it('the latest accepted quote is what it asks for when there is no invoice', async () => {
    const d = desk();
    const { intervention } = d.job(100, { share: 80 });

    quoteFor(d, intervention.id, 100, { createdAt: new Date('2026-10-01T09:00:00.000Z') });
    quoteFor(d, intervention.id, 150, { createdAt: new Date('2026-10-02T09:00:00.000Z') });
    paid(d, intervention.id, 100);

    expect(await heldReasons(d, intervention.id)).toEqual(['NOT_PAID']);

    paid(d, intervention.id, 50);
    expect(await heldReasons(d, intervention.id)).toBe(null);
  });

  it('a quote that was not accepted asks for nothing', async () => {
    const d = desk();
    const { intervention } = d.job(100, { share: 80 });

    quoteFor(d, intervention.id, 500, { status: 'REJECTED' });
    paid(d, intervention.id, 100);

    expect(await heldReasons(d, intervention.id)).toBe(null);
  });

  it('one millime short is not paid', async () => {
    const d = desk();
    const { intervention } = d.job(100, { share: 80 });

    quoteFor(d, intervention.id, 100);
    paid(d, intervention.id, 99.999);

    expect(await heldReasons(d, intervention.id)).toEqual(['NOT_PAID']);

    paid(d, intervention.id, 0.001);

    expect(await heldReasons(d, intervention.id)).toBe(null);
  });

  it('what went back to the customer does not make the job unpaid: what was received is what counts', async () => {
    const d = desk();
    const { intervention } = d.job(100, { share: 80, refundAmount: 30 });

    quoteFor(d, intervention.id, 100);
    paid(d, intervention.id, 100, { status: 'PARTIALLY_REFUNDED', amountRefunded: 30 });

    expect(await heldReasons(d, intervention.id)).toBe(null);
  });

  it('only confirmed payments count: waiting, failed and cancelled ones do not', async () => {
    const outcomes: string[] = [];

    for (const status of ['PENDING', 'AWAITING_CONFIRMATION', 'FAILED', 'CANCELLED', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED']) {
      const d = desk();
      const { intervention } = d.job(100, { share: 80, refundAmount: 100 });

      quoteFor(d, intervention.id, 100);
      paid(d, intervention.id, 100, { status, amountRefunded: status === 'REFUNDED' ? 100 : 0 });
      outcomes.push(`${status}: ${(await heldReasons(d, intervention.id))?.join(',') ?? 'free'}`);
    }

    expect(outcomes).toEqual(['PENDING: NOT_PAID', 'AWAITING_CONFIRMATION: NOT_PAID', 'FAILED: NOT_PAID', 'CANCELLED: NOT_PAID', 'PAID: free', 'PARTIALLY_REFUNDED: free', 'REFUNDED: free']);
  });

  it('a price in another currency cannot be compared with the sums of the company: it does not hold the job', async () => {
    const d = desk();
    const { intervention } = d.job(100, { share: 80 });

    quoteFor(d, intervention.id, 500, { currency: 'EUR' });
    paid(d, intervention.id, 100);

    expect(await heldReasons(d, intervention.id)).toBe(null);
  });

  it('a job with no accepted quote and no invoice has nothing to compare with: the payments it has are enough', async () => {
    const d = desk();
    const { intervention } = d.job(100, { share: 80 });

    paid(d, intervention.id, 10);

    expect(await heldReasons(d, intervention.id)).toBe(null);
  });

  it('financials typed by hand with a quote and no payment are held: they come from payments now', async () => {
    const d = desk();
    const { intervention } = d.job(100, { share: 80 });

    quoteFor(d, intervention.id, 100);

    expect(await heldReasons(d, intervention.id)).toEqual(['NOT_PAID']);
  });

  it('a job whose work is not done is held as NOT_FINISHED, even when the customer paid it all in advance', async () => {
    const outcomes: string[] = [];

    for (const status of ['PENDING', 'ASSIGNED', 'ARTISAN_ARRIVED', 'ARRIVED', 'ON_THE_WAY', 'IN_PROGRESS', 'WAITING_CLIENT_VALIDATION', 'CANCELLED', 'COMPLETED', 'PAYMENT_PENDING', 'PAID', 'INVOICE_SENT', 'INVOICE_READY', 'SOMETHING_ELSE']) {
      const d = desk();
      const { intervention } = d.job(100, { share: 80 });

      quoteFor(d, intervention.id, 100);
      paid(d, intervention.id, 100);
      statusOf(d, intervention.id, status);
      outcomes.push(`${status}: ${(await heldReasons(d, intervention.id))?.join(',') ?? 'free'}`);
    }

    expect(outcomes).toEqual([
      'PENDING: NOT_FINISHED',
      'ASSIGNED: NOT_FINISHED',
      'ARTISAN_ARRIVED: NOT_FINISHED',
      'ARRIVED: NOT_FINISHED',
      'ON_THE_WAY: NOT_FINISHED',
      'IN_PROGRESS: NOT_FINISHED',
      'WAITING_CLIENT_VALIDATION: NOT_FINISHED',
      'CANCELLED: NOT_FINISHED',
      'COMPLETED: free',
      'PAYMENT_PENDING: free',
      'PAID: free',
      'INVOICE_SENT: free',
      'INVOICE_READY: free',
      'SOMETHING_ELSE: NOT_FINISHED',
    ]);
  });

  it('a financial whose job cannot be found is not held for the work: nothing is known about it', async () => {
    const d = desk();
    const decisions = await payoutDecisions(d.world.prisma, d.artisan.id, [{ id: 1, interventionId: 999, totalPrice: 100, artisanPayout: 80, refundAmount: 0 }]);

    expect(decisions.get(1)?.reasons).toEqual([]);
  });

  it('a job in dispute is held for the dispute, not also as unfinished', async () => {
    const d = desk();
    const { intervention } = d.job(100, { share: 80, status: 'DISPUTED' });

    quoteFor(d, intervention.id, 100);
    paid(d, intervention.id, 100);

    expect(await heldReasons(d, intervention.id)).toEqual(['OPEN_DISPUTE']);
  });

  it('a job can be unfinished, unpaid and in dispute at once: each reason is named', async () => {
    const d = desk();
    const { intervention } = d.job(100, { share: 80, status: 'IN_PROGRESS' });

    quoteFor(d, intervention.id, 100);
    paid(d, intervention.id, 30);
    d.world.memory.plant('complaint', { interventionId: intervention.id, userId: d.client.id, title: 'Souci', description: 'Fuite', status: 'OPEN' });

    expect(await heldReasons(d, intervention.id)).toEqual(['OPEN_DISPUTE', 'NOT_FINISHED', 'NOT_PAID']);
  });

  it('the cash the artisan declared counts as paid once the back office has confirmed it, and only once', async () => {
    const d = desk();
    const { intervention } = d.job(100, { share: 80 });

    underWay(d, intervention.id, 100, 60);

    const declared = await collect(d, intervention.id, 40);

    // declared, not confirmed: 60 of 100 are paid
    expect(await heldReasons(d, intervention.id)).toEqual(['NOT_PAID']);

    // confirmed: the cash is a payment of 40 and the ledger line is the same 40; 60 + 40 is 100, and 40 are in the artisan's hand
    confirmed(d, declared.payment.id);
    expect((await preview(d)).included.map((item) => [item.amount, item.cashHeld])).toEqual([[48, 40]]);

    // short of 10: 50 online and 40 in cash do not make 100
    rowsOf(d.world, 'payment').find((row) => row.method === 'ONLINE')!.amount = 50;
    expect(await heldReasons(d, intervention.id)).toEqual(['NOT_PAID']);
  });

  it('the preview and the payout agree: a payout is made only for the jobs that are finished and paid', async () => {
    const d = desk();
    const ready = d.job(100, { share: 80 });
    const deposit = d.job(200, { share: 160 });
    const working = d.job(300, { share: 240, status: 'IN_PROGRESS' });

    for (const [job, total, received] of [[ready, 100, 100], [deposit, 200, 50], [working, 300, 300]] as const) {
      quoteFor(d, job.intervention.id, total);
      paid(d, job.intervention.id, received);
    }

    const shown = await preview(d);

    expect(shown.included.map((item) => item.interventionId)).toEqual([ready.intervention.id]);
    expect(shown.held.map((item) => [item.interventionId, item.reasons])).toEqual([[deposit.intervention.id, ['NOT_PAID']], [working.intervention.id, ['NOT_FINISHED']]]);

    const payout = await create(d);

    expect(String(payout.netAmount)).toBe('80');
    expect(rowsOf(d.world, 'artisanPayoutItem').map((item) => item.interventionId)).toEqual([ready.intervention.id]);
  });

  it('a payout that was made is not paid when the job it holds went back to the work meanwhile', async () => {
    const d = desk();
    const { intervention } = d.job(100, { share: 80 });

    quoteFor(d, intervention.id, 100);
    paid(d, intervention.id, 100);

    const payout = await create(d);

    statusOf(d, intervention.id, 'IN_PROGRESS');

    expect((await refusal(() => pay(d, payout.id)))?.message).toBe(HELD(1));
    expect(rowsOf(d.world, 'artisanPayout')[0].status).toBe('READY');
  });
});
