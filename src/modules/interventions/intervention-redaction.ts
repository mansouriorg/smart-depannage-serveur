import { staffOnlyInterventionColumns } from '../../common/views/intervention-columns';
import { interventionForArtisan, interventionForBoard } from '../../common/views/views';

/**
 * Which columns of an Intervention may leave the back office.
 *
 * The same row is shown to staff, to the client who owns the ticket, to the
 * assigned artisan, to artisans browsing the marketplace and (through the
 * tracking link) to a visitor without an account. The table that says who may
 * read which column is src/common/views/intervention-columns.ts (P1-08); this
 * file keeps the two names the artisan routes already call.
 */

/** Columns that only the back office may see (the table says so: no letter). */
export const STAFF_ONLY_FIELDS: readonly string[] = staffOnlyInterventionColumns();

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

/**
 * For the artisan who has the job: the row without the columns of the back
 * office, and what hangs off it cleaned (the conversation of the artisan's own
 * chats only, a timeline without internal lines, payments without how the
 * customer paid, the customer without anything but a name and a way to call).
 */
export function withoutStaffFields<T extends object>(row: T): any {
  return interventionForArtisan(row);
}

/**
 * For artisans browsing open jobs: what the job is and where, no staff data
 * and no way to reach the client.
 */
export function forMarketplace<T extends object>(row: T): any {
  return interventionForBoard(row);
}
