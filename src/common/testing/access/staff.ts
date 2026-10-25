import { Scenario } from '../access-matrix';
import { Household, World, markStart } from '../world';

const job = (h: Household, w: World) => w.ids[h].intervention;

/** What no answer to the back office holds: a password, or what is kept to check a link or a session. */
const secrets = (h: Household) => [markStart(h, 'User.password'), markStart(h, 'AuthToken'), markStart(h, 'PushDeviceToken.token')];

const RANGE = { from: '2026-01-01T00:00:00.000Z', to: '2026-12-31T00:00:00.000Z' };

export const staffScenarios: Scenario[] = [
  // ------------------------------------------------------------------ business: money, reports, payouts (the whole back office)
  {
    route: 'GET /business/interventions/:/financials',
    allowed: ['backOffice'],
    request: (h, w) => ({ params: { interventionId: job(h, w) } }),
  },
  { route: 'GET /business/dashboard', allowed: ['backOffice'], request: () => ({ query: RANGE }) },
  { route: 'GET /business/financials', allowed: ['backOffice'], request: () => ({ query: RANGE }) },
  { route: 'GET /business/reports/monthly', allowed: ['backOffice'], request: () => ({}) },
  { route: 'GET /business/payouts', allowed: ['backOffice'], request: () => ({}) },
  {
    route: 'POST /business/interventions/:/financials',
    note: 'the gate: the figures are worked out from the confirmed payments, the body only keeps the rate, the provider fee and the notes (P2-03)',
    allowed: ['backOffice'],
    gateOnly: true,
    request: (h, w) => ({ params: { interventionId: job(h, w) }, body: { commissionRate: 20 } }),
  },
  { route: 'POST /business/reports/monthly', allowed: ['backOffice'], gateOnly: true, request: () => ({ body: { year: 2026, month: 9 } }) },
  {
    route: 'POST /business/payouts',
    allowed: ['backOffice'],
    gateOnly: true,
    request: (h, w) => ({ body: { artisanId: w.ids[h].artisan, periodStart: '2026-09-01T00:00:00.000Z', periodEnd: '2026-09-30T00:00:00.000Z' } }),
  },
  {
    route: 'PATCH /business/payouts/:/paid',
    note: 'a payout that exists: the whole back office marks it paid, and nobody else can',
    allowed: ['backOffice'],
    request: (h, w) => ({ params: { payoutId: w.ids[h].payout }, body: { paymentReference: 'VIR-1' } }),
  },
  {
    route: 'PATCH /business/payouts/:/cancel',
    note: 'a payout that exists: the whole back office cancels it, and nobody else can',
    allowed: ['backOffice'],
    request: (h, w) => ({ params: { payoutId: w.ids[h].payout } }),
  },
  { route: 'GET /business/exports/revenue/csv', allowed: ['backOffice'], gateOnly: true, request: () => ({ query: RANGE }) },
  { route: 'GET /business/exports/revenue/pdf', allowed: ['backOffice'], gateOnly: true, request: () => ({ query: RANGE }) },
  { route: 'GET /business/exports/accounting', allowed: ['backOffice'], gateOnly: true, request: () => ({ query: RANGE }) },

  // ------------------------------------------------------------------ matching: the dispatcher's tools
  {
    route: 'GET /matching/admin/interventions/:/artisans',
    allowed: ['assigners'],
    gateOnly: true,
    request: (h, w) => ({ params: { interventionId: job(h, w) } }),
  },
  { route: 'GET /matching/admin/artisans', allowed: ['assigners'], gateOnly: true, request: () => ({ query: {} }) },
  {
    route: 'POST /matching/admin/interventions/:/assign-best',
    allowed: ['assigners'],
    gateOnly: true,
    request: (h, w) => ({ params: { interventionId: job(h, w) } }),
  },
  {
    route: 'POST /matching/admin/interventions/:/assign/:',
    allowed: ['assigners'],
    gateOnly: true,
    request: (h, w) => ({ params: { interventionId: job(h, w), artisanId: w.ids[h].artisan } }),
  },

  // ------------------------------------------------------------------ the back office's own screens: what they hold, and what they never show
  {
    route: 'GET /admin/interventions/:',
    allowed: ['ticketStaff'],
    reads: true,
    request: (h, w) => ({ params: { id: job(h, w) } }),
    hidden: secrets,
  },
  { route: 'GET /admin/interventions', allowed: ['ticketStaff'], reads: true, request: () => ({ query: {} }), hidden: secrets },
  {
    route: 'GET /admin/artisans/:',
    allowed: ['verifiers'],
    reads: true,
    request: (h, w) => ({ params: { profileId: w.ids[h].artisanProfile } }),
    hidden: secrets,
  },
  { route: 'GET /admin/artisans', allowed: ['verifiers'], reads: true, request: () => ({ query: {} }), hidden: secrets },
  {
    route: 'GET /admin/clients/:',
    allowed: ['backOffice'],
    reads: true,
    request: (h, w) => ({ params: { clientId: w.ids[h].client } }),
    hidden: secrets,
  },
  { route: 'GET /admin/clients', allowed: ['backOffice'], reads: true, request: () => ({ query: {} }), hidden: secrets },
  {
    route: 'GET /admin/complaints/:',
    allowed: ['verifiers', 'accountant'],
    reads: true,
    request: (h, w) => ({ params: { complaintId: w.ids[h].complaint } }),
    hidden: secrets,
  },
  { route: 'GET /admin/complaints', allowed: ['verifiers', 'accountant'], reads: true, request: () => ({ query: {} }), hidden: secrets },
  { route: 'GET /admin/dashboard/kpis', allowed: ['backOffice'], request: () => ({ query: {} }) },
  {
    route: 'GET /admin/artisans/:/missions',
    allowed: ['backOffice'],
    reads: true,
    request: (h, w) => ({ params: { profileId: w.ids[h].artisanProfile }, query: {} }),
    hidden: secrets,
  },
  {
    route: 'GET /admin/artisans/:/location',
    allowed: ['backOffice'],
    request: (h, w) => ({ params: { profileId: w.ids[h].artisanProfile } }),
  },
];
