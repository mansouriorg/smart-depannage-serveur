/**
 * Defence in depth for responses (review of P0-06 / P0-16, widened in P1-08).
 *
 * Many endpoints return Prisma rows with `include`, which carry the columns
 * the back office writes for itself (internal notes, the tracking token hash,
 * who at the back office decided what) and the contact details of the other
 * party. Removing them one endpoint at a time is how they leak, so every
 * response that is NOT sent to a back-office user goes through this filter.
 *
 * The routes that matter most (the job of a customer, the tracking page, the
 * conversation, the sockets) build their answer from an explicit list of what
 * may be read (src/common/views); this filter is what is left for the others
 * (complaints, quotes, payments, invoices, reviews, scheduling) and what stops
 * a new column or a new `include` from leaking through a route nobody listed.
 */

/** Column names that only the back office may read. */
export const STAFF_ONLY_KEYS: ReadonlySet<string> = new Set([
  'adminInternalNotes',
  'adminReviewStartedAt',
  'adminNote', // Payment, Appointment
  'adminNotes', // Complaint
  'internalNotes', // Complaint
  'trackingToken', // sha256 of the public tracking link
  'cancelledById', // which staff member cancelled a ticket
  'actorId', // who caused a notification: it may be a member of the back office
  // Who at the back office decided, handled or moderated, and the text they wrote for themselves.
  'adminDecisionNote',
  'adminDecisionById',
  'refundDecidedById',
  'moderatedById',
  'moderationReason',
  'scheduledById',
  'reviewedById',
  'confirmedById',
  'refundedById',
  'createdById',
  'createdBy', // the writer of a quote, as a user (e-mail and number included)
  'assignedToId',
  'assignedTo', // the staff member who handles a complaint, as a user
  // What the provider and the staff put on a payment or an invoice for themselves.
  'providerPaymentId',
  'failureReason',
  'refundReason',
  'emailedTo',
  'cancelReason',
]);

/**
 * Keys under which a user of the job sits (the customer, the artisan, the writer of a message).
 * Somebody else's account (an object with an id that is not the reader's) loses what would let the
 * reader reach them outside the platform: the e-mail, and the business details of the account.
 * It applies to a signed-in reader and to an object that says whose it is: the answers about the
 * reader's own account (login, profile) and the routes without a reader (the tracking link, which
 * builds its answer from src/common/views) are not touched here.
 */
const PERSON_KEYS: ReadonlySet<string> = new Set(['client', 'artisan', 'sender', 'uploadedBy']);
const OTHER_PEOPLES_KEYS: readonly string[] = ['email', 'taxId', 'website', 'address'];

/** Copies of the customer's details that an invoice keeps: not for the artisan. */
const CLIENT_SNAPSHOT_KEYS: readonly string[] = ['clientEmail', 'clientPhone', 'clientAddress', 'clientTaxId'];

export type ViewerContext = {
  /** Who is reading; null for a visitor with a tracking link. */
  userId?: number | null;
  role?: string | null;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;

  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

/**
 * Returns a copy of `value` without the staff-only keys, at any depth.
 * Only arrays and plain objects are walked: Dates, Prisma Decimals, Buffers
 * and streams are returned untouched.
 */
export function stripStaffFields<T>(value: T, viewer: ViewerContext = {}, parentKey = '', depth = 0): T {
  // Deeper than any answer of this API is: closed, not open (a subtree nobody looked at is not sent).
  if (depth > 12) return (Array.isArray(value) || isPlainObject(value) ? null : value) as T;

  if (Array.isArray(value)) {
    return value.map((item) => stripStaffFields(item, viewer, parentKey, depth + 1)) as T;
  }

  if (isPlainObject(value)) {
    const copy: Record<string, unknown> = {};
    const someoneElse =
      PERSON_KEYS.has(parentKey) &&
      typeof value.id === 'number' &&
      typeof viewer.userId === 'number' &&
      value.id !== viewer.userId;

    for (const [key, item] of Object.entries(value)) {
      if (STAFF_ONLY_KEYS.has(key)) continue;

      // The artisan who has the job is given the customer's e-mail with the phone (P1-06); the
      // board never reaches here with a customer (its copy has the first name only).
      const artisanReadsTheirCustomer = viewer.role === 'ARTISAN' && parentKey === 'client' && key === 'email';

      if (someoneElse && OTHER_PEOPLES_KEYS.includes(key) && !artisanReadsTheirCustomer) continue;

      if (viewer.role === 'ARTISAN' && CLIENT_SNAPSHOT_KEYS.includes(key)) continue;

      copy[key] = stripStaffFields(item, viewer, key, depth + 1);
    }

    return copy as T;
  }

  return value;
}
