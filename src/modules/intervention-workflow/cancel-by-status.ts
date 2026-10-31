/**
 * What the back office is told when it tries to cancel a job with a status (P3-01). A status cannot cancel a job: the cancellation asks
 * for the reason the customer and the technician read, frees the technician's booked visit with its reminders, writes who cancelled, and
 * tells the back office about money the job holds.
 */
export const CANCEL_BY_STATUS =
  'Pour annuler la mission, utilisez l’annulation: elle demande un motif et libère le rendez-vous de l’artisan.';
