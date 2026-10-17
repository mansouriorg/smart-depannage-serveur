import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import {
  StatusActor,
  STATUSES_NEEDING_ARTISAN,
  canonicalStatus,
  checkTransition,
  storageStatus,
} from './intervention-status';

/**
 * The only function that writes `Intervention.status` (P1-01).
 *
 * Works with the normal Prisma client and with the `tx` of a transaction, so a
 * service can change the status in the same transaction as its other writes.
 * It only uses `intervention.findUnique` and `intervention.update`.
 */
export type StatusDb = object;

export type TransitionParams = {
  id: number;
  /** Any spelling; what is stored follows `storageStatus()`. */
  to: string;
  actor: StatusActor;
  /** Other columns to write in the same UPDATE (artisanId, cancelledReason...). Never `status`. */
  data?: Record<string, unknown>;
  /** Columns written only when the status really changes (the "assignedAt" kind of timestamp). */
  dataOnChange?: Record<string, unknown>;
  /** Extra conditions the row must still satisfy at the moment of the UPDATE. */
  where?: Record<string, unknown>;
  /** Narrower than the transition table: only accept the move from these statuses. */
  allowedFrom?: readonly string[];
  include?: unknown;
  select?: unknown;
  /**
   * Side effects of a payment, an invoice or a quote must not fail because the
   * job is in an unexpected status. With `soft`, a move that is not allowed is
   * skipped (and logged) instead of throwing, and `data` is still written:
   * only the status (and `dataOnChange`) is best effort.
   */
  soft?: boolean;
  /** Message of the 409 returned when someone else changed the row first. */
  conflictMessage?: string;
};

export type TransitionResult = {
  row: any;
  previousStatus: string;
  /** false when the status was already the requested one, or the move was skipped */
  changed: boolean;
  skipped?: string;
};

const logger = new Logger('InterventionStatus');

function isRecordNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2025'
  );
}

/** Does the row end up with an artisan once `data` is applied? */
function willHaveArtisan(
  current: { artisanId?: number | null },
  data: Record<string, unknown> | undefined,
): boolean {
  if (data && 'artisanId' in data) {
    return data.artisanId !== null && data.artisanId !== undefined;
  }

  return current.artisanId !== null && current.artisanId !== undefined;
}

export async function transitionStatusDetailed(
  db: StatusDb,
  params: TransitionParams,
): Promise<TransitionResult> {
  const { id, to, actor, data, where, include, select } = params;

  if ((data && 'status' in data) || (params.dataOnChange && 'status' in params.dataOnChange)) {
    throw new Error('transitionStatus: pass the new status in `to`, not in `data`.');
  }

  const table = (db as { intervention: any }).intervention;

  const current = await table.findUnique({
    where: { id },
    select: { status: true, artisanId: true },
  });

  if (!current) {
    throw new NotFoundException('Intervention introuvable.');
  }

  const previousStatus = String(current.status);

  /**
   * A move that cannot be done: throws, or in `soft` mode logs and goes on.
   * In soft mode the status is best effort, nothing else is: `data` is still
   * written (the quote was sent, the payment was confirmed, whatever the job
   * status is), only the status and `dataOnChange` are left out.
   */
  const refuse = async (error: Error, reason: string): Promise<TransitionResult> => {
    if (!params.soft) throw error;

    logger.warn(
      `Intervention #${id}: status change to ${to} skipped (${reason}); status stays ${previousStatus}.`,
    );

    let row: any = null;

    if (data && Object.keys(data).length > 0) {
      try {
        row = await table.update({
          where: { id, ...(where ?? {}) },
          data: { ...data },
          include,
          select,
        });
      } catch (writeError) {
        if (!isRecordNotFound(writeError)) throw writeError;
      }
    }

    row ??= await table.findUnique({ where: { id }, include, select });

    return { row, previousStatus, changed: false, skipped: reason };
  };

  const verdict = checkTransition(previousStatus, to, actor.kind);

  if (verdict.ok === false) {
    const error =
      verdict.reason === 'wrong_actor'
        ? new ForbiddenException(verdict.message)
        : verdict.reason === 'unknown_status'
          ? new BadRequestException(verdict.message)
          : new ConflictException(verdict.message);

    return refuse(error, verdict.reason);
  }

  if (params.allowedFrom?.length) {
    const allowed = params.allowedFrom.map((status) => canonicalStatus(status));
    const now = canonicalStatus(previousStatus);

    if (!now || !allowed.includes(now)) {
      return refuse(
        new ConflictException(
          params.conflictMessage ??
            `Cette action n’est plus possible: la demande est en statut ${previousStatus}.`,
        ),
        'not_allowed_from_here',
      );
    }
  }

  const target = canonicalStatus(to);

  if (
    !verdict.same &&
    target &&
    STATUSES_NEEDING_ARTISAN.includes(target) &&
    !willHaveArtisan(current, data)
  ) {
    return refuse(
      new BadRequestException('Assignez d’abord un artisan à cette demande.'),
      'no_artisan',
    );
  }

  // An artisan only ever changes THEIR job. The services check it before, but
  // the job can be handed to someone else between that check and this UPDATE,
  // so the owner is part of the compare-and-set too (unless the caller brings
  // its own condition, like "take an open job").
  const ownerCondition =
    actor.kind === 'artisan' && actor.userId !== undefined && !where
      ? { artisanId: actor.userId }
      : {};

  const hasOtherData = !!data && Object.keys(data).length > 0;

  // Nothing to change: same status and no other column.
  if (verdict.same && !hasOtherData) {
    const row = await table.findUnique({ where: { id }, include, select });
    return { row, previousStatus, changed: false };
  }

  const nextData: Record<string, unknown> = { ...(data ?? {}) };

  if (!verdict.same) {
    Object.assign(nextData, params.dataOnChange ?? {});
    nextData.status = storageStatus(to);
    nextData.lastStatusChangedAt = new Date();
  }

  try {
    const row = await table.update({
      // The status in the WHERE is the compare-and-set: if another request
      // moved the job after we read it, no row matches and nothing is written.
      where: { id, status: current.status, ...ownerCondition, ...(where ?? {}) },
      data: nextData,
      include,
      select,
    });

    return { row, previousStatus, changed: !verdict.same };
  } catch (error) {
    if (!isRecordNotFound(error)) throw error;

    return refuse(
      new ConflictException(
        params.conflictMessage ??
          'Cette demande vient d’être modifiée par quelqu’un d’autre. Actualisez puis réessayez.',
      ),
      'changed_meanwhile',
    );
  }
}

/** Same as `transitionStatusDetailed`, returns only the updated row. */
export async function transitionStatus(
  db: StatusDb,
  params: TransitionParams,
): Promise<any> {
  return (await transitionStatusDetailed(db, params)).row;
}
