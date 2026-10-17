/**
 * Defence in depth for responses (review of P0-06 / P0-16).
 *
 * Many endpoints return Prisma rows with `include`, which carry the columns
 * the back office writes for itself (internal notes, the tracking token hash).
 * Removing them one endpoint at a time is how they leak, so every response
 * that is NOT sent to a back-office user goes through this filter.
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
]);

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
export function stripStaffFields<T>(value: T, depth = 0): T {
  if (depth > 12) return value;

  if (Array.isArray(value)) {
    return value.map((item) => stripStaffFields(item, depth + 1)) as T;
  }

  if (isPlainObject(value)) {
    const copy: Record<string, unknown> = {};

    for (const [key, item] of Object.entries(value)) {
      if (STAFF_ONLY_KEYS.has(key)) continue;

      copy[key] = stripStaffFields(item, depth + 1);
    }

    return copy as T;
  }

  return value;
}
