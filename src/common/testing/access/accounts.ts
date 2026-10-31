import { Scenario, SelfScenario } from '../access-matrix';
import { Household, World, markStart } from '../world';

const client = (h: Household, w: World) => w.ids[h].client;

/** What no answer about an account holds: the password, and what the artisan keeps for the payout and the check of identity. */
const neverShown = (h: Household) => [
  markStart(h, 'User.password'),
  markStart(h, 'ArtisanBankDetails'),
  markStart(h, 'document url'),
  markStart(h, 'ArtisanDocument'),
];

export const accountScenarios: Scenario[] = [
  {
    route: 'GET /users/:',
    note: 'the back office reads an account, never its password',
    allowed: ['backOffice'],
    reads: true,
    request: (h, w) => ({ params: { id: client(h, w) } }),
    hidden: neverShown,
  },
  {
    route: 'GET /users/:',
    note: 'the account of an artisan, with the profile it holds',
    allowed: ['backOffice'],
    reads: true,
    request: (h, w) => ({ params: { id: w.ids[h].artisan } }),
    hidden: neverShown,
  },
  {
    route: 'GET /users',
    note: 'the list of accounts, without the password',
    allowed: ['backOffice'],
    reads: true,
    request: () => ({ query: { limit: '50' } }),
    hidden: neverShown,
  },
  {
    route: 'GET /users/artisans',
    note: 'the list of artisans for the dispatcher: not their bank details, nor their papers',
    allowed: ['ticketStaff'],
    reads: true,
    request: () => ({ query: { limit: '50' } }),
    hidden: neverShown,
  },
  {
    route: 'PATCH /users/:',
    note: 'an administrator changes an account; the answer has no password',
    allowed: ['admins'],
    reads: true,
    request: (h, w) => ({ params: { id: client(h, w) }, body: { name: 'Sami Ben Ali' } }),
    hidden: neverShown,
  },
  {
    route: 'DELETE /users/:',
    allowed: ['admins'],
    request: (h, w) => ({ params: { id: client(h, w) } }),
  },
];

const mine = { hidden: (h: Household) => neverShown(h) };

/** The answer is a row of switches with no text in it: it must be the caller's own row. */
export const ownPreferences = (person: { id: number }, value: unknown) => ((value as { userId?: number } | null)?.userId === person.id ? null : 'was answered with the preferences of somebody else');

export const accountSelfScenarios: SelfScenario[] = [
  { route: 'GET /users/me', reads: true, ...mine },
  { route: 'PATCH /users/me', request: () => ({ body: { name: 'Nouveau nom' } }), ...mine },
  { route: 'GET /users/profile', reads: true, ...mine },
  { route: 'PATCH /users/profile', request: () => ({ body: { address: '3 avenue Habib Bourguiba' } }), ...mine },
  { route: 'PATCH /users/location', servedRoles: ['ARTISAN', 'BACK_OFFICE'], request: () => ({ body: { latitude: 36.8, longitude: 10.18 } }) },
];
