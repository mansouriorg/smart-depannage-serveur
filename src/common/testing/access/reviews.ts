import { Scenario, SelfScenario } from '../access-matrix';
import { Household, World, mark } from '../world';

const job = (h: Household, w: World) => w.ids[h].intervention;
const review = (h: Household, w: World) => w.ids[h].review;
const published = (w: World) => w.set('review', { status: 'APPROVED', isVisible: true });
const completed = (w: World) => {
  w.set('intervention', { status: 'COMPLETED' });
  w.clear('review');
};

/** Whatever a published review shows, it does not show the people's contact details. */
const noContacts = (h: Household) => [mark(h, 'client email'), mark(h, 'client phone'), mark(h, 'artisan email'), mark(h, 'artisan phone')];

export const reviewScenarios: Scenario[] = [
  {
    route: 'POST /reviews/interventions/:',
    note: 'a customer reviews their own finished job, nobody else’s',
    allowed: ['client'],
    prepare: completed,
    request: (h, w) => ({ params: { interventionId: job(h, w) }, body: { rating: 5, comment: 'Très bien' } }),
  },
  {
    route: 'GET /reviews/interventions/:',
    note: 'a review that nobody has approved yet is the customer’s and the back office’s: the artisan is answered with nothing',
    allowed: ['client', 'backOffice'],
    reads: true,
    emptyIsFine: true,
    request: (h, w) => ({ params: { interventionId: job(h, w) } }),
  },
  {
    route: 'GET /reviews/interventions/:',
    note: 'once approved, the artisan of the job reads it too',
    allowed: ['client', 'artisan', 'backOffice'],
    reads: true,
    prepare: published,
    request: (h, w) => ({ params: { interventionId: job(h, w) } }),
    hidden: (h, person) => (person.role === 'ARTISAN' ? noContacts(h) : []),
  },
  {
    route: 'GET /reviews/:',
    note: 'a review that is not approved: its author and the back office',
    allowed: ['client', 'backOffice'],
    reads: true,
    request: (h, w) => ({ params: { reviewId: review(h, w) } }),
  },
  {
    route: 'GET /reviews/:',
    note: 'an approved review is shown to every signed-in account, without the contact details of the people',
    allowed: ['anyone'],
    reads: true,
    prepare: published,
    request: (h, w) => ({ params: { reviewId: review(h, w) } }),
    hidden: (h, person) => (person.household === null || (person.role === 'CLIENT' && person.household === h) ? [] : noContacts(h)),
  },
  {
    route: 'GET /reviews/artisans/:',
    note: 'the published reviews of an artisan are public to the signed-in',
    allowed: ['anyone'],
    reads: true,
    prepare: published,
    request: (h, w) => ({ params: { artisanId: w.ids[h].artisan } }),
    hidden: (h) => noContacts(h),
  },
  {
    route: 'GET /reviews/artisans/:/summary',
    allowed: ['anyone'],
    request: (h, w) => ({ params: { artisanId: w.ids[h].artisan } }),
    hidden: (h) => noContacts(h),
  },
  {
    route: 'PATCH /reviews/admin/:/moderate',
    allowed: ['backOffice'],
    request: (h, w) => ({ params: { reviewId: review(h, w) }, body: { status: 'APPROVED', moderationReason: 'Conforme' } }),
  },
];

export const reviewSelfScenarios: SelfScenario[] = [
  { route: 'GET /reviews/me', reads: true, servedRoles: ['CLIENT'], request: () => ({}) },
  { route: 'GET /reviews/admin', servedRoles: ['BACK_OFFICE'], backOfficeSeesAll: true, request: () => ({}) },
  { route: 'GET /reviews/admin/dashboard', servedRoles: ['BACK_OFFICE'], backOfficeSeesAll: true, request: () => ({}) },
];
