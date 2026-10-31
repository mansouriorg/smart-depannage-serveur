import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { MemoryPrisma } from './memory-prisma';
import { Router } from './route-invoker';
import { TICKET_STAFF_ROLES } from '../auth/role-policy';

import { AdminController } from '../../modules/admin/admin.controller';
import { AdminService } from '../../modules/admin/admin.service';
import { ArtisansController } from '../../modules/artisans/artisans.controller';
import { ArtisansService } from '../../modules/artisans/artisans.service';
import { AssignmentService } from '../../modules/assignment/assignment.service';
import { BusinessController } from '../../modules/business/business.controller';
import { BusinessService } from '../../modules/business/business.service';
import { CashLedgerController } from '../../modules/cash-ledger/cash-ledger.controller';
import { CashLedgerService } from '../../modules/cash-ledger/cash-ledger.service';
import { FinanceController } from '../../modules/finance/finance.controller';
import { FinanceService } from '../../modules/finance/finance.service';
import { ClientAddressesController } from '../../modules/client-addresses/client-addresses.controller';
import { ClientAddressesService } from '../../modules/client-addresses/client-addresses.service';
import { ClientInterventionsController } from '../../modules/client-interventions/client-interventions.controller';
import { ClientInterventionsService } from '../../modules/client-interventions/client-interventions.service';
import { ComplaintsController } from '../../modules/complaints/complaints.controller';
import { ComplaintsService } from '../../modules/complaints/complaints.service';
import { FilesController } from '../../modules/files/files.controller';
import { FilesService } from '../../modules/files/files.service';
import { InterventionEventsService } from '../../modules/intervention-events/intervention-events.service';
import { InterventionWorkflowController } from '../../modules/intervention-workflow/intervention-workflow.controller';
import { InterventionWorkflowService } from '../../modules/intervention-workflow/intervention-workflow.service';
import { InterventionsController } from '../../modules/interventions/interventions.controller';
import { InterventionsService } from '../../modules/interventions/interventions.service';
import { InvoicesController } from '../../modules/invoices/invoices.controller';
import { InvoicesService } from '../../modules/invoices/invoices.service';
import { MatchingController } from '../../modules/matching/matching.controller';
import { MatchingService } from '../../modules/matching/matching.service';
import { MessagesController } from '../../modules/messages/messages.controller';
import { MessagesService } from '../../modules/messages/messages.service';
import { MissionActionsService } from '../../modules/mission-actions/mission-actions.service';
import { NotificationsController } from '../../modules/notifications/notifications.controller';
import { NotificationsService } from '../../modules/notifications/notifications.service';
import { PaymentsController } from '../../modules/payments/payments.controller';
import { PaymentsService } from '../../modules/payments/payments.service';
import { readGatewayConfig } from '../../modules/payments/gateway/gateway-config';
import { PaymentGatewayService } from '../../modules/payments/gateway/payment-gateway.service';
import { FakePaymentGateway } from './fake-payment-gateway';
import { ProofsController } from '../../modules/proofs/proofs.controller';
import { ProofsService } from '../../modules/proofs/proofs.service';
import { QuotesController } from '../../modules/quotes/quotes.controller';
import { QuotesService } from '../../modules/quotes/quotes.service';
import { ReviewsController } from '../../modules/reviews/reviews.controller';
import { ReviewsService } from '../../modules/reviews/reviews.service';
import { SchedulingController } from '../../modules/scheduling/scheduling.controller';
import { SchedulingService } from '../../modules/scheduling/scheduling.service';
import { APPOINTMENT_OVERLAP_CONSTRAINT, visitsClash } from '../../modules/scheduling/appointment-overlap';
import { ServiceCatalogController } from '../../modules/service-catalog/service-catalog.controller';
import { ServiceCatalogService } from '../../modules/service-catalog/service-catalog.service';
import { ServiceZonesController } from '../../modules/service-zones/service-zones.controller';
import { ServiceZonesService } from '../../modules/service-zones/service-zones.service';
import { ContactChangeService } from '../../modules/users/contact-change.service';
import { UsersController } from '../../modules/users/users.controller';
import { UsersService } from '../../modules/users/users.service';
import { GuestController } from '../../modules/guest/guest.controller';
import { GuestService } from '../../modules/guest/guest.service';
import { BotCheckService } from '../bot-check/bot-check.service';

/**
 * The server on an in-memory database, for the specs that ask who may see and change what (P1-17).
 *
 * The services and controllers are the real ones. What is replaced is only what leaves the process: the
 * gateways, the outbox, the push and SMS providers and the staff alerts are inert stand-ins that note
 * what they were asked to do (`sink.calls`), so a spec can also say "a refused call told nobody".
 *
 * Two households are built, A and B, each with a customer, an artisan and a complete job (quote,
 * invoice, payment, messages, files, complaint, review, appointment, proofs, notifications...). Every
 * text of a household carries its mark (`SECRET<A:...>`), so a response that holds the mark of A was
 * built from A's rows: if it went to somebody of B, something leaked. Back-office staff belong to no
 * household.
 */

export type Household = 'A' | 'B';
export type StaffKind = 'ADMIN' | 'SUPER_ADMIN' | 'SUPPORT' | 'DISPATCHER' | 'ACCOUNTANT';

export interface Person {
  /** `clientA`, `artisanB`, `admin`... */
  key: string;
  id: number;
  role: string;
  household: Household | null;
  /** What the JWT strategy hands the controllers. */
  user: { id: number; email: string; name: string | null; role: string };
}

/** Everything that exists in one household, by its id. */
export type Ids = Record<string, number>;

/** A stand-in for something that leaves the process: any call is noted and answers nothing. */
export function inert(label: string, calls: string[]): any {
  const make = (trail: string): any =>
    new Proxy(function () {}, {
      get: (_target, key) => {
        if (key === 'then' || typeof key === 'symbol') return undefined;

        return make(`${trail}.${String(key)}`);
      },
      apply: () => {
        calls.push(trail);

        return make(`${trail}()`);
      },
    });

  return make(label);
}

const SRC = path.resolve(__dirname, '../..');
const source = (relative: string) => fs.readFileSync(path.join(SRC, relative), 'utf8');

let sharedUploadRoot: string | null = null;

/** One folder for the files that the specs upload, removed when the process ends. */
function uploadRoot(): string {
  if (sharedUploadRoot) return sharedUploadRoot;

  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-world-uploads-'));

  sharedUploadRoot = folder;
  process.on('exit', () => fs.rmSync(folder, { recursive: true, force: true }));

  return folder;
}

export const mark = (household: Household, name: string) => `SECRET<${household}:${name}>`;

/** The start of a mark: matches the texts that carry a counter after their name (`SECRET<A:User.email-7>`). */
export const markStart = (household: Household, name: string) => `SECRET<${household}:${name}`;

/**
 * What an answer says, as text: the JSON of a value, the message of an error, and for a file (a PDF) the characters it is made of (its
 * texts are written in plain ASCII between parentheses, so a mark in a drawn text is found in it).
 */
export function textOfAnswer(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString('latin1');
  if (value instanceof Error) return `${value.message} ${JSON.stringify((value as any).response ?? '')}`;

  return JSON.stringify(value, (_key, entry) => (typeof entry === 'bigint' ? String(entry) : Buffer.isBuffer(entry) ? entry.toString('latin1') : entry)) ?? '';
}

/** The marks of a household found anywhere in a value (also in the text of an error). */
export function marksOf(value: unknown, household: Household): string[] {
  const text = textOfAnswer(value);

  return text.match(new RegExp(`SECRET<${household}:[^>]*>`, 'g')) ?? [];
}

export class World {
  readonly memory: MemoryPrisma;
  readonly prisma: any;
  /** What the stand-ins were asked to do, as `notifications.notifyUser`. */
  readonly sink: string[] = [];
  readonly router: Router;
  readonly svc: Record<string, any> = {};
  /** The card provider of this world: it answers only for the payments a spec put there (`kept`), and only once `connectPaymentProvider` was called. */
  readonly paymentGateway = new FakePaymentGateway();
  /** The settings the payments of this world read: no provider is set up until a spec asks for one (a card payment is then an empty request). */
  readonly paymentProvider = new PaymentGatewayService(readGatewayConfig({}), null);
  readonly people: Record<string, Person> = {};
  readonly ids: Record<Household, Ids> = { A: {}, B: {} };

  constructor(schemaText?: string) {
    // The link given to a customer when a request is made is built from this address.
    process.env.FRONTEND_URL ??= 'https://app.example.test';

    this.memory = new MemoryPrisma(schemaText);
    // The database of the deployment refuses two visits of one artisan at the same time (P3-01): so does this one, by the same rule.
    this.memory.addExclusion({ name: APPOINTMENT_OVERLAP_CONSTRAINT, model: 'Appointment', clash: visitsClash });
    this.prisma = this.memory.client();

    const prisma = this.prisma;
    const out = (label: string) => inert(label, this.sink);
    const svc = this.svc;

    svc.events = new InterventionEventsService(prisma);
    svc.files = new FilesService(prisma, svc.events);
    // Pictures and papers sent by a route are written here, not in the uploads folder of the project.
    Object.assign(svc.files, { uploadRoot: uploadRoot() });
    svc.notifications = new NotificationsService(prisma, out('notificationsGateway'), out('outbox'), out('templates'));
    svc.realtime = out('realtime');
    svc.staffAlerts = out('staffAlerts');
    svc.rateLimit = out('rateLimit');
    svc.gateway = out('interventionsGateway');
    // The service that tells people is replaced as a whole where a service only tells: what it says is not the question here.
    svc.told = out('notifications');
    svc.assignment = new AssignmentService(prisma, svc.told, svc.events, svc.realtime);
    svc.missionActions = new MissionActionsService(prisma, svc.told, svc.events, svc.realtime);
    svc.contactChange = new ContactChangeService(prisma, svc.told, svc.rateLimit);
    svc.users = new UsersService(prisma, svc.told, svc.contactChange);
    svc.proofs = new ProofsService(prisma, svc.files, svc.events, svc.told);
    svc.interventions = new InterventionsService(prisma, svc.gateway, svc.told, svc.staffAlerts, svc.proofs);
    svc.clientInterventions = new ClientInterventionsService(prisma, svc.events, svc.staffAlerts);
    svc.clientAddresses = new ClientAddressesService(prisma);
    svc.quotes = new QuotesService(prisma, svc.events, svc.told);
    svc.invoices = new InvoicesService(prisma, svc.events, svc.told);
    svc.payments = new PaymentsService(prisma, svc.events, svc.told, this.paymentProvider);
    svc.messages = new MessagesService(prisma, svc.realtime, svc.told);
    svc.complaints = new ComplaintsService(prisma, svc.told);
    svc.reviews = new ReviewsService(prisma);
    svc.scheduling = new SchedulingService(prisma, svc.assignment, svc.told, svc.realtime, svc.missionActions);
    svc.artisans = new ArtisansService(prisma, svc.told, svc.events, svc.rateLimit, svc.missionActions, svc.files);
    svc.workflow = new InterventionWorkflowService(prisma);
    svc.business = new BusinessService(prisma);
    svc.cashLedger = new CashLedgerService(prisma, svc.events);
    svc.finance = new FinanceService(prisma);
    svc.matching = new MatchingService(prisma, svc.assignment);
    svc.admin = new AdminService(prisma, svc.told, svc.events, svc.contactChange, svc.assignment, svc.realtime);
    svc.catalog = new ServiceCatalogService(prisma);
    svc.zones = new ServiceZonesService(prisma);
    svc.guest = new GuestService(prisma, svc.told, svc.events, svc.rateLimit, svc.staffAlerts, svc.files, svc.complaints);

    this.router = new Router(
      [
        ['admin/admin', new AdminController(svc.admin)],
        ['artisans/artisans', new ArtisansController(svc.artisans)],
        ['business/business', new BusinessController(svc.business)],
        ['cash-ledger/cash-ledger', new CashLedgerController(svc.cashLedger)],
        ['client-addresses/client-addresses', new ClientAddressesController(svc.clientAddresses)],
        ['client-interventions/client-interventions', new ClientInterventionsController(svc.clientInterventions)],
        ['complaints/complaints', new ComplaintsController(svc.complaints)],
        ['files/files', new FilesController(svc.files)],
        ['finance/finance', new FinanceController(svc.finance)],
        ['guest/guest', new GuestController(svc.guest, new BotCheckService())],
        ['intervention-workflow/intervention-workflow', new InterventionWorkflowController(svc.workflow)],
        ['interventions/interventions', new InterventionsController(svc.interventions)],
        ['invoices/invoices', new InvoicesController(svc.invoices)],
        ['matching/matching', new MatchingController(svc.matching)],
        ['messages/messages', new MessagesController(svc.messages)],
        ['notifications/notifications', new NotificationsController(svc.notifications)],
        ['payments/payments', new PaymentsController(svc.payments)],
        ['proofs/proofs', new ProofsController(svc.proofs)],
        ['quotes/quotes', new QuotesController(svc.quotes)],
        ['reviews/reviews', new ReviewsController(svc.reviews)],
        ['scheduling/scheduling', new SchedulingController(svc.scheduling)],
        ['service-catalog/service-catalog', new ServiceCatalogController(svc.catalog)],
        ['service-zones/service-zones', new ServiceZonesController(svc.zones)],
        ['users/users', new UsersController(svc.users, svc.contactChange)],
      ].map(([name, instance]) => ({ source: source(`modules/${name as string}.controller.ts`), instance })),
      TICKET_STAFF_ROLES,
    );
  }

  /** Sets up the card provider for the payments of this world: from now on they ask `paymentGateway` (a fake) what became of a card payment. */
  connectPaymentProvider(): void {
    const config = readGatewayConfig({ PAYMENT_PROVIDER: 'konnect', KONNECT_API_KEY: 'key-of-the-world', KONNECT_WALLET_ID: 'wallet-of-the-world', API_PUBLIC_URL: 'https://api.example.test' });

    Object.assign(this.paymentProvider, { config, gateway: this.paymentGateway });
  }

  /** Changes rows of the world to put it in the state a spec needs: the rows of `model` that `which` selects (every row when it is left out). */
  set(model: string, patch: Record<string, any>, which: ((row: Record<string, any>) => boolean) | number | null = null): void {
    const rows = this.memory.rows(model).filter((row) => (which === null ? true : typeof which === 'number' ? row.id === which : which(row)));

    if (rows.length === 0) throw new Error(`set: no ${model} to change`);

    for (const row of rows) Object.assign(row, patch);
  }

  /** Empties a table (a job that has no review yet, say). */
  clear(model: string): void {
    this.memory.rows(model).length = 0;
  }

  // ------------------------------------------------------------------ people

  private person(key: string, row: Record<string, any>, household: Household | null): Person {
    const person: Person = {
      key,
      id: row.id,
      role: row.role,
      household,
      user: { id: row.id, email: row.email, name: row.name ?? null, role: row.role },
    };

    this.people[key] = person;

    return person;
  }

  /** The household `of` the person, or the back office when null. */
  of(household: Household | null): Person[] {
    return Object.values(this.people).filter((person) => person.household === household);
  }

  /** Plants a row with its optional text filled too, every text carrying the mark of the household being built. */
  fill(model: string, data: Record<string, any> = {}): Record<string, any> {
    return this.memory.plant(model, data, { optionalText: true });
  }

  seedEverything(): void {
    this.memory.labelWith(null);

    for (const staff of STAFF) {
      const row = this.fill('user', { role: staff.role, name: `staff ${staff.key}` });

      this.person(staff.key, row, null);
    }

    for (const household of HOUSEHOLDS) {
      this.memory.labelWith((model, field, unique) => mark(household, `${model}.${field}${unique}`));
      this.seedHousehold(household);
    }

    this.memory.labelWith(null);
  }

  private seedHousehold(h: Household): void {
    const ids = this.ids[h];
    const client = this.fill('user', { role: 'CLIENT', name: mark(h, 'client name'), email: mark(h, 'client email'), phone: mark(h, 'client phone') });
    const artisan = this.fill('user', { role: 'ARTISAN', name: mark(h, 'artisan name'), email: mark(h, 'artisan email'), phone: mark(h, 'artisan phone') });

    this.person(`client${h}`, client, h);
    this.person(`artisan${h}`, artisan, h);
    ids.client = client.id;
    ids.artisan = artisan.id;

    const profile = this.fill('artisanProfile', {
      userId: artisan.id,
      verificationStatus: 'APPROVED',
      availabilityStatus: 'ONLINE',
      isAcceptingJobs: true,
      serviceTypes: ['PLOMBIER'],
    });

    ids.artisanProfile = profile.id;
    ids.address = this.fill('clientAddress', { clientId: client.id }).id;
    ids.slot = this.fill('artisanAvailabilitySlot', { artisanProfileId: profile.id, dayOfWeek: 'MONDAY', startTime: '09:00', endTime: '17:00' }).id;
    ids.timeBlock = this.fill('artisanTimeBlock', { artisanId: artisan.id, startsAt: new Date('2026-12-01T08:00:00Z'), endsAt: new Date('2026-12-01T12:00:00Z') }).id;
    ids.zone = this.fill('artisanServiceZone', { artisanProfileId: profile.id }).id;
    ids.document = this.fill('artisanDocument', { artisanProfileId: profile.id, type: 'IDENTITY', fileUrl: mark(h, 'document url') }).id;
    ids.bankDetails = this.fill('artisanBankDetails', { artisanProfileId: profile.id }).id;

    const job = this.fill('intervention', {
      clientId: client.id,
      artisanId: artisan.id,
      status: 'ASSIGNED',
      serviceType: 'PLOMBIER',
      description: mark(h, 'job description'),
      address: mark(h, 'job address'),
      savedAddressId: ids.address,
    });

    ids.intervention = job.id;
    ids.event = this.fill('interventionEvent', { interventionId: job.id, type: 'REQUEST_CREATED' }).id;

    const quote = this.fill('quote', {
      interventionId: job.id,
      createdById: artisan.id,
      status: 'SENT',
      amountHT: 100,
      taxAmount: 20,
      amountTTC: 120,
      // edited once since it was sent: the version it replaced is the quoteRevision below
      revision: 2,
    });

    ids.quote = quote.id;
    ids.quoteItem = this.fill('quoteItem', { quoteId: quote.id, unitPrice: 100, total: 100 }).id;
    // The version of the quote that an edit replaced (P2-04).
    ids.quoteRevision = this.fill('quoteRevision', { quoteId: quote.id, revision: 1, status: 'SENT', amountHT: 80, taxAmount: 16, amountTTC: 96, items: [{ label: 'Main d’œuvre', quantity: 1, unitPrice: 80, total: 80 }], savedById: artisan.id }).id;

    const invoice = this.fill('invoice', { interventionId: job.id, status: 'ISSUED', amountHT: 100, taxAmount: 20, amountTTC: 120 });

    ids.invoice = invoice.id;
    ids.invoiceItem = this.fill('invoiceItem', { invoiceId: invoice.id, unitPrice: 100, total: 100 }).id;
    // A credit note on the invoice, for the checks of who reads it (P2-07). The figures of the invoice itself are left as they are:
    // the other checks pay it, and its credited amount stays 0.
    ids.creditNote = this.fill('creditNote', {
      invoiceId: invoice.id,
      interventionId: job.id,
      numberYear: 2026,
      sequence: h === 'A' ? 1 : 2,
      currency: 'TND',
      amountHT: 10,
      taxRate: 19,
      taxAmount: 1.9,
      amountTTC: 11.9,
      stampDuty: 0,
    }).id;
    ids.payment = this.fill('payment', {
      interventionId: job.id,
      quoteId: quote.id,
      invoiceId: invoice.id,
      method: 'ONLINE',
      status: 'PENDING',
      amount: 120,
      createdById: client.id,
    }).id;

    ids.messageClientArtisan = this.fill('message', { interventionId: job.id, senderId: client.id, audience: 'CLIENT_ARTISAN', content: mark(h, 'message client to artisan') }).id;
    ids.messageClientSupport = this.fill('message', { interventionId: job.id, senderId: client.id, audience: 'CLIENT_SUPPORT', content: mark(h, 'message client to support') }).id;
    ids.messageArtisanSupport = this.fill('message', { interventionId: job.id, senderId: artisan.id, audience: 'ARTISAN_SUPPORT', content: mark(h, 'message artisan to support') }).id;
    ids.adminNote = this.fill('adminInternalNote', { targetType: 'INTERVENTION', targetId: job.id, content: mark(h, 'internal note') }).id;

    for (const [who, user] of [['client', client], ['artisan', artisan]] as const) {
      ids[`${who}Notification`] = this.fill('notification', { recipientId: user.id, type: 'QUOTE_SENT', title: mark(h, `${who} notification title`), message: mark(h, `${who} notification text`) }).id;
      ids[`${who}PushToken`] = this.fill('pushDeviceToken', { userId: user.id }).id;
      ids[`${who}Preferences`] = this.fill('notificationPreference', { userId: user.id }).id;
      // a session of the person (the hash of a token that nobody must ever be shown)
      ids[`${who}Session`] = this.fill('authToken', { userId: user.id, type: 'REFRESH', expiresAt: new Date('2027-01-01T00:00:00Z') }).id;
    }

    ids.damagePhoto = this.fill('fileAsset', { uploadedById: client.id, purpose: 'CLIENT_DAMAGE_PHOTO', entityType: 'INTERVENTION', entityId: job.id, mimeType: 'image/png', size: 10 }).id;
    ids.quotePdf = this.fill('fileAsset', { uploadedById: artisan.id, purpose: 'QUOTE_PDF', entityType: 'QUOTE', entityId: quote.id, mimeType: 'application/pdf', size: 10 }).id;
    ids.invoicePdf = this.fill('fileAsset', { uploadedById: null, purpose: 'INVOICE_PDF', entityType: 'INVOICE', entityId: invoice.id, mimeType: 'application/pdf', size: 10 }).id;
    ids.identityDocument = this.fill('fileAsset', { uploadedById: artisan.id, purpose: 'IDENTITY_DOCUMENT', entityType: 'ARTISAN_PROFILE', entityId: profile.id, mimeType: 'application/pdf', size: 10 }).id;

    const complaint = this.fill('complaint', { interventionId: job.id, userId: client.id, title: mark(h, 'complaint title'), description: mark(h, 'complaint text') });

    ids.complaint = complaint.id;
    ids.complaintMessage = this.fill('complaintMessage', { complaintId: complaint.id, senderId: client.id, senderRole: 'CLIENT', content: mark(h, 'complaint message') }).id;
    ids.complaintInternalMessage = this.fill('complaintMessage', { complaintId: complaint.id, senderRole: 'ADMIN', content: mark(h, 'internal complaint message'), isInternal: true }).id;
    ids.complaintAttachment = this.fill('fileAsset', { uploadedById: client.id, purpose: 'COMPLAINT_ATTACHMENT', entityType: 'COMPLAINT', entityId: complaint.id, mimeType: 'image/png', size: 10 }).id;
    ids.review = this.fill('review', { interventionId: job.id, clientId: client.id, artisanId: artisan.id, rating: 5 }).id;

    const appointment = this.fill('appointment', { interventionId: job.id, clientId: client.id, artisanId: artisan.id, status: 'SCHEDULED' });

    ids.appointment = appointment.id;
    ids.appointmentRequest = this.fill('appointmentRequest', { appointmentId: appointment.id, requestedById: client.id, type: 'RESCHEDULE' }).id;
    ids.proof = this.fill('proofCapture', { interventionId: job.id, kind: 'BEFORE', status: 'ACCEPTED', submittedById: artisan.id }).id;
    ids.financials = this.fill('interventionFinancials', { interventionId: job.id }).id;
    // cash the artisan took on the job, and the commission on it (the figures are the same in both households)
    ids.cashEntry = this.fill('cashLedgerEntry', { artisanId: artisan.id, type: 'COLLECTION', interventionId: job.id, cashAmount: 120, commissionAmount: 24, commissionRate: 20 }).id;
    ids.payout = this.fill('artisanPayout', { artisanId: artisan.id, status: 'PENDING', periodStart: new Date('2026-09-01T00:00:00Z'), periodEnd: new Date('2026-09-30T00:00:00Z'), notes: mark(h, 'payout notes') }).id;
  }
}


// ---------------------------------------------------------------------------------------------
// The households
// ---------------------------------------------------------------------------------------------

const STAFF: Array<{ key: string; role: StaffKind }> = [
  { key: 'admin', role: 'ADMIN' },
  { key: 'superAdmin', role: 'SUPER_ADMIN' },
  { key: 'support', role: 'SUPPORT' },
  { key: 'dispatcher', role: 'DISPATCHER' },
  { key: 'accountant', role: 'ACCOUNTANT' },
];

export const HOUSEHOLDS: Household[] = ['A', 'B'];

export interface Seeded {
  world: World;
}

/** The server on an empty database. */
export function emptyWorld(): World {
  return new World();
}

/**
 * The server with its two households and its back office. Each household has the same things, so a
 * spec can write a route once and aim it at A and at B.
 */
export function buildWorld(): World {
  const world = new World();

  world.seedEverything();

  return world;
}
