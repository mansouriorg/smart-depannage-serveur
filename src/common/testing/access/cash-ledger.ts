import { Scenario, SelfScenario } from '../access-matrix';
import { Household, World, mark } from '../world';

const job = (h: Household, w: World) => w.ids[h].intervention;
const artisan = (h: Household, w: World) => w.ids[h].artisan;

/** The job is under way, so its artisan may say they were paid; the payment the seed holds (online, waiting) is out of the way (P2-03). */
const underWay = (w: World) => {
  w.set('intervention', { status: 'IN_PROGRESS' });
  w.set('payment', { status: 'CANCELLED', cancelledAt: new Date('2026-01-02T00:00:00Z') });
};

const PERIOD = { periodStart: '2020-01-01T00:00:00.000Z', periodEnd: '2100-01-01T00:00:00.000Z' };

export const cashLedgerScenarios: Scenario[] = [
  {
    route: 'POST /cash-ledger/interventions/:/collect-cash',
    note: 'the artisan of the job says they took cash: the artisan of the other household is turned away, and nothing is written',
    allowed: ['artisan'],
    prepare: underWay,
    request: (h, w) => ({ params: { interventionId: job(h, w) }, body: { amount: 50, note: mark(h, 'collect note'), requestKey: 'tap-access-0001' } }),
  },
  {
    route: 'GET /cash-ledger/interventions/:/position',
    // Not `reads`: the answer is figures and one sentence of the server's own (no text of the household is in it for the
    // matrix to find), so "it carries the household's rows" cannot be asked of it. The figures are checked in cash-position.spec.
    note: 'what is left to take on a job (P2-05): the artisan of the job reads it; the artisan of the other household is told the job does not exist',
    allowed: ['artisan'],
    prepare: underWay,
    request: (h, w) => ({ params: { interventionId: job(h, w) } }),
  },
  {
    route: 'GET /cash-ledger/artisans/:',
    note: 'the ledger of an artisan: the administrators and the accountant, with the lines of that artisan',
    allowed: ['admins', 'accountant'],
    reads: true,
    request: (h, w) => ({ params: { artisanId: artisan(h, w) }, query: {} }),
  },
  { route: 'GET /cash-ledger/balances', allowed: ['admins', 'accountant'], request: () => ({}) },
  {
    route: 'POST /cash-ledger/artisans/:/remittances',
    note: 'the artisan owes 24 on the cash the seed holds: a payment of 10 is recorded by the people who handle money, and by nobody else',
    allowed: ['admins', 'accountant'],
    request: (h, w) => ({ params: { artisanId: artisan(h, w) }, body: { amount: 10, reference: 'VIR-1' } }),
  },
  {
    route: 'POST /cash-ledger/artisans/:/adjustments',
    allowed: ['admins', 'accountant'],
    request: (h, w) => ({ params: { artisanId: artisan(h, w) }, body: { commissionAmount: -5, reason: 'correction' } }),
  },
  {
    route: 'GET /business/payouts/preview',
    note: 'what a payout would pay: the whole back office (it writes nothing)',
    allowed: ['backOffice'],
    request: (h, w) => ({ query: { artisanId: artisan(h, w), ...PERIOD } }),
  },
];

export const cashLedgerSelfScenarios: SelfScenario[] = [
  {
    route: 'GET /cash-ledger/mine',
    note: 'household B has taken 100 more in cash than A: the figures are the caller\'s own',
    servedRoles: ['ARTISAN'],
    reads: true,
    prepare: (w) => {
      for (let n = 0; n < 2; n++) w.fill('cashLedgerEntry', { artisanId: w.ids.B.artisan, type: 'COLLECTION', cashAmount: 50, commissionAmount: 10, commissionRate: 20, note: mark('B', `extra cash ${n}`) });
    },
    request: () => ({ query: {} }),
    answer: (person, value) => {
      if (person.household === null) return null;

      const totals = (value as { totals?: { cashCollected?: number; balance?: number } })?.totals;
      const want = person.household === 'A' ? { cashCollected: 120, balance: 24 } : { cashCollected: 220, balance: 44 };

      return totals?.cashCollected === want.cashCollected && totals?.balance === want.balance ? null : `was told figures that are not theirs: ${JSON.stringify(totals)}`;
    },
  },
];
