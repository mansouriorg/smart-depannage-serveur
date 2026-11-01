import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

import { describeError } from '../../../modules/notifications/delivery/delivery-error';
import { requestLocale } from '../request-locale';
import { translateErrorResponse } from './error-text';

/**
 * The sentence the server gives for a refused request, in the language the app shows (P3-04).
 *
 * The services write their refusals in French (`throw new ConflictException('...')`). When the request carries
 * `X-App-Locale: ar`, the sentences of the body (`message`, a string or a list, and `issues`) are given in Arabic from the
 * dictionary; a sentence it does not know stays as it was written. A request without the header, or with another language, gets
 * the body Nest would have sent: this filter replaces the default one for HTTP exceptions and answers the way it does
 * (`BaseExceptionFilter`): the object that was thrown as it is, a text wrapped as `{ statusCode, message }`, the same status.
 *
 * Only the header decides. `Accept-Language` is not read: the dashboard is opened in browsers of any language and stays French.
 */
@Catch(HttpException)
export class I18nExceptionFilter implements ExceptionFilter<HttpException> {
  private readonly logger = new Logger(I18nExceptionFilter.name);

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: HttpException, host: ArgumentsHost): void {
    // A socket handler that let an HTTP exception through: what Nest's own socket filter does with an error it does not know
    // (it tells the client "Internal server error" and logs the error), so that a global filter does not make it silent.
    if (host.getType() === 'ws') {
      host.switchToWs().getClient()?.emit?.('exception', { status: 'error', message: 'Internal server error' });
      this.report(exception);
      return;
    }

    const { httpAdapter } = this.httpAdapterHost;
    const http = host.switchToHttp();
    const status = exception.getStatus();
    const thrown = exception.getResponse();
    const body = requestLocale(http.getRequest()) === 'ar' ? this.inArabic(thrown) : thrown;
    const answer = body !== null && typeof body === 'object' ? body : { statusCode: status, message: body };
    const response = http.getResponse();

    if (!httpAdapter.isHeadersSent(response)) httpAdapter.reply(response, answer, status);
    else httpAdapter.end(response);
  }

  /** Overridden by the tests. The line says what kind of error it was, never its text (the rule of the logs of the project). */
  protected report(exception: HttpException): void {
    this.logger.error(`A socket handler threw an HTTP exception (${describeError(exception)})`);
  }

  /** A refusal must never become a 500 because a sentence could not be translated: on any error the French body goes out. */
  private inArabic(thrown: string | object): string | object {
    try {
      return translateErrorResponse(thrown) as string | object;
    } catch {
      return thrown;
    }
  }
}
