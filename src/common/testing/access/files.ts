import { Party, Scenario, SelfScenario } from '../access-matrix';
import { Household, World } from '../world';

/** A picture of one pixel and a one-page paper: small, and the kinds the service accepts. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');

const png = () => ({ fieldname: 'file', originalname: 'photo.png', mimetype: 'image/png', size: PNG.length, buffer: PNG });
const pdf = () => ({ fieldname: 'file', originalname: 'devis.pdf', mimetype: 'application/pdf', size: PDF.length, buffer: PDF });

/** Each file of a household, who may open it, and where it hangs. */
const FILES: Array<{ id: string; entityType: string; entity: (h: Household, w: World) => number; readers: Party[]; editors: Party[]; what: string }> = [
  { id: 'damagePhoto', entityType: 'INTERVENTION', entity: (h, w) => w.ids[h].intervention, readers: ['client', 'artisan', 'backOffice'], editors: ['client', 'backOffice'], what: 'the photo of the damage' },
  { id: 'quotePdf', entityType: 'QUOTE', entity: (h, w) => w.ids[h].quote, readers: ['client', 'artisan', 'backOffice'], editors: ['artisan', 'backOffice'], what: 'the PDF of a quote' },
  { id: 'invoicePdf', entityType: 'INVOICE', entity: (h, w) => w.ids[h].invoice, readers: ['client', 'backOffice'], editors: ['backOffice'], what: 'the PDF of an invoice (not the artisan: it carries the customer\'s details)' },
  { id: 'complaintAttachment', entityType: 'COMPLAINT', entity: (h, w) => w.ids[h].complaint, readers: ['client', 'artisan', 'backOffice'], editors: ['client', 'backOffice'], what: 'a paper attached to a complaint' },
  { id: 'identityDocument', entityType: 'ARTISAN_PROFILE', entity: (h, w) => w.ids[h].artisanProfile, readers: ['artisan', 'verifiers'], editors: ['verifiers'], what: 'the identity card of the artisan (only the team that verifies them reads it)' },
];

export const fileScenarios: Scenario[] = [
  ...FILES.flatMap((file): Scenario[] => [
    {
      route: 'GET /files/:',
      note: `the description of ${file.what}`,
      allowed: file.readers,
      reads: true,
      request: (h, w) => ({ params: { fileId: w.ids[h][file.id] } }),
    },
    {
      route: 'GET /files/:/download',
      note: `the content of ${file.what}`,
      allowed: file.readers,
      reads: true,
      request: (h, w) => ({ params: { fileId: w.ids[h][file.id] } }),
    },
    {
      route: 'GET /files/entity/:/:',
      note: `the files of a ${file.entityType}`,
      allowed: file.readers,
      reads: true,
      request: (h, w) => ({ params: { entityType: file.entityType, entityId: file.entity(h, w) } }),
    },
    {
      route: 'DELETE /files/:',
      note: `deleting ${file.what}`,
      allowed: file.editors,
      request: (h, w) => ({ params: { fileId: w.ids[h][file.id] } }),
    },
    {
      route: 'PATCH /files/:/replace',
      note: `replacing ${file.what}`,
      allowed: file.editors,
      request: (h, w) => ({ params: { fileId: w.ids[h][file.id] }, file: file.id === 'damagePhoto' || file.id === 'complaintAttachment' ? png() : pdf() }),
    },
  ]),
  {
    route: 'POST /files/interventions/:/damage-photo',
    note: 'a photo of the damage on a job: the customer of the job, or the back office',
    allowed: ['client', 'ticketStaff'],
    request: (h, w) => ({ params: { interventionId: w.ids[h].intervention }, file: png() }),
  },
  {
    route: 'POST /files/quotes/:/pdf',
    note: 'the PDF of a quote: the artisan of the job, or the back office',
    allowed: ['artisan', 'ticketStaff'],
    request: (h, w) => ({ params: { quoteId: w.ids[h].quote }, file: pdf() }),
  },
  {
    route: 'POST /files/complaints/:/attachment',
    note: 'a paper on a complaint: the customer, the artisan of the job, or the back office',
    allowed: ['client', 'artisan', 'ticketStaff'],
    request: (h, w) => ({ params: { complaintId: w.ids[h].complaint }, file: png() }),
  },
];

/** The papers an artisan adds to their own profile: the profile is found from who they are, never from a number they send. */
const own = { servedRoles: ['ARTISAN' as const], note: 'a paper goes on the profile of the artisan who sends it; the two administrators are let in by the guard and have no profile to put it on' };

export const fileSelfScenarios: SelfScenario[] = [
  { route: 'POST /files/artisan/documents', request: () => ({ body: { type: 'CERTIFICATE', visibility: 'PRIVATE' }, file: pdf() }), ...own },
  { route: 'POST /files/artisan/identity', request: () => ({ file: pdf() }), ...own },
  { route: 'POST /files/artisan/insurance', request: () => ({ file: pdf() }), ...own },
];
