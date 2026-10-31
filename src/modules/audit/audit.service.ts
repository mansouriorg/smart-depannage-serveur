import { Injectable } from '@nestjs/common';

import { Prisma, Role } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditOutcome } from './audit-outcome';
import type { DetailValue } from './audit-record';

export interface BeginAudit {
  actorId: number;
  actorRole: Role;
  action: string;
  routeKey: string;
  targetType: string | null;
  targetId: string | null;
}

export interface FinishAudit {
  outcome: AuditOutcome;
  statusCode: number;
  /** Only set when the answer taught something the request did not say (the id of what was created). */
  targetId?: string | null;
  changedFields: string[];
  details: Record<string, DetailValue> | null;
}

export interface AuditFilter {
  actorId?: number;
  /** An exact name (`payments.refund`) or an area (`payments.`). */
  action?: string;
  targetType?: string;
  targetId?: string;
  outcome?: AuditOutcome;
  from?: Date;
  to?: Date;
  /** Rows older than this id only: the cursor of the previous page. */
  before?: number;
  limit: number;
}

/** The audit log (P3-02): rows are written before the action and closed after it; a closed row is never changed again. */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Writes the row of an action that is about to run. Throws when it cannot: the caller does not run the action then. */
  async begin(entry: BeginAudit): Promise<number> {
    const row = await this.prisma.auditLog.create({
      data: {
        actorId: entry.actorId,
        actorRole: entry.actorRole,
        action: entry.action,
        routeKey: entry.routeKey,
        targetType: entry.targetType,
        targetId: entry.targetId,
        outcome: AuditOutcome.STARTED,
        // the same clock as `finishedAt` (the database's own `now()` could be a little behind or ahead of the server's)
        createdAt: new Date(),
      },
      select: { id: true },
    });

    return row.id;
  }

  /** Closes a row that is still STARTED. Returns false when it was not (already closed, or gone): nothing is rewritten. */
  async finish(id: number, result: FinishAudit): Promise<boolean> {
    const done = await this.prisma.auditLog.updateMany({
      where: { id, outcome: AuditOutcome.STARTED },
      data: {
        outcome: result.outcome,
        statusCode: result.statusCode,
        changedFields: result.changedFields,
        ...(result.details ? { details: result.details as Prisma.InputJsonValue } : {}),
        finishedAt: new Date(),
        ...(result.targetId ? { targetId: result.targetId } : {}),
      },
    });

    return done.count === 1;
  }

  /** A page of the log, newest first, with who did each action as the accounts are today (null when the account is gone). */
  async list(filter: AuditFilter) {
    const where: Prisma.AuditLogWhereInput = {};

    if (filter.actorId !== undefined) where.actorId = filter.actorId;
    if (filter.action) where.action = filter.action.endsWith('.') ? { startsWith: filter.action } : filter.action;
    if (filter.targetType) where.targetType = filter.targetType;
    if (filter.targetId) where.targetId = filter.targetId;
    if (filter.outcome) where.outcome = filter.outcome;
    if (filter.from || filter.to) where.createdAt = { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) };
    if (filter.before !== undefined) where.id = { lt: filter.before };

    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: { id: 'desc' },
      take: filter.limit + 1,
    });

    const page = rows.slice(0, filter.limit);
    const actorIds = [...new Set(page.map((row) => row.actorId))];
    const actors: Array<{ id: number; name: string | null; role: Role }> = actorIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, role: true } })
      : [];
    const byId = new Map(actors.map((actor) => [actor.id, actor]));

    return {
      items: page.map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        finishedAt: row.finishedAt,
        action: row.action,
        routeKey: row.routeKey,
        outcome: row.outcome,
        statusCode: row.statusCode,
        actor: { id: row.actorId, role: row.actorRole, name: byId.get(row.actorId)?.name ?? null },
        target: row.targetType ? { type: row.targetType, id: row.targetId } : null,
        changedFields: row.changedFields,
        details: row.details,
      })),
      /** Pass it as `before` to read the next page; null at the end. */
      nextBefore: rows.length > filter.limit ? page[page.length - 1].id : null,
    };
  }
}
