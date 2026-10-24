/**
 * How a job is read with its invoices (P2-07). A job can have had several invoices (one cancelled or credited, then the one that
 * replaced it): it is read with the list, newest first, and the views show the current one (`currentInvoice` in common/views).
 */

/** The invoices of a job, newest first: enough to tell what the job asks for and in which state it is. */
export const INVOICES_OF_JOB = { orderBy: { id: 'desc' as const } };

/** The same, with the lines and the credit notes: what the tracking page and the detail of a job print. */
export const INVOICES_OF_JOB_WITH_LINES = {
  orderBy: { id: 'desc' as const },
  include: {
    items: { orderBy: { id: 'asc' as const } },
    creditNotes: { orderBy: { id: 'asc' as const } },
  },
};
