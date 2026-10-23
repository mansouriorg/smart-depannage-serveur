import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import { decimalsToNumbers } from './money-numbers';

/** Registered globally (see AppModule): the amounts of every answer are numbers, never Decimal objects that JSON writes as texts. */
@Injectable()
export class MoneyNumbersInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    return next.handle().pipe(map((body) => decimalsToNumbers(body)));
  }
}
