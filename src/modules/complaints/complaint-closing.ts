import { ConflictException } from '@nestjs/common';

import { ComplaintRefundDecision, ComplaintStatus, Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Closing a complaint (P2-09): not while the refund the customer asked for waits for an answer. The payout of the artisan is held
 * for such a refund, and a closed complaint offers no way to decide it, so the payout would stay held for ever.
 *
 * Every route that can end a complaint goes through here: the ones of the complaints module and the older ones of the admin module.
 */

/** What a closing is refused with while the refund the customer asked for has no answer. */
export const REFUND_NOT_ANSWERED = 'Le client a demandé un remboursement : décidez-en d’abord (accepter ou refuser), puis clôturez la réclamation.';

/** The statuses that end a complaint (they set its closing date). */
export const CLOSING_STATUSES: readonly ComplaintStatus[] = [ComplaintStatus.REJECTED, ComplaintStatus.RESOLVED, ComplaintStatus.REFUNDED];

export const endsComplaint = (status: unknown): boolean => CLOSING_STATUSES.includes(status as ComplaintStatus);

/**
 * Writes a closing only if the refund has no question on it at the moment of the write, and answers 409 otherwise. The check and the
 * write are one statement, so a decision of the team that asks for a refund at the same moment cannot be overwritten. The caller has
 * read the complaint before (a complaint that does not exist is a 404 there, not a 409 here).
 */
export async function closeComplaintIfRefundAnswered(prisma: PrismaService, complaintId: number, data: Prisma.ComplaintUpdateManyMutationInput): Promise<void> {
  const claimed = await prisma.complaint.updateMany({
    where: { id: complaintId, refundDecision: { not: ComplaintRefundDecision.PENDING } },
    data,
  });

  if (claimed.count !== 1) {
    throw new ConflictException(REFUND_NOT_ANSWERED);
  }
}
