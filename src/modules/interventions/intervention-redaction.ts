/**
 * Which columns of an Intervention may leave the back office.
 *
 * The same row is shown to staff, to the client who owns the ticket, to the
 * assigned artisan, to artisans browsing the marketplace and (through the
 * tracking link) to a visitor without an account. Staff notes and the tracking
 * token hash must never reach the last four.
 */

/** Columns that only the back office may see. */
export const STAFF_ONLY_FIELDS = [
  'adminInternalNotes',
  'adminReviewStartedAt',
  'trackingToken',
  'cancelledById',
] as const;

/**
 * Columns that identify the client. An artisan who has NOT been assigned the
 * job yet (marketplace) must not get them: they could call the customer
 * directly and bypass the platform.
 */
export const CLIENT_CONTACT_FIELDS = [
  'contactName',
  'contactPhone',
  'contactEmail',
] as const;

function omit<T extends object>(row: T, fields: readonly string[]): any {
  const copy: Record<string, unknown> = { ...(row as Record<string, unknown>) };

  for (const field of fields) {
    delete copy[field];
  }

  return copy;
}

/** For the owning client, the assigned artisan and the tracking-link visitor. */
export function withoutStaffFields<T extends object>(row: T): any {
  return omit(row, STAFF_ONLY_FIELDS);
}

/** For artisans browsing open jobs: no staff data and no way to reach the client. */
export function forMarketplace<T extends object>(row: T): any {
  return omit(row, [...STAFF_ONLY_FIELDS, ...CLIENT_CONTACT_FIELDS]);
}
