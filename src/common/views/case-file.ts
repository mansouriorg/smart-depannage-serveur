/**
 * The case file of a job, as the back office reads it (P1-14).
 *
 * The page that follows a job from its request to its end needs more than the customer, the
 * artisan or the tracking link ever get: the whole timeline with the lines that are not for the
 * people of the job (marked, not mixed in), every chat including the team's own, the notes the
 * team wrote, who wrote what, and the way into the building. Until now the staff route handed the
 * page the raw database rows: every column that exists today and every column added tomorrow,
 * the hash of the customer's tracking link, the artisan's last position, who has read which message.
 *
 * This is the other kind of answer: an explicit list. A column of the job is either in
 * CASE_FILE_COLUMNS or in CASE_FILE_WITHHELD with the reason, and `case-file.spec.ts` reads the
 * schema and fails on a column that is in neither, so a new column stays inside until somebody
 * decides that the page shows it (the same rule as the views of the customer and the artisan, in
 * views.ts). It is for the people of the back office; it must never be given to anybody else.
 */

import { each, pick } from './pick';
import { isInternalEvent } from './views';

/** The longest note the team can write on a job (the dashboard's form stops at the same number). */
export const INTERVENTION_NOTE_MAX = 2000;

/** The columns of the job that the case file shows. */
export const CASE_FILE_COLUMNS: readonly string[] = [
  'id',
  'description',
  'address',
  'serviceType',
  'status',
  'urgency',
  'subServiceId',
  'latitude',
  'longitude',
  'preferredDate',
  'preferredStartTime',
  'preferredEndTime',
  'contactName',
  'contactPhone',
  'contactEmail',
  'accessInstructions',
  'apartmentCode',
  'buildingInfo',
  'floor',
  'clientId',
  'artisanId',
  'photos',
  'beforePhotoUrl',
  'beforePhotoLat',
  'beforePhotoLng',
  'beforePhotoAt',
  'afterPhotoUrl',
  'afterPhotoLat',
  'afterPhotoLng',
  'afterPhotoAt',
  'rating',
  'isOnTime',
  'hasIssue',
  'feedbackNotes',
  'requestCreatedAt',
  'adminReviewStartedAt',
  'quoteSentAt',
  'quoteAcceptedAt',
  'assignedAt',
  'waitingClientValidationAt',
  'clientValidatedAt',
  'paymentPendingAt',
  'paidAt',
  'invoiceSentAt',
  'artisanAcceptedAt',
  'artisanRejectedAt',
  'artisanOnTheWayAt',
  'artisanArrivedAt',
  'workStartedAt',
  'workCompletedAt',
  'cancelledAt',
  'diagnosticNotes',
  'extraQuoteRequested',
  'extraQuoteReason',
  'problemReported',
  'problemType',
  'problemNotes',
  'lastStatusChangedAt',
  'cancelledReason',
  'createdAt',
  'updatedAt',
];

/** The columns of the job that the case file does not show, and why. */
export const CASE_FILE_WITHHELD: Readonly<Record<string, string>> = {
  trackingToken: 'the hash of the customer\'s tracking link: whoever holds it can act as the customer',
  adminInternalNotes: 'the old single text column, never written since the notes became rows of their own (the case file lists those)',
  cancelledById: 'replaced by `cancelledBy`, the person with their name and role',
  savedAddressId: 'an entry of the customer\'s address book: the address itself is on the job',
  materialUsed: 'the artisan\'s list of materials: the quote and invoice pages will show it',
  clientSignatureUrl: 'the signature on the paperwork: the invoice page will show it',
  clientSignatureAt: 'the signature on the paperwork: the invoice page will show it',
};

/** A person of the platform as the case file names them. */
export interface CaseFilePerson {
  id: number;
  name: string | null;
  role: string | null;
}

export type CasePeople = ReadonlyMap<number, CaseFilePerson>;

/** The person behind an id: their name and role, or the id alone when the account is gone. */
function personOf(people: CasePeople, id: unknown): CaseFilePerson | null {
  if (typeof id !== 'number') return null;

  return people.get(id) ?? { id, name: null, role: null };
}

function byTimeThenId(a: any, b: any): number {
  const left = new Date(a?.createdAt ?? 0).getTime();
  const right = new Date(b?.createdAt ?? 0).getTime();

  return left - right || (a?.id ?? 0) - (b?.id ?? 0);
}

/** One line of the timeline: everything the team may know about it, and whether the people of the job read it. */
export function timelineEntryOf(event: any, people: CasePeople) {
  return {
    ...pick(event, ['id', 'type', 'title', 'message', 'createdAt']),
    internal: isInternalEvent(event),
    author: personOf(people, event.createdById),
  };
}

/** A message of any chat. A message that was deleted is still told (when, by whom, in which chat) but not read. */
export function caseMessageOf(message: any) {
  const deleted = Boolean(message.deletedAt);

  return {
    ...pick(message, ['id', 'audience', 'createdAt']),
    content: deleted ? null : (message.content ?? null),
    attachments: deleted || !Array.isArray(message.attachments) ? [] : message.attachments,
    deleted,
    sender: message.sender ? pick(message.sender, ['id', 'name', 'role']) : null,
  };
}

/** A note of the team, with who wrote it. */
export function caseNoteOf(note: any, people: CasePeople) {
  return {
    ...pick(note, ['id', 'content', 'createdAt']),
    author: personOf(people, note.authorId),
  };
}

export interface CaseFileInput {
  /** The job, with its `client`, `artisan` and `subService` relations. */
  job: any;
  events: any[] | null | undefined;
  messages: any[] | null | undefined;
  notes: any[] | null | undefined;
  people: CasePeople;
}

/**
 * The case file. The timeline and the chats are oldest first (the story in the order it happened),
 * the notes newest first (what the team wrote last is what the next person to open the job needs).
 */
export function caseFileOf(input: CaseFileInput) {
  const { job, people } = input;

  return {
    ...pick(job, CASE_FILE_COLUMNS),
    client: job.client ? pick(job.client, ['id', 'name', 'phone', 'email']) : null,
    artisan: job.artisan ? pick(job.artisan, ['id', 'name', 'phone', 'email']) : null,
    subService: job.subService ? pick(job.subService, ['id', 'name']) : null,
    cancelledBy: personOf(people, job.cancelledById),
    timeline: each(
      (input.events ?? []).filter((event) => event && typeof event === 'object').sort(byTimeThenId),
      (event) => timelineEntryOf(event, people),
    ),
    messages: each(
      (input.messages ?? []).filter((message) => message && typeof message === 'object').sort(byTimeThenId),
      caseMessageOf,
    ),
    notes: each(
      (input.notes ?? [])
        .filter((note) => note && typeof note === 'object' && !note.deletedAt)
        .sort((a, b) => byTimeThenId(b, a)),
      (note) => caseNoteOf(note, people),
    ),
  };
}

/** The ids of the accounts a case file names beyond the ones its relations already carry. */
export function peopleToLookUp(job: any, events: any[], notes: any[]): number[] {
  const ids = new Set<number>();

  for (const candidate of [job?.cancelledById, ...events.map((event) => event?.createdById), ...notes.map((note) => note?.authorId)]) {
    if (typeof candidate === 'number' && Number.isInteger(candidate)) ids.add(candidate);
  }

  return [...ids];
}
