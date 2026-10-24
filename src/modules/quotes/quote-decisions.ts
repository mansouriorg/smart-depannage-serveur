/**
 * What a customer does with a quote that was sent (P2-04): accept it, refuse it, ask for a change, ask a question.
 *
 * The customer who is signed in and the visitor with the tracking link follow the same rules, so they are written once, here, as
 * functions of a database client that run inside the transaction of the caller. The caller tells the people afterwards (the
 * timeline, the notices) and answers with the view its reader is allowed.
 *
 *  - A question does not change the quote at all (it stays SENT, and can be accepted). A request for a change moves it to
 *    MODIFICATION_REQUESTED: the artisan is to edit it and send it again, and until then it cannot be accepted (the customer
 *    would be accepting a quote that is being rewritten); it can still be refused, and the customer can still ask or ask again.
 *  - A draft is not the customer's: answering it is a 404, like reading it.
 *  - Nothing is answered on a job that is cancelled, in dispute or done: the quote is not what the job is about any more.
 *  - The quote is read again under the lock of its job, so that an edit, a cancellation or another answer that is being made at
 *    the same moment is seen: only one of them wins, and the others are told what the quote is now.
 *  - A customer can say which revision they read; if the quote was edited since, the answer is refused (409) and they are asked
 *    to read it again. A caller that does not send a revision answers for the quote as it is.
 */
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

import { MessageAudience, QuoteStatus, Status } from '../../../generated/prisma/client';
import { lockJob } from '../assignment/artisan-lock';
import { CanonicalStatus, canonicalStatus } from '../intervention-workflow/intervention-status';
import { transitionStatus } from '../intervention-workflow/transition-status';
import { revisionOf } from './quote-revisions';

type Db = any;
type Row = Record<string, any>;

/** The statuses of a quote that can be refused, asked about or asked to be changed: SENT, and MODIFICATION_REQUESTED (waiting for the artisan). */
export const ANSWERABLE_QUOTE_STATUSES: QuoteStatus[] = [QuoteStatus.SENT, QuoteStatus.MODIFICATION_REQUESTED];

/** The statuses of a quote that can be accepted: only the one the customer has been sent. */
export const ACCEPTABLE_QUOTE_STATUSES: QuoteStatus[] = [QuoteStatus.SENT];

/** The jobs on which a quote is no longer answered: cancelled, in dispute, done, or waiting to be paid. */
export const JOB_STATUSES_CLOSED_TO_QUOTES: CanonicalStatus[] = ['CANCELLED', 'DISPUTED', 'COMPLETED', 'PAYMENT_PENDING', 'PAID', 'INVOICE_SENT'];

export const QUOTE_WAS_EDITED = 'Ce devis a été modifié depuis que vous l’avez consulté: relisez-le avant de répondre.';
export const QUOTE_BEING_MODIFIED = 'L’artisan est en train de modifier ce devis: vous pourrez l’accepter dès qu’il vous sera renvoyé.';
export const JOB_CLOSED_TO_QUOTES_WORDS = 'Cette mission n’accepte plus de réponse sur ses devis.';
export const JOB_CHANGED_WORDS = 'La mission vient de changer: relisez le devis avant de répondre.';

export interface QuoteAnswer {
  /** The revision of the quote that the customer read, when they say so. */
  revision?: number;
  /** What the customer wrote. */
  note?: string;
  /** What is answered when the quote is no longer waiting for an answer. */
  refusal: string;
  /** What the answer returns of the quote (relations to read back). */
  include?: Row;
}

/** Takes the lock of the job and reads the quote again under it. */
export async function readQuoteLocked(tx: Db, quoteId: number, interventionId: number, include?: Row): Promise<Row> {
  await lockJob(tx, interventionId);

  const current: Row | null = await tx.quote.findUnique({ where: { id: quoteId }, ...(include ? { include } : {}) });

  if (!current || current.interventionId !== interventionId) throw new NotFoundException('Devis introuvable.');

  return current;
}

function ensureAnswerable(quote: Row, refusal: string, toAccept = false): void {
  // A draft is not the customer's: it does not exist for them.
  if (quote.status === QuoteStatus.DRAFT) throw new NotFoundException('Devis introuvable.');

  if ((toAccept ? ACCEPTABLE_QUOTE_STATUSES : ANSWERABLE_QUOTE_STATUSES).includes(quote.status)) return;

  throw new BadRequestException(toAccept && quote.status === QuoteStatus.MODIFICATION_REQUESTED ? QUOTE_BEING_MODIFIED : refusal);
}

/** The job is read under the lock too: a quote of a job that was cancelled (or is done) is not answered. */
async function ensureJobOpen(tx: Db, interventionId: number): Promise<void> {
  const job: Row | null = await tx.intervention.findUnique({ where: { id: interventionId }, select: { status: true } });

  if (!job) throw new NotFoundException('Devis introuvable.');

  const status = canonicalStatus(job.status);

  if (status && JOB_STATUSES_CLOSED_TO_QUOTES.includes(status)) throw new BadRequestException(JOB_CLOSED_TO_QUOTES_WORDS);

  // The cancellation of a job and the moves to the closed statuses do not take the lock of the job: they write the row, only if its
  // status is still the one they read. So the row is held here the same way: written only if the status is still the one read.
  // If a cancellation got in first this finds it (409); if this goes first, the cancellation waits for the end of this answer and
  // then finds the status changed (its own 409), or goes on after an answer that did not move the job.
  const held = await tx.intervention.updateMany({ where: { id: interventionId, status: job.status }, data: { updatedAt: new Date() } });

  if (held.count !== 1) throw new ConflictException(JOB_CHANGED_WORDS);
}

function ensureNotExpired(quote: Row): void {
  if (quote.expiresAt && new Date(quote.expiresAt) < new Date()) throw new BadRequestException('Ce devis a expiré.');
}

function ensureRevisionRead(quote: Row, read: number | undefined): void {
  if (read !== undefined && read !== null && Number(read) !== revisionOf(quote)) throw new ConflictException(QUOTE_WAS_EDITED);
}

/** The customer accepts the quote: the others of the job that were still open are cancelled, and the job moves on if it waits for it. */
export async function acceptQuote(tx: Db, quoteId: number, interventionId: number, by: QuoteAnswer & { clientId: number }): Promise<Row> {
  const quote = await readQuoteLocked(tx, quoteId, interventionId);

  ensureAnswerable(quote, by.refusal, true);
  ensureNotExpired(quote);
  await ensureJobOpen(tx, interventionId);
  ensureRevisionRead(quote, by.revision);

  await tx.quote.updateMany({
    where: {
      interventionId,
      id: { not: quoteId },
      status: { in: [QuoteStatus.DRAFT, QuoteStatus.SENT, QuoteStatus.MODIFICATION_REQUESTED] },
    },
    data: { status: QuoteStatus.CANCELLED, cancelledAt: new Date() },
  });

  const accepted: Row = await tx.quote.update({
    where: { id: quoteId },
    // The note of the acceptance replaces an earlier question or request: that one is on the timeline and in the messages.
    data: { status: QuoteStatus.ACCEPTED, clientNote: by.note ?? null, acceptedAt: new Date() },
    ...(by.include ? { include: by.include } : {}),
  });

  // The job moves on if it is waiting for the quote; if it is somewhere else (already assigned, say) its status is left alone.
  await transitionStatus(tx, {
    id: interventionId,
    to: Status.QUOTE_ACCEPTED,
    actor: { kind: 'client', userId: by.clientId },
    data: { quoteAcceptedAt: new Date() },
    soft: true,
  });

  return accepted;
}

/** The customer refuses the quote. */
export async function rejectQuote(tx: Db, quoteId: number, interventionId: number, by: QuoteAnswer): Promise<Row> {
  const quote = await readQuoteLocked(tx, quoteId, interventionId);

  ensureAnswerable(quote, by.refusal);
  await ensureJobOpen(tx, interventionId);
  ensureRevisionRead(quote, by.revision);

  return tx.quote.update({
    where: { id: quoteId },
    data: { status: QuoteStatus.REJECTED, clientNote: by.note ?? null, rejectedAt: new Date() },
    ...(by.include ? { include: by.include } : {}),
  });
}

/** The customer asks for the quote to be changed: it waits for the artisan to edit it and send it again. */
export async function requestChange(tx: Db, quoteId: number, interventionId: number, by: QuoteAnswer): Promise<Row> {
  const quote = await readQuoteLocked(tx, quoteId, interventionId);

  ensureAnswerable(quote, by.refusal);
  await ensureJobOpen(tx, interventionId);
  ensureRevisionRead(quote, by.revision);

  // A second request that carries no words (a double tap, a retry) keeps the first one: it is what the artisan has to act on.
  const note = by.note || (quote.status === QuoteStatus.MODIFICATION_REQUESTED ? quote.clientNote ?? null : null);

  return tx.quote.update({
    where: { id: quoteId },
    data: { status: QuoteStatus.MODIFICATION_REQUESTED, clientNote: note },
    ...(by.include ? { include: by.include } : {}),
  });
}

/** The customer asks a question: the quote stays as it is (a quote that waits for a change keeps waiting), and can still be accepted. */
export async function askAboutQuote(tx: Db, quoteId: number, interventionId: number, by: QuoteAnswer): Promise<Row> {
  const quote = await readQuoteLocked(tx, quoteId, interventionId);

  ensureAnswerable(quote, by.refusal);
  await ensureJobOpen(tx, interventionId);

  // Only the note is written. A note that is not sent leaves the earlier one, and so does a quote that waits for a change: the
  // note it holds is the request that the artisan has to act on (the question is on the messages and on the timeline).
  const keeps = !by.note || quote.status === QuoteStatus.MODIFICATION_REQUESTED;

  return tx.quote.update({
    where: { id: quoteId },
    data: keeps ? {} : { clientNote: by.note },
    ...(by.include ? { include: by.include } : {}),
  });
}

/** What the customer wrote to the support about a quote, kept as a message in the thread of the job. Call it in the same transaction. */
export async function tellSupport(tx: Db, about: { interventionId: number; quoteId: number; senderId: number; note?: string | null; change: boolean }): Promise<void> {
  await tx.message.create({
    data: {
      interventionId: about.interventionId,
      senderId: about.senderId,
      audience: MessageAudience.CLIENT_SUPPORT,
      content: `${about.change ? 'Question / demande sur le devis' : 'Question sur le devis'} #${about.quoteId}: ${about.note || 'Le client demande des précisions sur le devis.'}`,
      attachments: [],
    },
  });
}

/** A request for a change, and what the customer wrote kept as a message for the support, in the same transaction. */
export async function requestChangeAndTell(tx: Db, quoteId: number, interventionId: number, by: QuoteAnswer & { senderId: number }): Promise<Row> {
  const changed = await requestChange(tx, quoteId, interventionId, by);

  await tellSupport(tx, { interventionId, quoteId, senderId: by.senderId, note: by.note, change: true });

  return changed;
}

/** A question, and what the customer wrote kept as a message for the support, in the same transaction. */
export async function askAndTell(tx: Db, quoteId: number, interventionId: number, by: QuoteAnswer & { senderId: number }): Promise<Row> {
  const asked = await askAboutQuote(tx, quoteId, interventionId, by);

  await tellSupport(tx, { interventionId, quoteId, senderId: by.senderId, note: by.note, change: false });

  return asked;
}
