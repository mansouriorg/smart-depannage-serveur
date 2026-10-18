import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import { isBackOffice } from '../auth/role-policy';
import { stripStaffFields } from './strip-staff-fields';

/**
 * Registered globally (see AppModule). Back-office users get responses as they
 * are; everybody else (clients, artisans, visitors with a tracking link) gets
 * them without the staff-only columns and without the other party's e-mail.
 */
@Injectable()
export class StripStaffFieldsInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest();

    if (isBackOffice(request?.user?.role)) {
      return next.handle();
    }

    const viewer = { userId: request?.user?.id ?? null, role: request?.user?.role ?? null };

    return next.handle().pipe(map((body) => stripStaffFields(body, viewer)));
  }
}
