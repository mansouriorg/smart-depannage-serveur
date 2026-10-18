/**
 * Who may read each column of a job (P1-08).
 *
 * One table for the whole API. Every column of the Intervention model has a line here, and a test
 * (views.spec.ts) reads prisma/schema.prisma and fails on a column that is missing, so the answer
 * to "can a customer, a visitor with the tracking link, an artisan or a socket see it?" is
 * decided when the column is added, not discovered in a review.
 *
 * Letters, per column (no letter = the back office only):
 *   C  the customer who owns the job, signed in
 *   T  the visitor who holds the tracking link (the customer, without an account)
 *   A  the artisan who has the job
 *   B  an artisan looking at the board of open jobs (nobody has the job yet)
 *   R  everybody in the live room of the job (the customer, the artisan and the back office read
 *      the same message, so it only has what all of them may have)
 */
export type Viewer = 'client' | 'tracking' | 'artisan' | 'board' | 'room';

export const VIEWER_LETTER: Record<Viewer, string> = {
  client: 'C',
  tracking: 'T',
  artisan: 'A',
  board: 'B',
  room: 'R',
};

export const INTERVENTION_COLUMNS: Record<string, string> = {
  id: 'CTABR',
  description: 'CTAB',
  address: 'CTAB',
  serviceType: 'CTABR',
  status: 'CTABR',
  urgency: 'CTABR',
  subServiceId: 'CTABR',
  savedAddressId: 'C',
  // Where the job is: what an artisan needs to decide whether to take it, so the board has it.
  latitude: 'CTAB',
  longitude: 'CTAB',
  preferredDate: 'CTAB',
  preferredStartTime: 'CTAB',
  preferredEndTime: 'CTAB',
  // The way to reach the customer: only the artisan who has the job (P1-06), never the board.
  contactName: 'CTA',
  contactPhone: 'CTA',
  contactEmail: 'CTA',
  // Door code and how to get in: the same, until the job is theirs.
  accessInstructions: 'CTA',
  apartmentCode: 'CTA',
  buildingInfo: 'CTAB',
  floor: 'CTAB',
  clientId: 'CA',
  artisanId: 'CA',
  photos: 'CTAB',
  beforePhotoUrl: 'CTA',
  beforePhotoLat: 'A',
  beforePhotoLng: 'A',
  beforePhotoAt: 'CTA',
  afterPhotoUrl: 'CTA',
  afterPhotoLat: 'A',
  afterPhotoLng: 'A',
  afterPhotoAt: 'CTA',
  // The hash of the tracking link: the back office only.
  trackingToken: '',
  rating: 'CTA',
  isOnTime: 'CTA',
  hasIssue: 'CTA',
  feedbackNotes: 'CTA',
  requestCreatedAt: 'CTAR',
  adminReviewStartedAt: '',
  quoteSentAt: 'CTAR',
  quoteAcceptedAt: 'CTAR',
  assignedAt: 'CTAR',
  waitingClientValidationAt: 'CTA',
  clientValidatedAt: 'CTA',
  paymentPendingAt: 'CTAR',
  paidAt: 'CTAR',
  invoiceSentAt: 'CTAR',
  artisanAcceptedAt: 'CTAR',
  // That an artisan gave the job back is for the artisan and the back office: the customer is
  // told another artisan is being found, not that one left.
  artisanRejectedAt: 'A',
  artisanOnTheWayAt: 'CTAR',
  artisanArrivedAt: 'CTAR',
  workStartedAt: 'CTAR',
  workCompletedAt: 'CTAR',
  cancelledAt: 'CTAR',
  diagnosticNotes: 'CTA',
  materialUsed: 'CTA',
  extraQuoteRequested: 'CTA',
  extraQuoteReason: 'CTA',
  clientSignatureUrl: 'CTA',
  clientSignatureAt: 'CTA',
  // What the artisan told the back office about a problem on the job.
  problemReported: 'A',
  problemType: 'A',
  problemNotes: 'A',
  lastStatusChangedAt: 'CTAR',
  adminInternalNotes: '',
  cancelledReason: 'CTA',
  cancelledById: '',
  createdAt: 'CTABR',
  updatedAt: 'CTABR',
};

/** The columns of a job that this viewer may read. */
export function interventionColumnsFor(viewer: Viewer): string[] {
  const letter = VIEWER_LETTER[viewer];

  return Object.keys(INTERVENTION_COLUMNS).filter((column) => INTERVENTION_COLUMNS[column].includes(letter));
}

/** The columns that no viewer but the back office may read. */
export function staffOnlyInterventionColumns(): string[] {
  return Object.keys(INTERVENTION_COLUMNS).filter((column) => INTERVENTION_COLUMNS[column] === '');
}
