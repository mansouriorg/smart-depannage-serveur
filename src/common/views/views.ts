import { canonicalStatus } from '../../modules/intervention-workflow/intervention-status';
import { Arrival, arrivalOf, positionAge, readLocationConfig } from '../geo/location-rules';
import { each, pick } from './pick';
import { INTERVENTION_COLUMNS, interventionColumnsFor } from './intervention-columns';

/**
 * What the people of a job (and the sockets that serve them) may read (P1-08).
 *
 * The back office gets rows as they are. Everybody else (the customer, a visitor with the
 * tracking link, the artisan, an artisan on the board, the live room of a job) gets one of the
 * copies below: a list of what may be read, not a list of what may not, so a column or a
 * relation nobody thought of stays inside. The rules, in short:
 *
 *   - no note of the back office, no hash of the tracking link, no id of a staff member;
 *   - no message of the internal chat (INTERNAL_ADMIN), and every chat only to its own people;
 *   - no e-mail of the other party in a conversation or an event; a phone number only between the
 *     customer and the artisan who has the job (P1-06), never to the board;
 *   - the artisan's position only while they are on the way.
 */

// ==========================================================
// People
// ==========================================================

/** The artisan, as the customer sees them: a name and a number, nothing else of the account. */
export function artisanForClient(artisan: any) {
  return artisan ? pick(artisan, ['id', 'name', 'phone']) : artisan;
}

/** The artisan, as the visitor with the tracking link sees them (no id of the account). */
export function artisanForTracking(artisan: any) {
  return artisan ? pick(artisan, ['name', 'phone']) : artisan;
}

/** The customer, as the artisan who has the job sees them. */
export function clientForArtisan(client: any) {
  return client ? pick(client, ['id', 'name', 'phone', 'email']) : client;
}

/** The customer's own account, to the customer. */
export function clientOwn(client: any) {
  return client ? pick(client, ['id', 'name', 'email', 'phone']) : client;
}

/** The writer of a message: a name and a role, never an address. */
export function senderOf(sender: any) {
  return sender ? pick(sender, ['id', 'name', 'role']) : sender;
}

/**
 * Where the artisan is: told to the customer while the artisan is on the way (that is what the
 * position is for) and at no other time. The coordinates are the last the app sent; they were
 * given to anybody with the link, for as long as the link lived.
 */
export function artisanPositionIsShared(status: unknown): boolean {
  return canonicalStatus(String(status ?? '')) === 'ARTISAN_ON_THE_WAY';
}

/**
 * When the technician will be there (P3-05), for the customer and the visitor: told while the technician is on the way, like the position it
 * is worked out from, and at no other time. The answer is the one of `arrivalOf`: the minutes from a fresh position, or the reason there are
 * none (the position is old, nobody knows when it was sent, the job has no point on the map). It is added next to the view of the job, not
 * inside it: the shape of the job that the apps are given is read from the view, and this one is a computed value with a time in it.
 */
export function withArrival<View extends object>(view: View, row: any, now: Date = new Date()): View & { arrival?: Arrival } {
  if (!view || !row?.artisan || !artisanPositionIsShared(row.status)) return view;

  return { ...view, arrival: arrivalOf({ artisan: row.artisan, destination: row, now, staleAfterMinutes: readLocationConfig().staleAfterMinutes }) };
}

/**
 * The coordinates go with the technician only while they are fresh (P3-05): a position from this minute is what the customer is shown; one
 * that is old, or whose time nobody knows (the technician closed the app right after setting out), is not served at all, as the minutes
 * are not. Withheld, the view has no `latitude` and `longitude`; `arrival` says why.
 */
function withPosition(person: any, artisan: any, status: unknown, now: Date = new Date()) {
  if (!person || !artisan) return person;

  if (!artisanPositionIsShared(status)) return person;

  if (positionAge(artisan.positionAt, now, readLocationConfig().staleAfterMinutes).state !== 'fresh') return person;

  return { ...person, ...pick(artisan, ['latitude', 'longitude']) };
}

// ==========================================================
// What hangs off a job
// ==========================================================

/** The service, as the catalogue shows it to everybody. */
export function subServiceView(service: any) {
  return service
    ? pick(service, [
        'id',
        'categoryId',
        'name',
        'description',
        'estimatedDuration',
        'basePrice',
        'emergencyPrice',
        'requiresPhotos',
        'isActive',
      ])
    : service;
}

/**
 * A line of the timeline that a customer or an artisan may read. A note of the back office is
 * not one (INTERNAL_NOTE_ADDED), and neither is a line written for the back office alone: the
 * event carries `metadata.internal` for those, and the line the artisan's problem report wrote
 * before the flag existed is recognised by its title.
 */
const LEGACY_INTERNAL_TITLES = new Set(['Problème signalé par artisan']);

export function isInternalEvent(event: any): boolean {
  if (!event) return true;

  if (event.type === 'INTERNAL_NOTE_ADDED') return true;

  if (event.metadata && typeof event.metadata === 'object' && (event.metadata as any).internal === true) return true;

  return LEGACY_INTERNAL_TITLES.has(event.title);
}

/** The timeline for the people of the job: no internal line, no author, no metadata. */
export function eventsForParties(events: any[] | null | undefined) {
  return each(
    (events ?? []).filter((event) => !isInternalEvent(event)),
    (event) => pick(event, ['id', 'interventionId', 'type', 'title', 'message', 'createdAt']),
  );
}

function itemView(item: any) {
  return pick(item, ['id', 'label', 'description', 'quantity', 'unitPrice', 'total']);
}

const QUOTE_COLUMNS = [
  'id',
  'interventionId',
  'title',
  'description',
  'currency',
  'amountHT',
  'taxRate',
  'taxAmount',
  'amountTTC',
  'status',
  'clientNote',
  'pdfUrl',
  'expiresAt',
  'revision',
  'sentAt',
  'acceptedAt',
  'rejectedAt',
  'expiredAt',
  'cancelledAt',
  'createdAt',
  'updatedAt',
];

/** Which side of the job is reading: the customer who owns it, or the artisan who has it. */
type Side = 'client' | 'artisan';

/**
 * The job as it sits inside a quote, a payment, an invoice or a receipt: the copy that the job's
 * own routes give this reader, not the row (which has the columns of the other side and of the
 * back office).
 */
function jobIn(job: any, side: Side) {
  if (!job) return job;

  return side === 'client' ? interventionForClient(job) : interventionForArtisan(job);
}

function quoteBody(quote: any, side: Side | null) {
  return {
    ...pick(quote, QUOTE_COLUMNS),
    ...(Array.isArray(quote.items) ? { items: each(quote.items, itemView) } : {}),
    ...(side && quote.intervention !== undefined ? { intervention: jobIn(quote.intervention, side) } : {}),
  };
}

const QUOTE_REVISION_COLUMNS = ['id', 'quoteId', 'revision', 'status', 'title', 'description', 'currency', 'pdfUrl', 'amountHT', 'taxRate', 'taxAmount', 'amountTTC', 'savedAt'];

/**
 * The versions that edits replaced, for the people who work on the quote: the artisan of the job and the back office. Who made
 * each edit is for the back office only.
 */
export function quoteRevisionsView(quote: any, revisions: any[] | null | undefined, backOffice: boolean) {
  return {
    quoteId: quote.id,
    revision: Number.isInteger(Number(quote.revision)) && Number(quote.revision) >= 1 ? Number(quote.revision) : 1,
    revisions: each(revisions ?? [], (revision) => ({
      ...pick(revision, backOffice ? [...QUOTE_REVISION_COLUMNS, 'savedById'] : QUOTE_REVISION_COLUMNS),
      items: Array.isArray(revision.items) ? each(revision.items, (line: any) => pick(line, ['label', 'description', 'quantity', 'unitPrice', 'total'])) : [],
    })),
  };
}

/** A quote the customer may see: not a draft, and without who wrote it. */
export function quotesForParties(quotes: any[] | null | undefined) {
  return each(
    (quotes ?? []).filter((quote) => quote && quote.status !== 'DRAFT'),
    (quote) => quoteBody(quote, null),
  );
}

/** One quote, for the answer to an action on it. */
export function quoteForParties(quote: any) {
  return quote ? (quotesForParties([quote])[0] ?? null) : quote;
}

/** A quote as the customer who owns the job reads it (a draft is not theirs yet): the job inside is theirs too. */
export function quoteForClient(quote: any) {
  if (!quote || quote.status === 'DRAFT') return null;

  return quoteBody(quote, 'client');
}

/** A quote as the artisan reads it: their own drafts included, nobody's name on it. */
export function quoteForArtisan(quote: any) {
  return quote ? quoteBody(quote, 'artisan') : quote;
}

const PAYMENT_FOR_CLIENT = [
  'id',
  'interventionId',
  'quoteId',
  'invoiceId',
  'method',
  'provider',
  'status',
  'amount',
  'amountRefunded',
  'currency',
  'reference',
  'receiptNumber',
  'receiptUrl',
  'receiptGeneratedAt',
  'clientNote',
  'requestedAt',
  'confirmedAt',
  'failedAt',
  'refundedAt',
  'cancelledAt',
  'createdAt',
  'updatedAt',
];

const PAYMENT_FOR_ARTISAN = [
  'id',
  'interventionId',
  'quoteId',
  'invoiceId',
  'status',
  'amount',
  'amountRefunded',
  'currency',
  'confirmedAt',
  'requestedAt',
  'createdAt',
];

/**
 * A payment as the customer sees it: no note of the back office, no id of the provider, no staff
 * id, and what hangs off it (the job, the quote, the invoice) in the copy that is theirs.
 */
export function paymentForClient(payment: any) {
  if (!payment) return payment;

  return {
    ...pick(payment, PAYMENT_FOR_CLIENT),
    // The page of the provider where a card payment is made (P2-10): given while the payment waits for the customer, and only then (null
    // otherwise). A link that is no longer good is not handed out, and a payment that is over has no use for it.
    ...(payment.status === 'PENDING' && payment.providerPaymentId
      ? { payUrl: payment.payUrl ?? null, expiresAt: payment.expiresAt ?? null }
      : { payUrl: null, expiresAt: null }),
    ...(payment.intervention !== undefined ? { intervention: jobIn(payment.intervention, 'client') } : {}),
    ...(payment.quote !== undefined ? { quote: quoteForClient(payment.quote) } : {}),
    ...(payment.invoice !== undefined ? { invoice: invoiceForClient(payment.invoice) } : {}),
  };
}

/** A payment as the artisan sees it: what was paid and when, not how the customer paid. */
export function paymentForArtisan(payment: any) {
  if (!payment) return payment;

  return {
    ...pick(payment, PAYMENT_FOR_ARTISAN),
    ...(payment.intervention !== undefined ? { intervention: jobIn(payment.intervention, 'artisan') } : {}),
    ...(payment.quote !== undefined ? { quote: quoteForArtisan(payment.quote) } : {}),
    ...(payment.invoice !== undefined ? { invoice: invoiceForArtisan(payment.invoice) } : {}),
  };
}

const INVOICE_COMMON = [
  'id',
  'interventionId',
  'invoiceNumber',
  'status',
  'paymentStatus',
  'companyName',
  'companyPhone',
  'companyEmail',
  'companyAddress',
  'companyTaxId',
  'companyWebsite',
  'companyRegistre',
  'companyRib',
  'legalMentions',
  'paymentTerms',
  'stampDuty',
  'creditedAmount',
  'interventionDescription',
  'interventionAddress',
  'serviceType',
  'subServiceName',
  'currency',
  'amountHT',
  'taxRate',
  'taxAmount',
  'amountTTC',
  'pdfUrl',
  'notes',
  'issuedAt',
  'sentAt',
  'paidAt',
  'cancelledAt',
  'createdAt',
  'updatedAt',
];

/** A credit note is read by the customer and the artisan as it is printed: what it takes back and why. Who wrote it stays with the back office. */
const CREDIT_NOTE_COLUMNS = [
  'id',
  'invoiceId',
  'interventionId',
  'creditNoteNumber',
  'reason',
  'currency',
  'amountHT',
  'taxRate',
  'taxAmount',
  'amountTTC',
  'stampDuty',
  'issuedAt',
  'createdAt',
];

export function creditNoteView(creditNote: any) {
  return creditNote ? pick(creditNote, CREDIT_NOTE_COLUMNS) : creditNote;
}

/**
 * The artisan reads what a credit note took back, not why: the reason is written for the customer (it may speak of the artisan's
 * work), and the timeline the artisan reads leaves it out too.
 */
const CREDIT_NOTE_COLUMNS_ARTISAN = CREDIT_NOTE_COLUMNS.filter((column) => column !== 'reason');

export function creditNoteForArtisan(creditNote: any) {
  return creditNote ? pick(creditNote, CREDIT_NOTE_COLUMNS_ARTISAN) : creditNote;
}

/**
 * The invoice a job shows (P2-07): a job can have had several (one cancelled or credited, then the one that replaced it). It is the
 * latest that is not cancelled; when all were cancelled, the latest of them (the customer is told it was cancelled).
 */
export function currentInvoice(invoices: any[] | null | undefined): any | null {
  if (!Array.isArray(invoices) || invoices.length === 0) return null;

  const newestFirst = [...invoices].sort((a, b) => Number(b.id) - Number(a.id));

  return newestFirst.find((invoice) => invoice.status !== 'CANCELLED') ?? newestFirst[0];
}

/** The invoice of a job row, whether the row was read with the list of its invoices (`invoices`) or with the one invoice it already shows (`invoice`). */
function invoiceOfJob(row: any): any {
  return row.invoices !== undefined ? currentInvoice(row.invoices) : row.invoice;
}

const hasInvoice = (row: any): boolean => row.invoices !== undefined || row.invoice !== undefined;

/**
 * An invoice is the customer's once it is out of draft. The payments and the job on it are shown
 * as they are everywhere else; the invoice's own record of where it was e-mailed and why it was
 * cancelled stays with the back office.
 */
export function invoiceForClient(invoice: any) {
  if (!invoice || invoice.status === 'DRAFT') return null;

  return {
    ...pick(invoice, [...INVOICE_COMMON, 'clientName', 'clientEmail', 'clientPhone', 'clientAddress', 'clientTaxId']),
    ...(Array.isArray(invoice.items) ? { items: each(invoice.items, itemView) } : {}),
    ...(Array.isArray(invoice.creditNotes) ? { creditNotes: each(invoice.creditNotes, creditNoteView) } : {}),
    ...(Array.isArray(invoice.payments) ? { payments: each(invoice.payments, paymentForClient) } : {}),
    ...(invoice.intervention !== undefined ? { intervention: jobIn(invoice.intervention, 'client') } : {}),
  };
}

/**
 * The artisan sees that there is an invoice and what it says, not the customer's details on it: so no file of the invoice (an uploaded
 * PDF carries those details, and the PDF the server draws is not the artisan's either) and no reason on the credit notes.
 */
const INVOICE_COLUMNS_ARTISAN = INVOICE_COMMON.filter((column) => column !== 'pdfUrl');

export function invoiceForArtisan(invoice: any) {
  if (!invoice || invoice.status === 'DRAFT') return null;

  return {
    ...pick(invoice, INVOICE_COLUMNS_ARTISAN),
    ...(Array.isArray(invoice.items) ? { items: each(invoice.items, itemView) } : {}),
    ...(Array.isArray(invoice.creditNotes) ? { creditNotes: each(invoice.creditNotes, creditNoteForArtisan) } : {}),
    ...(Array.isArray(invoice.payments) ? { payments: each(invoice.payments, paymentForArtisan) } : {}),
    ...(invoice.intervention !== undefined ? { intervention: jobIn(invoice.intervention, 'artisan') } : {}),
  };
}

const REVIEW_COLUMNS = [
  'id',
  'interventionId',
  'rating',
  'comment',
  'isOnTime',
  'isWorkClean',
  'isPriceRespected',
  'wouldRecommend',
  'createdAt',
  'updatedAt',
];

/** A review without its moderation (who judged it, why it is hidden). */
export function reviewForParties(review: any) {
  return review ? pick(review, REVIEW_COLUMNS) : review;
}

/** What a review says about the job it is on, for a reader who is on that job. */
const REVIEW_JOB_OWN = ['id', 'description', 'address', 'serviceType', 'status', 'createdAt', 'workCompletedAt', 'paidAt'];
/** … and for anybody else: what kind of job and when, never where. */
const REVIEW_JOB_PUBLIC = ['id', 'serviceType', 'createdAt', 'workCompletedAt'];

/**
 * A review as the customer who wrote it reads it (it shows whether it is waiting for the back
 * office), with the artisan's name, number and figures but no e-mail.
 */
export function reviewForAuthor(review: any) {
  if (!review) return review;

  return {
    ...pick(review, [...REVIEW_COLUMNS, 'clientId', 'artisanId', 'status', 'isVisible']),
    ...(review.client !== undefined ? { client: review.client ? clientOwn(review.client) : review.client } : {}),
    ...(review.artisan !== undefined
      ? {
          artisan: review.artisan
            ? { ...artisanForClient(review.artisan), ...(review.artisan.artisanProfile !== undefined ? { artisanProfile: review.artisan.artisanProfile } : {}) }
            : review.artisan,
        }
      : {}),
    ...(review.intervention !== undefined ? { intervention: review.intervention ? pick(review.intervention, REVIEW_JOB_OWN) : review.intervention } : {}),
  };
}

/** A review as the artisan it is about reads it: the customer's name, nothing to reach them by. */
export function reviewForSubject(review: any) {
  if (!review) return review;

  return {
    ...pick(review, [...REVIEW_COLUMNS, 'clientId', 'artisanId']),
    ...(review.client !== undefined ? { client: review.client ? pick(review.client, ['id', 'name']) : review.client } : {}),
    ...(review.artisan !== undefined ? { artisan: review.artisan ? pick(review.artisan, ['id', 'name']) : review.artisan } : {}),
    ...(review.intervention !== undefined ? { intervention: review.intervention ? pick(review.intervention, REVIEW_JOB_OWN) : review.intervention } : {}),
  };
}

/** A review as anybody else reads it (a profile, a lookup by number): stars and words, a first name, no place. */
export function reviewForPublic(review: any) {
  if (!review) return review;

  return {
    ...pick(review, REVIEW_COLUMNS),
    ...(review.client !== undefined ? { client: review.client ? pick(review.client, ['name']) : review.client } : {}),
    ...(review.artisan !== undefined ? { artisan: review.artisan ? pick(review.artisan, ['id', 'name']) : review.artisan } : {}),
    ...(review.intervention !== undefined ? { intervention: review.intervention ? pick(review.intervention, REVIEW_JOB_PUBLIC) : review.intervention } : {}),
  };
}

/** A message of a complaint thread as the customer or the artisan reads it: the words and the writer's name, never the address or the number. */
export function complaintMessageForParties(message: any) {
  if (!message) return message;

  return {
    ...pick(message, ['id', 'complaintId', 'senderId', 'senderRole', 'content', 'attachments', 'createdAt', 'updatedAt']),
    ...(message.sender ? { sender: senderOf(message.sender) } : {}),
  };
}

/**
 * A complaint as the customer who made it, or the artisan it is about, reads it: the decision, not
 * the notes or the people behind it. The thread has no message of the back office's own, nor a
 * message that was deleted; the writers are names, not addresses.
 */
export function complaintForClient(complaint: any) {
  if (!complaint) return complaint;

  return {
    ...pick(complaint, [
      'id',
      'interventionId',
      'userId',
      'title',
      'description',
      'photos',
      'attachments',
      'status',
      'clientMessage',
      'artisanResponse',
      'artisanRespondedAt',
      'adminDecision',
      'refundRequested',
      'refundDecision',
      'refundApproved',
      'refundAmount',
      'resolutionNotes',
      'resolvedAt',
      'rejectedAt',
      'closedAt',
      'createdAt',
      'updatedAt',
    ]),
    ...(complaint.user !== undefined ? { user: complaint.user ? senderOf(complaint.user) : complaint.user } : {}),
    ...(complaint.intervention !== undefined
      ? {
          intervention: complaint.intervention
            ? pick(complaint.intervention, [
                'id',
                'description',
                'address',
                'serviceType',
                'status',
                'urgency',
                'clientId',
                'artisanId',
                'contactName',
                'contactPhone',
                'createdAt',
              ])
            : complaint.intervention,
        }
      : {}),
    ...(Array.isArray(complaint.messages)
      ? {
          messages: each(
            complaint.messages.filter((message: any) => message && !message.isInternal && !message.deletedAt),
            complaintMessageForParties,
          ),
        }
      : {}),
  };
}

// ==========================================================
// The visit (the appointment of a job)
// ==========================================================

const APPOINTMENT_COLUMNS = [
  'id',
  'interventionId',
  'clientId',
  'artisanId',
  'status',
  'preferredDate',
  'preferredStartTime',
  'preferredEndTime',
  'startsAt',
  'endsAt',
  'timezone',
  'clientNote',
  'confirmedAt',
  'cancelledAt',
  'cancelReason',
  'createdAt',
  'updatedAt',
];

const APPOINTMENT_REQUEST_COLUMNS = [
  'id',
  'appointmentId',
  'requestedById',
  'type',
  'status',
  'requestedStartAt',
  'requestedEndAt',
  'reason',
  'reviewedAt',
  'createdAt',
  'updatedAt',
];

/**
 * A request to move or cancel a visit as the customer or the artisan reads it. The back office's
 * answer is addressed to whoever asked and stays with them; the other party sees that there is a
 * request and what it asks, not what the back office wrote back, nor who reviewed it.
 */
export function appointmentRequestForParties(request: any, viewerId: number) {
  if (!request) return request;

  return {
    ...pick(request, APPOINTMENT_REQUEST_COLUMNS),
    ...(request.requestedById === viewerId ? pick(request, ['adminResponse']) : {}),
  };
}

/**
 * The visit of a job as the customer or the artisan reads it: when, with whom, and what each side
 * wrote, but not the back office's note, nor who planned it, nor the reminders the server keeps.
 * The other side is a name and a number (the customer's e-mail goes to the artisan of the job, as
 * everywhere else; the artisan's never goes to the customer).
 */
export function appointmentForParties(appointment: any, side: Side, viewerId: number) {
  if (!appointment) return appointment;

  return {
    ...pick(appointment, APPOINTMENT_COLUMNS),
    ...(appointment.client !== undefined
      ? { client: appointment.client ? (side === 'client' ? clientOwn(appointment.client) : clientForArtisan(appointment.client)) : appointment.client }
      : {}),
    ...(appointment.artisan !== undefined
      ? {
          artisan: appointment.artisan
            ? side === 'client'
              ? artisanForClient(appointment.artisan)
              : pick(appointment.artisan, ['id', 'name', 'phone', 'email'])
            : appointment.artisan,
        }
      : {}),
    ...(Array.isArray(appointment.requests) ? { requests: each(appointment.requests, (request) => appointmentRequestForParties(request, viewerId)) } : {}),
  };
}

// ==========================================================
// Files
// ==========================================================

const FILE_COLUMNS = [
  'id',
  'purpose',
  'visibility',
  'entityType',
  'entityId',
  'originalName',
  'mimeType',
  'extension',
  'size',
  'isImage',
  'width',
  'height',
  'publicUrl',
  'createdAt',
  'updatedAt',
];

/**
 * A file as somebody who is not the back office reads it: what it is and where to fetch it, not
 * where the server keeps it (the path, the storage, the checksum), nor who replaced it, nor the
 * uploader's address or id.
 */
export function fileForParties(asset: any) {
  if (!asset) return asset;

  return {
    ...pick(asset, FILE_COLUMNS),
    ...(asset.uploadedBy ? { uploadedBy: pick(asset.uploadedBy, ['name', 'role']) } : {}),
  };
}

// ==========================================================
// Messages
// ==========================================================

/** The chats a person may read: the artisan is not in the one with the customer's support, nor the customer in the artisan's. */
const CHATS: Record<'client' | 'artisan', readonly string[]> = {
  client: ['CLIENT_ARTISAN', 'CLIENT_SUPPORT'],
  artisan: ['CLIENT_ARTISAN', 'ARTISAN_SUPPORT'],
};

/** A message as a customer or an artisan reads it: no other reader's id, no address of the writer. */
export function messageForParties(message: any, viewerId?: number) {
  if (!message) return message;

  const readers: number[] = Array.isArray(message.readByUserIds) ? message.readByUserIds : [];

  return {
    ...pick(message, [
      'id',
      'interventionId',
      'senderId',
      'audience',
      'content',
      'attachments',
      'isRead',
      'readAt',
      'createdAt',
      'updatedAt',
    ]),
    ...(viewerId === undefined ? {} : { read: message.senderId === viewerId || readers.includes(viewerId) }),
    ...(message.sender ? { sender: senderOf(message.sender) } : {}),
  };
}

/** The messages of a job that this person may read: their chats only, none that was deleted. */
export function messagesFor(role: 'client' | 'artisan', messages: any[] | null | undefined, viewerId?: number) {
  const allowed = CHATS[role];

  return each(
    (messages ?? []).filter((message) => message && !message.deletedAt && allowed.includes(message.audience)),
    (message) => messageForParties(message, viewerId),
  );
}

/** The audiences to ask the database for, so the others never leave it. */
export function chatsOf(role: 'client' | 'artisan'): string[] {
  return [...CHATS[role]];
}

// ==========================================================
// The job
// ==========================================================

function withColumns(row: any, viewer: Parameters<typeof interventionColumnsFor>[0]) {
  return pick(row, interventionColumnsFor(viewer));
}

/** A job and what hangs off it, as the signed-in customer who owns it sees it. */
export function interventionForClient(row: any) {
  if (!row) return row;

  return {
    ...withColumns(row, 'client'),
    ...(row.client !== undefined ? { client: clientOwn(row.client) } : {}),
    ...(row.artisan !== undefined
      ? { artisan: withPosition(artisanForClient(row.artisan), row.artisan, row.status) }
      : {}),
    ...(row.subService !== undefined ? { subService: subServiceView(row.subService) } : {}),
    ...(row.events !== undefined ? { events: eventsForParties(row.events) } : {}),
    ...(row.quotes !== undefined ? { quotes: quotesForParties(row.quotes) } : {}),
    ...(row.payments !== undefined ? { payments: each(row.payments, paymentForClient) } : {}),
    ...(hasInvoice(row) ? { invoice: invoiceForClient(invoiceOfJob(row)) } : {}),
    ...(row.review !== undefined ? { review: reviewForParties(row.review) } : {}),
    ...(row.complaints !== undefined ? { complaints: each(row.complaints, complaintForClient) } : {}),
    ...(row.messages !== undefined ? { messages: messagesFor('client', row.messages, row.clientId) } : {}),
  };
}

/** The same job for the visitor who holds the tracking link: no account, no id of anybody. */
export function interventionForTracking(row: any) {
  if (!row) return row;

  return {
    ...withColumns(row, 'tracking'),
    ...(row.artisan !== undefined
      ? { artisan: withPosition(artisanForTracking(row.artisan), row.artisan, row.status) }
      : {}),
    ...(row.subService !== undefined ? { subService: subServiceView(row.subService) } : {}),
    ...(row.events !== undefined ? { events: eventsForParties(row.events) } : {}),
    ...(row.quotes !== undefined ? { quotes: quotesForParties(row.quotes) } : {}),
    ...(row.payments !== undefined ? { payments: each(row.payments, paymentForClient) } : {}),
    ...(hasInvoice(row) ? { invoice: invoiceForClient(invoiceOfJob(row)) } : {}),
    ...(row.review !== undefined ? { review: reviewForParties(row.review) } : {}),
  };
}

/**
 * A job on the board of open jobs: what it is and where, nothing that reaches the customer. The
 * lists the details screen expects are there and empty (nobody on the board reads the timeline or
 * the conversation of a job, nor what was paid), and so is the invoice; whoever was on the job
 * before (the artisan relation) is not told.
 */
export function interventionForBoard(row: any) {
  if (!row) return row;

  return {
    ...withColumns(row, 'board'),
    ...(row.client !== undefined ? { client: row.client ? pick(row.client, ['name']) : row.client } : {}),
    ...(row.subService !== undefined ? { subService: subServiceView(row.subService) } : {}),
    ...(row.quotes !== undefined ? { quotes: quotesForParties(row.quotes) } : {}),
    ...(row.review !== undefined ? { review: reviewForParties(row.review) } : {}),
    ...(row.events !== undefined ? { events: [] } : {}),
    ...(row.messages !== undefined ? { messages: [] } : {}),
    ...(row.payments !== undefined ? { payments: [] } : {}),
    ...(hasInvoice(row) ? { invoice: null } : {}),
  };
}

/** A job for everybody in its live room: the status and the dates, no person, no contact. */
export function interventionForRoom(row: any) {
  if (!row) return row;

  return withColumns(row, 'room');
}

/**
 * The relations of a job that the artisan's copy knows how to show. Anything else that is an
 * object or a list (a relation somebody adds to an `include` later) is left out until it is added
 * here with its own view; a plain value a route computes (a distance, a link) passes.
 */
function isPlainValue(value: unknown): boolean {
  return value === null || typeof value !== 'object' || value instanceof Date;
}

/** The answer of the artisan's routes, and the socket of the artisan: the job without the back office's columns. */
export function interventionForArtisan(row: any) {
  if (!row) return row;

  const copy: Record<string, any> = { ...row };

  // A job read with the list of its invoices shows the current one.
  if (copy.invoices !== undefined) {
    copy.invoice = currentInvoice(copy.invoices);
    delete copy.invoices;
  }

  const allowed = new Set(interventionColumnsFor('artisan'));
  const shaped = new Set(['client', 'artisan', 'subService', 'events', 'messages', 'quotes', 'payments', 'invoice', 'review']);

  for (const key of Object.keys(copy)) {
    if (key in INTERVENTION_COLUMNS) {
      if (!allowed.has(key)) delete copy[key];

      continue;
    }

    // A relation or a list nobody listed (the complaints, for one: they are between the customer and the back office).
    if (!shaped.has(key) && !isPlainValue(copy[key])) delete copy[key];
  }

  if (copy.client !== undefined) copy.client = clientForArtisan(copy.client);
  if (copy.artisan !== undefined) copy.artisan = copy.artisan ? pick(copy.artisan, ['id', 'name', 'phone', 'email', 'latitude', 'longitude']) : copy.artisan;
  if (copy.subService !== undefined) copy.subService = subServiceView(copy.subService);
  if (copy.events !== undefined) copy.events = eventsForParties(copy.events);
  if (copy.messages !== undefined) copy.messages = messagesFor('artisan', copy.messages);
  if (copy.quotes !== undefined) copy.quotes = quotesForParties(copy.quotes);
  if (copy.payments !== undefined) copy.payments = each(copy.payments, paymentForArtisan);
  if (copy.invoice !== undefined) copy.invoice = invoiceForArtisan(copy.invoice);
  if (copy.review !== undefined) copy.review = reviewForParties(copy.review);

  return copy;
}

/** Every column of the table above, for the test that compares it with the schema. */
export const KNOWN_INTERVENTION_COLUMNS = Object.keys(INTERVENTION_COLUMNS);
