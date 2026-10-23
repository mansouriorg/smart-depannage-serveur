import { Scenario, SelfScenario } from '../access-matrix';
import { Household, World, mark } from '../world';

const address = (h: Household, w: World) => w.ids[h].address;
const job = (h: Household, w: World) => w.ids[h].intervention;

/** The ADMIN and SUPER_ADMIN roles pass the guard of these routes; the services serve the customer who owns the row. */
export const clientScenarios: Scenario[] = [
  {
    route: 'GET /client/addresses/:',
    note: 'an address book is the customer’s: the two administrators pass the guard and are refused',
    allowed: ['client'],
    reads: true,
    request: (h, w) => ({ params: { id: address(h, w) } }),
  },
  {
    route: 'PATCH /client/addresses/:',
    allowed: ['client'],
    request: (h, w) => ({ params: { id: address(h, w) }, body: { label: 'Bureau', isDefault: true } }),
  },
  {
    route: 'DELETE /client/addresses/:',
    allowed: ['client'],
    request: (h, w) => ({ params: { id: address(h, w) } }),
  },
  {
    route: 'POST /client/interventions',
    note: 'a request that names a saved address: only the owner of the address may use it',
    allowed: ['client'],
    request: (h, w) => ({
      body: { serviceType: 'PLOMBIER', description: 'Fuite sous évier', address: '12 rue de Carthage', savedAddressId: address(h, w) },
    }),
  },
  {
    route: 'GET /client/interventions/:',
    allowed: ['client'],
    reads: true,
    request: (h, w) => ({ params: { id: job(h, w) } }),
  },
  {
    route: 'GET /client/interventions/:/tracking',
    allowed: ['client'],
    reads: true,
    request: (h, w) => ({ params: { id: job(h, w) } }),
  },
  {
    route: 'PATCH /client/interventions/:/cancel',
    allowed: ['client'],
    prepare: (w) => w.set('intervention', { status: 'WAITING_ADMIN_REVIEW', artisanId: null }),
    request: (h, w) => ({ params: { id: job(h, w) } }),
  },
];

export const clientSelfScenarios: SelfScenario[] = [
  { route: 'GET /client/addresses', reads: true, request: () => ({}) },
  { route: 'POST /client/addresses', request: () => ({ body: { address: '3 avenue Habib Bourguiba', isDefault: true } }) },
  { route: 'GET /client/interventions', reads: true, request: () => ({}) },
];

void mark;
