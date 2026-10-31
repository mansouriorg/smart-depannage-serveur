import { Scenario, SelfScenario } from '../access-matrix';
import { Household, World, mark } from '../world';

const job = (h: Household, w: World) => w.ids[h].intervention;
const complaint = (h: Household, w: World) => w.ids[h].complaint;

/** What the customer and the artisan never read of a complaint. */
const hiddenFromParties = (h: Household, person: { role: string }) =>
  person.role === 'CLIENT' || person.role === 'ARTISAN'
    ? [mark(h, 'Complaint.internalNotes'), mark(h, 'Complaint.adminNotes'), mark(h, 'internal complaint message')]
    : [];

export const complaintScenarios: Scenario[] = [
  {
    route: 'POST /complaints/interventions/:',
    note: 'a complaint on a job: its customer, its artisan, or the back office',
    allowed: ['client', 'artisan', 'backOffice'],
    request: (h, w) => ({ params: { interventionId: job(h, w) }, body: { title: 'Fuite persistante', description: 'Le problème est revenu.' } }),
  },
  {
    route: 'GET /complaints/interventions/:',
    allowed: ['client', 'artisan', 'backOffice'],
    reads: true,
    request: (h, w) => ({ params: { interventionId: job(h, w) } }),
    hidden: hiddenFromParties,
  },
  {
    route: 'GET /complaints/:',
    allowed: ['client', 'artisan', 'backOffice'],
    reads: true,
    request: (h, w) => ({ params: { complaintId: complaint(h, w) } }),
    hidden: hiddenFromParties,
  },
  {
    route: 'POST /complaints/:/messages',
    note: 'a message on a complaint: both parties and the back office',
    allowed: ['client', 'artisan', 'backOffice'],
    request: (h, w) => ({ params: { complaintId: complaint(h, w) }, body: { content: 'Pouvez-vous passer demain ?' } }),
  },
  {
    route: 'POST /complaints/:/messages',
    note: 'an internal message on a complaint: the back office only',
    allowed: ['backOffice'],
    request: (h, w) => ({ params: { complaintId: complaint(h, w) }, body: { content: 'À suivre', isInternal: true } }),
  },
  {
    route: 'POST /complaints/:/artisan-response',
    note: 'the answer of the artisan of the job (the back office may write it for them)',
    allowed: ['artisan', 'backOffice'],
    request: (h, w) => ({ params: { complaintId: complaint(h, w) }, body: { response: 'Je repasse jeudi.' } }),
  },
  {
    route: 'PATCH /complaints/admin/:/assign',
    note: 'the routes of the back office are open to every signed-in account and refuse in the service',
    allowed: ['backOffice'],
    request: (h, w) => ({ params: { complaintId: complaint(h, w) }, body: { assignedToId: w.people.support.id } }),
  },
  {
    route: 'PATCH /complaints/admin/:/status',
    allowed: ['backOffice'],
    request: (h, w) => ({ params: { complaintId: complaint(h, w) }, body: { status: 'IN_REVIEW', note: 'Pris en charge' } }),
  },
  {
    route: 'PATCH /complaints/admin/:/resolve',
    allowed: ['backOffice'],
    request: (h, w) => ({ params: { complaintId: complaint(h, w) }, body: { resolutionNotes: 'Réglé' } }),
  },
];

export const complaintSelfScenarios: SelfScenario[] = [
  { route: 'GET /complaints/me', reads: true, backOfficeSeesAll: true, request: () => ({}), hidden: hiddenFromParties },
];
