import { BadRequestException } from '@nestjs/common';

import { AUDIT_OUTCOMES, isAuditOutcome } from './audit-outcome';
import { canonicalId } from './audit-record';
import type { AuditOutcome } from './audit-outcome';
import type { AuditFilter } from './audit.service';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

function one(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new BadRequestException(`Le paramètre « ${name} » doit être un texte unique.`);

  return value.trim() || undefined;
}

function whole(value: unknown, name: string, min: number, max: number): number | undefined {
  const text = one(value, name);

  if (text === undefined) return undefined;
  if (!/^\d{1,9}$/.test(text)) throw new BadRequestException(`Le paramètre « ${name} » doit être un nombre entier.`);

  const number = Number(text);

  if (number < min || number > max) throw new BadRequestException(`Le paramètre « ${name} » doit être compris entre ${min} et ${max}.`);

  return number;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Is that year-month-day a real day (no 31 February)? */
function isRealDay(year: number, month: number, day: number): boolean {
  const check = new Date(Date.UTC(year, month - 1, day));

  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
}

/**
 * A date as the query writes it: `2026-10-31` (a whole day, UTC: the start of it for `from`, its last millisecond for `to`, so that
 * `to=2026-10-31` includes the 31st), or a date and time WITH its zone (`2026-10-31T10:00:00Z`, `2026-10-31T10:00:00+01:00`).
 * A time without a zone, a day that does not exist and a time of day that does not exist are refused.
 */
function day(value: unknown, name: string, end: boolean): Date | undefined {
  const text = one(value, name);

  if (text === undefined) return undefined;

  const refused = new BadRequestException(`Le paramètre « ${name} » doit être une date réelle (2026-10-31) ou une date avec heure et fuseau (2026-10-31T10:00:00Z).`);
  const dateOnly = DATE_ONLY.exec(text);

  if (dateOnly) {
    const [year, month, dayOfMonth] = [Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3])];

    if (!isRealDay(year, month, dayOfMonth)) throw refused;

    return new Date(Date.UTC(year, month - 1, dayOfMonth, end ? 23 : 0, end ? 59 : 0, end ? 59 : 0, end ? 999 : 0));
  }

  const dateTime = DATE_TIME.exec(text);

  if (!dateTime || !isRealDay(Number(dateTime[1]), Number(dateTime[2]), Number(dateTime[3])) || Number(dateTime[4]) > 23 || Number(dateTime[5]) > 59 || Number(dateTime[6] ?? 0) > 59) throw refused;

  const date = new Date(text);

  if (Number.isNaN(date.getTime())) throw refused;

  return date;
}

/** The names the query may carry; any other is refused, so that a misspelt filter does not silently return everything. */
const QUERY_NAMES: ReadonlySet<string> = new Set(['actorId', 'action', 'targetType', 'targetId', 'outcome', 'from', 'to', 'before', 'limit']);

/**
 * Reads the query string of `GET /admin/audit-log`: actorId, action, targetType, targetId, outcome, from, to, before, limit.
 * Written by hand so the rules are tested without the validation pipe. A value that is wrong is refused (400), not ignored.
 */
export function parseAuditQuery(query: Record<string, unknown> | undefined): AuditFilter {
  const raw = query ?? {};

  for (const name of Object.keys(raw)) {
    if (!QUERY_NAMES.has(name)) throw new BadRequestException(`Le paramètre « ${name.slice(0, 40)} » n'existe pas. Paramètres possibles : ${[...QUERY_NAMES].join(', ')}.`);
  }

  const outcome = one(raw.outcome, 'outcome');
  const action = one(raw.action, 'action');
  const targetType = one(raw.targetType, 'targetType');
  const targetId = one(raw.targetId, 'targetId');

  if (outcome !== undefined && !isAuditOutcome(outcome)) {
    throw new BadRequestException(`Le paramètre « outcome » doit être l'une de ces valeurs : ${AUDIT_OUTCOMES.join(', ')}.`);
  }

  if (action !== undefined && !/^[a-z][a-z0-9-]*(\.([a-z0-9-]+)?)?$/.test(action)) {
    throw new BadRequestException('Le paramètre « action » doit être un nom d\'action (payments.refund) ou un domaine (payments.).');
  }

  for (const [name, value] of [['targetType', targetType], ['targetId', targetId]] as const) {
    if (value !== undefined && (value.length > 64 || !/^[A-Za-z0-9_.-]+$/.test(value))) {
      throw new BadRequestException(`Le paramètre « ${name} » n'est pas valide.`);
    }
  }

  const from = day(raw.from, 'from', false);
  const to = day(raw.to, 'to', true);

  if (from && to && from.getTime() > to.getTime()) throw new BadRequestException('Le paramètre « from » doit précéder « to ».');

  return {
    actorId: whole(raw.actorId, 'actorId', 1, 2_000_000_000),
    action,
    targetType,
    // the ids in the log are written without leading zeros
    targetId: targetId === undefined ? undefined : (canonicalId(targetId) ?? targetId),
    outcome: outcome as AuditOutcome | undefined,
    from,
    to,
    before: whole(raw.before, 'before', 1, 2_000_000_000),
    limit: whole(raw.limit, 'limit', 1, MAX_PAGE_SIZE) ?? DEFAULT_PAGE_SIZE,
  };
}
