import { Scenario, SelfScenario } from '../access-matrix';
import { HOUSEHOLDS, Household, World, mark } from '../world';
import { INTERVENTION_COLUMNS, Viewer, interventionColumnsFor } from '../../views/intervention-columns';
import { scene, upload } from '../../../modules/proofs/test-photos';
import { withheldColumns } from './columns';

const job = (h: Household, w: World) => w.ids[h].intervention;

/** The columns of a job that this reader is never given (the back office's notes, the hash of the link, and so on). */
const withheld = (viewer: Viewer) => Object.keys(INTERVENTION_COLUMNS).filter((column) => !interventionColumnsFor(viewer).includes(column));

const jobMarks = (h: Household, viewer: Viewer) => withheldColumns(h, 'Intervention', withheld(viewer));

/** What the customer who owns a job, and the artisan who has it, are never shown of it. */
export const hiddenOnJob = (h: Household, person: { role: string }) =>
  person.role === 'CLIENT'
    ? [...jobMarks(h, 'client'), mark(h, 'artisan email')]
    : person.role === 'ARTISAN'
      ? [...jobMarks(h, 'artisan'), mark(h, 'client email')]
      : [];

/** The artisan is on site: a photo may be taken. */
const onSite = (w: World) => w.set('intervention', { status: 'ARTISAN_ARRIVED', latitude: 36.8008, longitude: 10.1815 });
const working = (w: World) => w.set('intervention', { status: 'IN_PROGRESS', latitude: 36.8008, longitude: 10.1815 });

const POSITION = { latitude: '36.8008', longitude: '10.1815', accuracy: '8', mocked: 'false' };

const photo = async (seed: number) => upload(await scene(seed));

/** Lines of the timeline that are for the back office alone, in the words the readers must not see. */
const withInternalLines = (w: World) => {
  for (const h of HOUSEHOLDS) {
    w.fill('interventionEvent', {
      interventionId: w.ids[h].intervention,
      type: 'INTERNAL_NOTE_ADDED',
      title: mark(h, 'internal event title'),
      message: mark(h, 'internal event message'),
    });
    w.fill('interventionEvent', {
      interventionId: w.ids[h].intervention,
      type: 'STATUS_CHANGED',
      title: mark(h, 'flagged event title'),
      message: mark(h, 'flagged event message'),
      metadata: { internal: true },
    });
  }
};

export const jobScenarios: Scenario[] = [
  // ------------------------------------------------------------------ the jobs (interventions)
  {
    route: 'GET /interventions/assigned',
    note: 'the missions of the artisan who asks: the others are answered an empty list',
    allowed: ['artisan'],
    emptyIsFine: true,
    reads: true,
    request: () => ({}),
    hidden: hiddenOnJob,
  },
  {
    route: 'GET /interventions/dashboard/stats',
    allowed: ['ticketStaff'],
    request: () => ({}),
  },
  {
    route: 'POST /interventions/:/complete-work',
    note: 'closing the job with the photo is the artisan of the job’s',
    allowed: ['artisan'],
    prepare: working,
    request: async (h, w) => ({
      params: { id: String(job(h, w)) },
      file: await photo(3),
      body: { ...POSITION, capturedAt: new Date().toISOString() },
    }),
    hidden: hiddenOnJob,
  },

  // ------------------------------------------------------------------ the timeline and the workflow
  {
    route: 'GET /interventions/:/timeline',
    note: 'the customer and the artisan read the lines meant for them: not the back office’s notes',
    allowed: ['client', 'artisan', 'backOffice'],
    reads: true,
    prepare: withInternalLines,
    request: (h, w) => ({ params: { id: job(h, w) } }),
    hidden: (h, person) =>
      person.role === 'CLIENT' || person.role === 'ARTISAN'
        ? [mark(h, 'internal event title'), mark(h, 'internal event message'), mark(h, 'flagged event title'), mark(h, 'flagged event message')]
        : [],
  },
  {
    route: 'GET /interventions/:/workflow/next-statuses',
    allowed: ['client', 'artisan', 'ticketStaff'],
    request: (h, w) => ({ params: { id: job(h, w) } }),
  },
  {
    route: 'PATCH /interventions/:/workflow/status',
    allowed: ['ticketStaff'],
    request: (h, w) => ({ params: { id: job(h, w) }, body: { status: 'ARTISAN_ACCEPTED' } }),
  },
  {
    route: 'POST /interventions/:/workflow/events',
    allowed: ['ticketStaff'],
    request: (h, w) => ({ params: { id: job(h, w) }, body: { type: 'INTERNAL_NOTE_ADDED', title: 'Note', message: 'À suivre' } }),
  },

  // ------------------------------------------------------------------ the proofs
  {
    route: 'POST /interventions/:/proofs/:',
    note: 'a photo of the work: the artisan of the job, on site, or the staff',
    allowed: ['artisan', 'ticketStaff'],
    prepare: onSite,
    request: async (h, w) => ({
      params: { id: job(h, w), kind: 'before' },
      file: await photo(4),
      body: { ...POSITION, capturedAt: new Date().toISOString() },
    }),
    hidden: (h, person) => (person.role === 'ARTISAN' || person.role === 'CLIENT' ? [mark(h, 'client email')] : []),
  },
  {
    route: 'PATCH /proofs/:/review',
    allowed: ['ticketStaff'],
    prepare: (w) => w.set('proofCapture', { status: 'NEEDS_REVIEW' }),
    request: (h, w) => ({ params: { id: w.ids[h].proof }, body: { decision: 'APPROVE' } }),
  },
];

export const jobSelfScenarios: SelfScenario[] = [
  {
    route: 'POST /interventions/secure',
    note: 'a request made while signed in belongs to the person who made it, whatever the body says',
    // The body names the other household's customer as the owner: the request must still be the caller's.
    request: (person, w) => ({
      body: {
        serviceType: 'PLOMBIER',
        description: 'Fuite sous l’évier',
        address: '12 rue de Marseille, Tunis',
        clientId: w.ids[person.household === 'A' ? 'B' : 'A'].client,
        contactPhone: '20 000 000',
      },
    }),
  },
  { route: 'GET /proofs', servedRoles: ['BACK_OFFICE'], backOfficeSeesAll: true, request: () => ({ query: {} }) },
];
