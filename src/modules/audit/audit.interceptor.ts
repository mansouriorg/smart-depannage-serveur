import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor, ServiceUnavailableException } from '@nestjs/common';
import { Observable, from, throwError } from 'rxjs';
import { catchError, defaultIfEmpty, mergeMap } from 'rxjs/operators';

import { Role } from '../../../generated/prisma/client';
import { isBackOffice } from '../../common/auth/role-policy';
import { describeError } from '../notifications/delivery/delivery-error';
import { AUDITED_ROUTES, NOT_AUDITED_ROUTES } from './audit-actions';
import { AuditOutcome } from './audit-outcome';
import { WRITE_METHODS, auditRouteKey, canonicalId, changedFieldsOf, detailsOf, idFromResult, statusOfError } from './audit-record';
import { AuditService } from './audit.service';
import { withTimeout } from './with-timeout';

/**
 * Registered globally (see AppModule): every write that a person of the back office makes leaves a row in the audit log (P3-02).
 *
 *  1. Before the action runs, a row is written with the person, the action and the target (outcome STARTED). When that
 *     cannot be done, the action does NOT run and the answer is 503: an action nobody could trace does not happen.
 *  2. When the action has answered, the row is closed: SUCCEEDED, or FAILED with the status of the error. The names of
 *     the fields that were sent and the few values the list of actions allows are written then (the body of an upload
 *     is not read yet when the first row is written).
 *  3. When closing fails (or takes longer than `timeouts.finish`), the action has already happened: the answer is left
 *     alone and the row stays STARTED, like the row of an action that never came back. Writing the first row is given
 *     `timeouts.begin` as well: a database that hangs must not hold every write of the back office open for ever.
 *
 * Not logged: a call that a guard refuses (it never reaches an interceptor), a read, a write by a customer or a technician,
 * a route in `NOT_AUDITED_ROUTES`, and anything on a websocket. A write route missing from the list is still logged, under the
 * action `unlisted` with its route, and `audit-actions.spec.ts` fails for it.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  /** How long the database may take to write the first row and to close it, in milliseconds (a test sets small values). */
  readonly timeouts = { begin: 5000, finish: 5000 };

  constructor(private readonly audit: AuditService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest();
    const method = String(request?.method ?? '').toUpperCase();

    if (!WRITE_METHODS.has(method)) return next.handle();

    const user = request.user as { id?: unknown; role?: Role } | undefined;

    if (!user || typeof user.id !== 'number' || !isBackOffice(user.role)) return next.handle();

    const key = auditRouteKey(method, request.route?.path);

    if (NOT_AUDITED_ROUTES[key] !== undefined) return next.handle();

    const entry = AUDITED_ROUTES[key];
    const targetType = entry ? entry.targetType : null;
    const known = entry?.self ? canonicalId(user.id) : entry?.param ? canonicalId((request.params as Record<string, unknown> | undefined)?.[entry.param]) : null;

    let id: number;

    try {
      id = await withTimeout(
        this.audit.begin({
          actorId: user.id,
          actorRole: user.role as Role,
          action: entry ? entry.action : 'unlisted',
          routeKey: key,
          targetType,
          targetId: known,
        }),
        this.timeouts.begin,
        'writing the first row',
      );
    } catch (error) {
      this.logger.error(`Audit row not written for ${key}: ${describeError(error)}`);
      throw new ServiceUnavailableException("Le journal d'audit est indisponible : l'action n'a pas été exécutée.");
    }

    // What is kept of the request is worked out when the row is closed. None of it may throw: the action has happened by then.
    const record = async (outcome: AuditOutcome, statusCode: number, result: unknown): Promise<void> => {
      let closing: Parameters<AuditService['finish']>[1] = { outcome, statusCode, changedFields: [], details: null };

      try {
        closing = {
          outcome,
          statusCode,
          targetId: known === null && entry?.fromResult ? idFromResult(result, entry.fromResult) : null,
          changedFields: changedFieldsOf(request.body, hasFile(request)),
          details: detailsOf(entry?.details, request.body, request.params),
        };
      } catch (error) {
        this.logger.error(`Audit row ${id}: what the request carried could not be read: ${describeError(error)}`);
      }

      await this.close(id, closing);
    };

    // A row is closed once, by the first answer or the first error; whatever comes after it (a second value, an error after a value) is not recorded.
    let closed: Promise<void> | null = null;
    const closeOnce = (outcome: AuditOutcome, statusCode: number, result: unknown): Promise<void> => {
      if (closed === null) closed = record(outcome, statusCode, result);

      return closed;
    };

    return next.handle().pipe(
      // A handler that completes without a value is a success too.
      defaultIfEmpty(undefined),
      mergeMap(async (result) => {
        await closeOnce(AuditOutcome.SUCCEEDED, statusOfAnswer(context, method), result);

        return result;
      }),
      catchError((error) => from(closeOnce(AuditOutcome.FAILED, statusOfError(error), null)).pipe(mergeMap(() => throwError(() => error)))),
    );
  }

  /** Never throws: the action has been done, and an error here must not turn it into a failure for the person who made it. */
  private async close(id: number, result: Parameters<AuditService['finish']>[1]): Promise<void> {
    try {
      await withTimeout(this.audit.finish(id, result), this.timeouts.finish, 'closing the row');
    } catch (error) {
      this.logger.error(`Audit row ${id} left open: ${describeError(error)}`);
    }
  }
}

function hasFile(request: { file?: unknown; files?: unknown }): boolean {
  return Boolean(request.file) || (Array.isArray(request.files) ? request.files.length > 0 : Boolean(request.files));
}

/**
 * The status of the answer: Nest has already put it on the response when the interceptors run (`@HttpCode`, else 201 for a
 * POST and 200 for the others), so it is read there, the way the person receives it. Nest's defaults when it is not a status.
 */
function statusOfAnswer(context: ExecutionContext, method: string): number {
  try {
    const status = (context.switchToHttp().getResponse() as { statusCode?: unknown } | undefined)?.statusCode;

    if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) return status;
  } catch {
    // no response to read: Nest's defaults below (the row must still be closed)
  }

  return method === 'POST' ? 201 : 200;
}
