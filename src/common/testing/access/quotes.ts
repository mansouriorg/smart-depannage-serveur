import { Scenario } from '../access-matrix';
import { Household, World } from '../world';

const job = (h: Household, w: World) => w.ids[h].intervention;
const quote = (h: Household, w: World) => w.ids[h].quote;
const items = [{ label: 'Main d’œuvre', quantity: 1, unitPrice: 100 }];
const draft = (w: World) => w.set('quote', { status: 'DRAFT' });

export const quoteScenarios: Scenario[] = [
  {
    route: 'POST /quotes/interventions/:',
    note: 'a quote on a job: the back office, or the artisan of that job',
    allowed: ['artisan', 'ticketStaff'],
    request: (h, w) => ({ params: { interventionId: job(h, w) }, body: { title: 'Devis', items } }),
  },
  {
    route: 'POST /quotes/interventions/:/draft',
    allowed: ['artisan', 'ticketStaff'],
    request: (h, w) => ({ params: { interventionId: job(h, w) }, body: { title: 'Brouillon', items } }),
  },
  {
    route: 'GET /quotes/interventions/:',
    note: 'the customer reads the quotes of their job (the guard also lets the back office in; the service answers it 403: it reads the quotes with GET /quotes/:quoteId)',
    allowed: ['client'],
    reads: true,
    request: (h, w) => ({ params: { interventionId: job(h, w) } }),
  },
  {
    route: 'PATCH /quotes/:',
    allowed: ['artisan', 'ticketStaff'],
    request: (h, w) => ({ params: { quoteId: quote(h, w) }, body: { title: 'Nouveau titre' } }),
  },
  {
    route: 'POST /quotes/:/send',
    allowed: ['artisan', 'ticketStaff'],
    prepare: draft,
    request: (h, w) => ({ params: { quoteId: quote(h, w) } }),
  },
  {
    route: 'POST /quotes/:/cancel',
    allowed: ['artisan', 'ticketStaff'],
    request: (h, w) => ({ params: { quoteId: quote(h, w) }, body: { note: 'Erreur de prix' } }),
  },
  {
    route: 'PATCH /quotes/:/pdf',
    allowed: ['artisan', 'ticketStaff'],
    request: (h, w) => ({ params: { quoteId: quote(h, w) }, body: { pdfUrl: '/files/9/download' } }),
  },
  {
    route: 'POST /quotes/:/accept',
    allowed: ['client'],
    request: (h, w) => ({ params: { quoteId: quote(h, w) }, body: {} }),
  },
  {
    route: 'POST /quotes/:/reject',
    allowed: ['client'],
    request: (h, w) => ({ params: { quoteId: quote(h, w) }, body: { note: 'Trop cher' } }),
  },
  {
    route: 'POST /quotes/:/request-modification',
    allowed: ['client'],
    request: (h, w) => ({ params: { quoteId: quote(h, w) }, body: { note: 'Peut-on baisser le prix ?' } }),
  },
  {
    route: 'POST /quotes/:/question',
    allowed: ['client'],
    request: (h, w) => ({ params: { quoteId: quote(h, w) }, body: { note: 'Quand venez-vous ?' } }),
  },
  {
    route: 'GET /quotes/:/download',
    allowed: ['client'],
    prepare: (w) => w.set('quote', { pdfUrl: '/files/9/download' }),
    request: (h, w) => ({ params: { quoteId: quote(h, w) } }),
  },
  {
    route: 'GET /quotes/:/revisions',
    note: 'the versions that edits replaced: the back office, and the artisan of the job (never the customer)',
    allowed: ['artisan', 'backOffice'],
    reads: true,
    request: (h, w) => ({ params: { quoteId: quote(h, w) } }),
  },
  {
    route: 'GET /quotes/:',
    note: 'the back office, and the artisan of the job',
    allowed: ['artisan', 'backOffice'],
    reads: true,
    request: (h, w) => ({ params: { quoteId: quote(h, w) } }),
  },
  {
    route: 'GET /quotes/:',
    note: 'a draft that the back office wrote is not shown to the artisan, who is on the job',
    allowed: ['backOffice'],
    reads: true,
    prepare: (w) => w.set('quote', { status: 'DRAFT', createdById: w.people.admin.id }),
    request: (h, w) => ({ params: { quoteId: quote(h, w) } }),
  },
];
