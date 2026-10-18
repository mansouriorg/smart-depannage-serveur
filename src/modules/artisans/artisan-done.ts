/**
 * The statuses in which an artisan's work on a job is over (P1-15): the photo proof closed it (COMPLETED), or it
 * has moved on to the customer's validation, the payment and the invoice. The "Terminées" pile of the phone app
 * holds exactly these (STAGE_OF_STATUS in mission-flow.ts of the shared package), and the profile counts them,
 * so the number on the profile and the pile cannot disagree.
 */
export const ARTISAN_DONE_STATUSES = [
  'WAITING_CLIENT_VALIDATION',
  'COMPLETED',
  'PAYMENT_PENDING',
  'PAID',
  'INVOICE_SENT',
] as const;
