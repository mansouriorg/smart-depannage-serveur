import { NotFoundException } from '@nestjs/common';

import { compareMoney, money, subtractMoney } from '../../common/money/money';
import { currencyCode } from '../../common/locale/locale';
import { idOf } from '../../common/search/staff-search';
import { RECEIVED_PAYMENT_STATUSES, amountToPay, liveInvoiceOf, paymentFigures, refundedOn } from '../payments/financials-ops';
import { COMPLAINT_VIEWS, ComplaintQueueQuery, complaintBaseWhere, complaintListSelect, complaintQueueOrder, complaintQueueWhere, complaintViewWhere } from './complaint-queue';

/**
 * What the complaints screen reads (P2-09): a page of the list with the size of each view, and one complaint with its thread, its
 * journal and the money of its job. The database is passed in, so the same code runs in the specs on the in-memory double.
 */

type Db = any;
type Row = Record<string, any>;

export interface ComplaintPaging {
  page: number;
  limit: number;
  skip: number;
  take: number;
}

export type ComplaintCounts = Record<(typeof COMPLAINT_VIEWS)[number], number>;

/** A page of complaints, and how many each view holds under the same search and the same person (the status asked for is not applied). */
export async function complaintList(db: Db, query: ComplaintQueueQuery, actorId: number | null, paging: ComplaintPaging) {
  const where = complaintQueueWhere(query, actorId);
  const base = complaintBaseWhere(query, actorId);

  const [rows, total, ...sizes]: [Row[], number, ...number[]] = await Promise.all([
    db.complaint.findMany({ where, select: complaintListSelect, orderBy: complaintQueueOrder(query.sort), skip: paging.skip, take: paging.take }),
    db.complaint.count({ where }),
    ...COMPLAINT_VIEWS.map((view) => db.complaint.count({ where: { AND: [...base, complaintViewWhere(view)] } })),
  ]);

  const counts = Object.fromEntries(COMPLAINT_VIEWS.map((view, index) => [view, sizes[index]])) as ComplaintCounts;

  return { rows, total, counts };
}

/** The money of a job as a decision about a refund reads it. */
export interface ComplaintMoney {
  currency: string;
  /** What the customer paid (confirmed payments, in the currency of the company). */
  received: number;
  /** What has gone back to the customer. */
  refunded: number;
  /** Received less refunded. */
  kept: number;
  /** The refund that was accepted for this complaint and the money has not all gone back; null when none, or when no amount was stated. */
  accepted: number | null;
  /** What is left to pay of it: accepted less what has gone back on the job (never below 0, never above what the job still holds). */
  remaining: number | null;
  /** The payments the money can go back on. */
  payments: Array<{ id: number; method: string; status: string; amount: number; refundable: number; confirmedAt: Date | null }>;
  /** The invoice that stands now, with what it asks of the customer. */
  invoice: { id: number; number: string; status: string; toPay: number } | null;
}

/** The money of the job of a complaint: figures from its payments, and what was accepted for the complaint. */
export async function complaintMoney(db: Db, complaint: Row): Promise<ComplaintMoney> {
  const [payments, invoice]: [Row[], Row | null] = await Promise.all([
    db.payment.findMany({ where: { interventionId: complaint.interventionId }, orderBy: { id: 'asc' } }),
    liveInvoiceOf(db, complaint.interventionId),
  ]);

  const figures = paymentFigures(payments);
  const company = currencyCode();
  const stated = String(complaint.refundDecision) === 'APPROVED' && compareMoney(money(complaint.refundAmount), 0) > 0 ? money(complaint.refundAmount) : null;
  // What is left to give back is never more than the job still holds (an acceptance that came before any payment).
  const lacking = stated === null ? null : Math.max(subtractMoney(stated, figures.refunded), 0);
  const remaining = lacking === null ? null : compareMoney(lacking, Math.max(figures.kept, 0)) > 0 ? Math.max(figures.kept, 0) : lacking;

  return {
    currency: company,
    received: figures.received,
    refunded: figures.refunded,
    kept: figures.kept,
    accepted: stated,
    remaining,
    payments: payments
      .filter((payment) => RECEIVED_PAYMENT_STATUSES.includes(String(payment.status)) && (!payment.currency || String(payment.currency) === company))
      .map((payment) => ({
        id: payment.id,
        method: String(payment.method),
        status: String(payment.status),
        amount: money(payment.amount),
        refundable: Math.max(subtractMoney(payment.amount, refundedOn(payment)), 0),
        confirmedAt: payment.confirmedAt ?? null,
      }))
      .filter((payment) => compareMoney(payment.refundable, 0) > 0),
    invoice: invoice ? { id: invoice.id, number: String(invoice.invoiceNumber), status: String(invoice.status), toPay: amountToPay(invoice) } : null,
  };
}

const PERSON = { id: true, name: true, email: true, phone: true, role: true } as const;

/**
 * One complaint as the back office reads it: the people, the job, the thread (what the customer and the artisan can read, and the
 * internal messages), the journal the back office writes as it works, and the money.
 */
export async function complaintCase(db: Db, complaintId: number) {
  // A number past the largest id of the database is no complaint (PostgreSQL would refuse it with an error 500, not a 404).
  if (idOf(complaintId) === null) throw new NotFoundException('Réclamation introuvable.');

  const complaint: Row | null = await db.complaint.findUnique({
    where: { id: complaintId },
    include: {
      user: { select: PERSON },
      assignedTo: { select: PERSON },
      intervention: {
        select: {
          id: true,
          serviceType: true,
          status: true,
          urgency: true,
          address: true,
          description: true,
          contactName: true,
          contactPhone: true,
          clientId: true,
          artisanId: true,
          createdAt: true,
          client: { select: PERSON },
          artisan: { select: PERSON },
        },
      },
      messages: { include: { sender: { select: { id: true, name: true, role: true } } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
    },
  });

  if (!complaint) throw new NotFoundException('Réclamation introuvable.');

  const notes: Row[] = await db.adminInternalNote.findMany({
    where: { targetType: 'COMPLAINT', targetId: complaintId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });

  const live = notes.filter((note) => note.deletedAt === null || note.deletedAt === undefined);
  const authorIds = [...new Set(live.map((note) => note.authorId).filter((id): id is number => typeof id === 'number'))];
  const authors: Row[] = authorIds.length ? await db.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, name: true, role: true } }) : [];
  const authorOf = new Map(authors.map((author) => [author.id, author]));

  return {
    ...complaint,
    // A message that was removed is not part of the thread.
    messages: ((complaint.messages ?? []) as Row[]).filter((message) => message.deletedAt === null || message.deletedAt === undefined),
    internalNotes: live.map((note) => ({ ...note, author: note.authorId === null || note.authorId === undefined ? null : (authorOf.get(note.authorId) ?? null) })),
    money: await complaintMoney(db, complaint),
  };
}
