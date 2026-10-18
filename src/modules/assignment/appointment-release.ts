import { AppointmentRequestStatus, AppointmentStatus } from '../../../generated/prisma/client';
import { replaceDefaultReminders } from './appointment-reminders';

/**
 * What happens to the visit of a job when the artisan who had it no longer does
 * (the dispatcher gives the job to somebody else, or the artisan gives it back).
 * One rule for both, so a visit never stays in the name of somebody who left
 * the job (P1-05, P1-06).
 */

type Db = {
  appointment: { update: (args: any) => Promise<any> };
};

type RequestsDb = {
  appointmentRequest: { updateMany: (args: any) => Promise<any> };
};

/**
 * The visit loses its artisan, and the status stops saying that a request about it is
 * open (the requests themselves are closed by `closePendingRequests`): a cancellation
 * that was asked for is done, a new time that was asked for is dropped.
 */
export async function detachAppointment(
  db: Db,
  appointment: { interventionId: number; status: AppointmentStatus },
  reason: string,
) {
  const closed =
    appointment.status === AppointmentStatus.CANCEL_REQUESTED
      ? { status: AppointmentStatus.CANCELLED, cancelledAt: new Date(), cancelReason: reason }
      : appointment.status === AppointmentStatus.RESCHEDULE_REQUESTED
        ? { status: AppointmentStatus.SCHEDULED }
        : {};

  return db.appointment.update({
    where: { interventionId: appointment.interventionId },
    data: { artisanId: null, ...closed },
  });
}

/**
 * A request about the visit (move it, cancel it) is a request about the visit as it
 * was. Once the visit is rewritten or taken away from its artisan, an approval would
 * act on a visit that no longer exists, so the open ones are closed.
 */
export async function closePendingRequests(
  db: RequestsDb,
  appointmentId: number,
  how: { response: string; reviewedById?: number },
) {
  return db.appointmentRequest.updateMany({
    where: { appointmentId, status: AppointmentRequestStatus.PENDING },
    data: {
      status: AppointmentRequestStatus.CANCELLED,
      adminResponse: how.response,
      ...(how.reviewedById !== undefined ? { reviewedById: how.reviewedById } : {}),
      reviewedAt: new Date(),
    },
  });
}

type VisitDb = Db &
  RequestsDb & {
    appointment: Db['appointment'] & { findUnique: (args: any) => Promise<any> };
    appointmentReminder: {
      deleteMany: (args: any) => Promise<unknown>;
      createMany: (args: any) => Promise<unknown>;
    };
  };

/** A visit that is over or already cancelled has nothing left to cancel. */
const VISIT_ENDED: readonly AppointmentStatus[] = [
  AppointmentStatus.CANCELLED,
  AppointmentStatus.COMPLETED,
  AppointmentStatus.NO_SHOW,
];

/**
 * The job is cancelled, so its visit is too (P1-13): the technician's calendar is free again, the
 * requests still waiting about the visit are closed, and the reminders not sent yet are dropped
 * (they must not go out for a visit that will not happen). A job with no visit, or whose visit is
 * over, is left alone. Returns the visit that was cancelled, or null.
 */
export async function cancelVisit(
  db: VisitDb,
  interventionId: number,
  reason: string,
  reviewedById?: number,
) {
  const visit = await db.appointment.findUnique({
    where: { interventionId },
    select: { id: true, interventionId: true, status: true, clientId: true, artisanId: true },
  });

  if (!visit || VISIT_ENDED.includes(visit.status)) return null;

  await db.appointment.update({
    where: { id: visit.id },
    data: { status: AppointmentStatus.CANCELLED, cancelledAt: new Date(), cancelReason: reason },
  });

  await closePendingRequests(db, visit.id, {
    response: 'Demande classée: la demande d’intervention a été annulée.',
    ...(reviewedById !== undefined ? { reviewedById } : {}),
  });

  await replaceDefaultReminders(db, {
    id: visit.id,
    startsAt: null,
    clientId: visit.clientId,
    artisanId: visit.artisanId,
  });

  return visit;
}
