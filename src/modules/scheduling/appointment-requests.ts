import { AppointmentRequestType, AppointmentStatus } from '../../../generated/prisma/client';

/**
 * What a visit shows while a request about it waits, and what it shows again once none does (P3-01).
 *
 * A request to move or cancel a visit puts the visit in RESCHEDULE_REQUESTED or CANCEL_REQUESTED. When the back office refuses, the
 * visit has to go back to what it was: SCHEDULED, or CONFIRMED when the artisan had confirmed it. Before, a refusal wrote the
 * request only, and the visit stayed "waiting for an answer" for good (and an artisan who had confirmed lost the confirmation).
 */

/** A visit that is planned, with nothing asked about it: the two states a request is made from. */
export const STEADY_STATUSES: readonly AppointmentStatus[] = [AppointmentStatus.SCHEDULED, AppointmentStatus.CONFIRMED];

/** The states that say a request about the visit is waiting. */
export const WAITING_STATUSES: readonly AppointmentStatus[] = [
  AppointmentStatus.RESCHEDULE_REQUESTED,
  AppointmentStatus.CANCEL_REQUESTED,
];

type VisitState = { status: AppointmentStatus | string; confirmedAt?: Date | null };
type WaitingRequest = { type: AppointmentRequestType | string; previousStatus?: AppointmentStatus | string | null };

const isSteady = (status: unknown): status is AppointmentStatus => (STEADY_STATUSES as readonly unknown[]).includes(status);

/**
 * What the visit was before anything was asked about it. A visit that is steady is what it is. One that shows a request was
 * steady when the first of the waiting requests was made (each request keeps that state), and a request made before the state
 * was kept says nothing: the visit then counts as confirmed when the artisan confirmed it.
 */
export function baseStatusOf(
  visit: VisitState,
  waiting: readonly Pick<WaitingRequest, 'previousStatus'>[] = [],
  answered?: Pick<WaitingRequest, 'previousStatus'>,
): AppointmentStatus {
  if (isSteady(visit.status)) return visit.status;

  for (const request of [answered, ...waiting]) {
    if (request && isSteady(request.previousStatus)) return request.previousStatus;
  }

  return visit.confirmedAt ? AppointmentStatus.CONFIRMED : AppointmentStatus.SCHEDULED;
}

/** What the visit shows given the requests still waiting: a cancellation shows over a move, and none shows what it was. */
export function visitStatusFor(waiting: readonly Pick<WaitingRequest, 'type'>[], base: AppointmentStatus): AppointmentStatus {
  if (waiting.some((request) => request.type === AppointmentRequestType.CANCEL)) return AppointmentStatus.CANCEL_REQUESTED;
  if (waiting.some((request) => request.type === AppointmentRequestType.RESCHEDULE)) return AppointmentStatus.RESCHEDULE_REQUESTED;

  return base;
}
