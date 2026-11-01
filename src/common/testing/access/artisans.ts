import { Scenario, SelfScenario } from '../access-matrix';
import { Household, World, mark } from '../world';
import { withheldColumns } from './columns';
import { INTERVENTION_COLUMNS, interventionColumnsFor } from '../../views/intervention-columns';

const job = (h: Household, w: World) => w.ids[h].intervention;
const mission = (h: Household, w: World) => ({ interventionId: job(h, w) });

/** What the artisan who has a mission is never shown of it: the back office's columns, and the customer's address. */
const hiddenOnMission = (h: Household, person: { role: string }) =>
  person.role === 'ARTISAN'
    ? withheldColumns(
        h,
        'Intervention',
        Object.keys(INTERVENTION_COLUMNS).filter((column) => !interventionColumnsFor('artisan').includes(column)),
      )
    : [];

/**
 * An open job on the board: what an artisan who is not on it reads is the board's copy, with no way to reach the customer. The rows of
 * the board carry three more keys than the copy of the deleted GET /interventions did (rating, isOnTime, cancelledAt: empty on a job
 * nobody finished); they are the only columns left out of this check (see the README, P3-03).
 */
const EMPTY_KEYS_ON_THE_BOARD = ['rating', 'isOnTime', 'cancelledAt'];

const hiddenOnBoard = (h: Household, person: { role: string }) =>
  person.role === 'ARTISAN'
    ? [
        ...withheldColumns(
          h,
          'Intervention',
          Object.keys(INTERVENTION_COLUMNS).filter((column) => !interventionColumnsFor('board').includes(column) && !EMPTY_KEYS_ON_THE_BOARD.includes(column)),
        ),
        mark(h, 'client email'),
        mark(h, 'client phone'),
      ]
    : [];

const at = (status: string) => (w: World) => w.set('intervention', { status, latitude: 36.8008, longitude: 10.1815 });

/** A mission that is the artisan's alone: every action on it is theirs, and nobody else's, whatever the job's id. */
const mine = (route: string, status: string, body?: Record<string, unknown>, note?: string): Scenario => ({
  route,
  note: note ?? 'a mission is acted on by the artisan who has it: another artisan is refused, and nothing changes',
  allowed: ['artisan'],
  prepare: at(status),
  request: (h, w) => ({ params: mission(h, w), ...(body ? { body } : {}) }),
  hidden: hiddenOnMission,
});

export const artisanScenarios: Scenario[] = [
  {
    route: 'GET /artisans/me/missions',
    note: 'the board: an open job is read by every artisan through the board’s copy, which has no way to reach the customer (until P3-03 the older GET /interventions was checked for this)',
    allowed: ['artisans'],
    reads: true,
    prepare: (w) => {
      w.set('intervention', { status: 'CREATED', artisanId: null });
      // No offer is live: a job offered to somebody is kept for them and left off the others' board (P3-07, checked in its own scenario below).
      w.clear('missionOffer');
    },
    request: () => ({}),
    hidden: hiddenOnBoard,
  },
  {
    route: 'GET /artisans/me/missions/:',
    note: 'the details of a mission are the artisan’s who has it (an open job is read by the artisans it is for)',
    allowed: ['artisan'],
    reads: true,
    request: (h, w) => ({ params: mission(h, w) }),
    hidden: hiddenOnMission,
  },
  {
    ...mine('POST /artisans/me/missions/:/accept', 'ASSIGNED'),
    note: 'a mission is accepted by the artisan it was given to: any other is told that it is taken (409), and nothing changes',
    alsoRefusedWith: [409],
  },
  mine('POST /artisans/me/missions/:/reject', 'ASSIGNED', { reason: 'TOO_FAR' }),
  mine('PATCH /artisans/me/missions/:/on-the-way', 'ARTISAN_ACCEPTED'),
  mine('PATCH /artisans/me/missions/:/arrived', 'ARTISAN_ON_THE_WAY'),
  mine('PATCH /artisans/me/missions/:/start', 'ARTISAN_ARRIVED'),
  mine('PATCH /artisans/me/missions/:/diagnostic', 'IN_PROGRESS', { diagnosticNotes: 'Joint à remplacer' }),
  mine('PATCH /artisans/me/missions/:/materials', 'IN_PROGRESS', { items: [{ name: 'Joint', quantity: 2 }] }),
  mine('POST /artisans/me/missions/:/extra-quote', 'IN_PROGRESS', { reason: 'Un tuyau est à changer aussi' }),
  mine('POST /artisans/me/missions/:/signature', 'IN_PROGRESS', { signatureUrl: 'https://example.test/signature.png', signedByName: 'Sami' }),
  {
    ...mine('PATCH /artisans/me/missions/:/complete', 'IN_PROGRESS'),
    prepare: (w) => w.set('intervention', { status: 'IN_PROGRESS', afterPhotoUrl: 'https://example.test/after.jpg' }),
  },
  mine('POST /artisans/me/missions/:/problem', 'IN_PROGRESS', { problemType: 'CLIENT_ABSENT', notes: 'Personne sur place' }),
  mine('POST /artisans/me/missions/:/contact-client', 'IN_PROGRESS', { content: 'Je suis en bas' }),
  mine('POST /artisans/me/missions/:/contact-admin', 'IN_PROGRESS', { content: 'Besoin d’une pièce' }),
  {
    route: 'DELETE /artisans/me/service-zones/:',
    note: 'a zone is removed by the artisan whose zone it is: the id of somebody else’s is not found',
    allowed: ['artisan'],
    prepare: (w) => {
      // A second zone, so that the first may go (the last zone cannot be removed).
      for (const h of ['A', 'B'] as const) w.fill('artisanServiceZone', { artisanProfileId: w.ids[h].artisanProfile, latitude: 36.8, longitude: 10.18, radiusKm: 10 });
    },
    request: (h, w) => ({ params: { zoneId: w.ids[h].zone } }),
  },
];

const ownProfile = (note?: string): Partial<SelfScenario> => ({ servedRoles: ['ARTISAN'], note });

export const artisanSelfScenarios: SelfScenario[] = [
  { route: 'GET /artisans/me/profile', reads: true, ...ownProfile('the guard lets the two administrators in; there is no profile for them') },
  { route: 'PATCH /artisans/me/profile', request: () => ({ body: { bio: 'Plombier depuis dix ans' } }), ...ownProfile() },
  { route: 'POST /artisans/me/documents', request: () => ({ body: { type: 'IDENTITY', fileUrl: 'https://example.test/identity.pdf' } }), ...ownProfile() },
  { route: 'POST /artisans/me/service-zones', request: () => ({ body: { label: 'Tunis', latitude: 36.8, longitude: 10.18, radiusKm: 10 } }), ...ownProfile() },
  {
    route: 'PATCH /artisans/me/availability',
    request: () => ({ body: { isAcceptingJobs: true, slots: [{ dayOfWeek: 'TUESDAY', startTime: '08:00', endTime: '12:00' }] } }),
    ...ownProfile(),
  },
  { route: 'PATCH /artisans/me/bank-details', request: () => ({ body: { bankName: 'BIAT', iban: 'TN5910006035183598478831' } }), ...ownProfile() },
  { route: 'PATCH /artisans/me/location', request: () => ({ body: { latitude: 36.8, longitude: 10.18 } }) },
  { route: 'PATCH /artisans/me/online' },
  { route: 'PATCH /artisans/me/offline' },
  { route: 'GET /artisans/me/missions', reads: true },
  {
    route: 'GET /artisans/me/offers',
    note: 'an artisan reads the offers made to them, and for an open job the board’s copy of it (no way to reach the customer); the offers of the other household’s artisan are not in it',
    reads: true,
    servedRoles: ['ARTISAN'],
    prepare: (w) => w.set('intervention', { status: 'CREATED', artisanId: null }),
    hidden: hiddenOnBoard,
  },
];
