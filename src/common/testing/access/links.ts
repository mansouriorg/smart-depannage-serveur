import { LinkScenario } from '../access-matrix';
import { Household, World, markStart } from '../world';
import { staffOnlyInterventionColumns } from '../../views/intervention-columns';
import { withheldColumns } from './columns';
import { scene, upload } from '../../../modules/proofs/test-photos';

const job = (h: Household, w: World) => w.ids[h].intervention;
const withLink = (token: string | undefined) => (token === undefined ? {} : { token });

/** What a visitor with the link is never shown: the people's addresses and ids, the back office's notes, the hash of the link itself. */
const hiddenFromVisitor = (h: Household) => [
  markStart(h, 'client email'),
  markStart(h, 'artisan email'),
  ...withheldColumns(h, 'Intervention', staffOnlyInterventionColumns()),
  ...withheldColumns(h, 'Intervention', ['trackingToken']),
  markStart(h, 'User.password'),
];

const onQuote = (id: (h: Household, w: World) => number) => (h: Household, token: string | undefined, w: World) => ({
  params: { id: job(h, w), quoteId: id(h, w) },
  query: withLink(token),
  body: {},
});

const quoteOf = (h: Household, w: World) => w.ids[h].quote;

/** A call on the quote of the other household's job, with the right link: another quote is not found. */
const otherQuote = (what: string) => ({
  what,
  request: (jobOf: Household, other: Household, w: World) => ({
    params: { id: job(jobOf, w), quoteId: quoteOf(other, w) },
    query: withLink(`link-of-household-${jobOf}`),
    body: {},
  }),
});

export const linkScenarios: LinkScenario[] = [
  {
    route: 'GET /guest/tracking/:',
    note: 'the job a visitor made without an account, followed with its link',
    reads: true,
    hidden: hiddenFromVisitor,
    request: (h, token, w) => ({ params: { id: job(h, w) }, query: withLink(token) }),
  },
  {
    route: 'GET /guest/interventions/:/quotes',
    reads: true,
    hidden: hiddenFromVisitor,
    request: (h, token, w) => ({ params: { id: job(h, w) }, query: withLink(token) }),
  },
  { route: 'POST /guest/interventions/:/quotes/:/accept', request: onQuote(quoteOf), crossed: [otherQuote('the quote of the other job')] },
  { route: 'POST /guest/interventions/:/quotes/:/reject', request: onQuote(quoteOf), crossed: [otherQuote('the quote of the other job')] },
  { route: 'POST /guest/interventions/:/quotes/:/request-modification', request: onQuote(quoteOf), crossed: [otherQuote('the quote of the other job')] },
  {
    route: 'POST /guest/interventions/:/payments',
    prepare: (w) => {
      w.set('intervention', { status: 'PAYMENT_PENDING' });
      w.set('quote', { status: 'ACCEPTED' });
      // the payment the seed holds is out of the way: a job has one open payment at a time (P2-03)
      w.set('payment', { status: 'CANCELLED', cancelledAt: new Date('2026-01-02T00:00:00Z') });
    },
    request: (h, token, w) => ({ params: { id: job(h, w) }, query: withLink(token), body: { method: 'CASH' } }),
  },
  {
    route: 'POST /guest/interventions/:/feedback',
    prepare: (w) => {
      w.set('intervention', { status: 'PAID' });
      w.clear('review');
    },
    request: (h, token, w) => ({ params: { id: job(h, w) }, query: withLink(token), body: { rating: 5, isOnTime: true } }),
  },
  {
    route: 'POST /guest/interventions/:/photos',
    request: async (h, token, w) => ({ params: { id: job(h, w) }, query: withLink(token), files: [upload(await scene(7))] }),
  },
  {
    route: 'POST /guest/interventions/:/problems',
    request: (h, token, w) => ({ params: { id: job(h, w) }, query: withLink(token), body: { title: 'Fuite', description: 'Ça fuit encore' } }),
  },
  {
    route: 'GET /public/tracking/:',
    reads: true,
    hidden: hiddenFromVisitor,
    request: (h, token, w) => ({ params: { id: job(h, w) }, query: withLink(token) }),
  },
  {
    route: 'GET /interventions/track/:',
    reads: true,
    hidden: hiddenFromVisitor,
    request: (h, token, w) => ({ params: { id: String(job(h, w)) }, query: withLink(token) }),
  },
  {
    route: 'PATCH /interventions/track/:/feedback',
    prepare: (w) => {
      w.set('intervention', { status: 'PAID' });
      w.clear('review');
    },
    request: (h, token, w) => ({ params: { id: String(job(h, w)) }, query: withLink(token), body: { rating: 5, isOnTime: true } }),
  },
  {
    route: 'POST /interventions/track/:/issue',
    prepare: (w) => w.set('intervention', { status: 'IN_PROGRESS' }),
    request: (h, token, w) => ({ params: { id: String(job(h, w)) }, query: withLink(token), body: { issueDescription: 'Ça fuit encore' } }),
  },
  {
    route: 'GET /interventions/public/:/timeline',
    reads: true,
    hidden: hiddenFromVisitor,
    request: (h, token, w) => ({ params: { id: job(h, w) }, query: withLink(token) }),
  },
];
