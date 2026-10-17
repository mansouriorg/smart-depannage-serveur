import { AppointmentRequestStatus, AppointmentStatus } from '../../../generated/prisma/client';

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
