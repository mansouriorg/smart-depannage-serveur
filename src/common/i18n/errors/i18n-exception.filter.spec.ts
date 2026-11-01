import { ArgumentsHost, BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, NotFoundException, UnauthorizedException } from '@nestjs/common';

import { readSource, stripComments } from '../../testing/source-scan';
import { ERRORS_AR } from './errors.ar';
import { I18nExceptionFilter } from './i18n-exception.filter';

/**
 * The filter that gives the sentence of a refusal in the language the app asks for (P3-04), driven with the adapter and the host of Nest
 * written by hand: what goes out is what `httpAdapter.reply` receives.
 */

type Sent = { body: unknown; status: number };

/** A request with the headers an app (or a browser) would send. */
function requestWith(headers: Record<string, string | string[] | undefined> = {}) {
  return { headers };
}

/** The adapter records the one answer; `headersSent` tells it the answer was already started. */
function setup(request: unknown, options: { headersSent?: boolean; type?: string } = {}) {
  const sent: Sent[] = [];
  const ended: unknown[] = [];
  const emitted: unknown[][] = [];
  const response = { id: 'response' };
  const client = { emit: (...args: unknown[]) => emitted.push(args) };
  const adapter = {
    reply: (_response: unknown, body: unknown, status: number) => sent.push({ body, status }),
    isHeadersSent: () => options.headersSent === true,
    end: (reply: unknown) => ended.push(reply),
  };
  const host = {
    getType: () => options.type ?? 'http',
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    switchToWs: () => ({ getClient: () => client }),
  } as unknown as ArgumentsHost;
  const filter = new I18nExceptionFilter({ httpAdapter: adapter } as never);

  return { filter, host, sent, ended, emitted, response };
}

/** The body Nest's own filter would have sent for the exception: the object as it is, or a text wrapped in `{ statusCode, message }`. */
function nestBody(exception: HttpException): unknown {
  const response = exception.getResponse();

  return response !== null && typeof response === 'object' ? response : { statusCode: exception.getStatus(), message: response };
}

const ARABIC = requestWith({ 'x-app-locale': 'ar' });

describe('the filter of the refusals (P3-04)', () => {
  it('gives the sentence in Arabic when the app says "ar", with the status of the exception', () => {
    const { filter, host, sent } = setup(ARABIC);

    filter.catch(new ConflictException('Date invalide.'), host);

    expect(sent.length).toBe(1);
    expect(sent[0].status).toBe(HttpStatus.CONFLICT);
    expect(sent[0].body).toEqual({ ...(nestBody(new ConflictException('Date invalide.')) as object), message: ERRORS_AR['Date invalide.'] });
  });

  it('keeps the shape of the body Nest builds for each kind of exception, and only the text changes', () => {
    const exceptions = [new ConflictException('Date invalide.'), new NotFoundException('Date invalide.'), new ForbiddenException('Date invalide.'), new BadRequestException('Date invalide.')];

    for (const exception of exceptions) {
      const { filter, host, sent } = setup(ARABIC);
      const french = nestBody(exception) as Record<string, unknown>;

      filter.catch(exception, host);

      expect(sent[0].status).toBe(exception.getStatus());
      expect(Object.keys(sent[0].body as object)).toEqual(Object.keys(french));
      expect(sent[0].body).toEqual({ ...french, message: ERRORS_AR['Date invalide.'] });
    }
  });

  it('translates a list of messages one by one and leaves the ones it does not know', () => {
    const { filter, host, sent } = setup(ARABIC);

    // The body Nest builds for `new BadRequestException([...])`, written out.
    filter.catch(new HttpException({ statusCode: 400, message: ['Date invalide.', 'a sentence nobody wrote'], error: 'Bad Request' }, 400), host);

    expect(sent[0].body).toEqual({ statusCode: 400, message: [ERRORS_AR['Date invalide.'], 'a sentence nobody wrote'], error: 'Bad Request' });
  });

  it('translates the issues of a refusal that carries them, and the fields next to them stay', () => {
    const { filter, host, sent } = setup(ARABIC);
    const thrown = new HttpException({ statusCode: 409, message: 'Date invalide.', error: 'Conflict', issues: ['Date invalide.', 'unknown'], retryAfterSeconds: 3 }, 409);

    filter.catch(thrown, host);

    expect(sent[0].body).toEqual({ statusCode: 409, message: ERRORS_AR['Date invalide.'], error: 'Conflict', issues: [ERRORS_AR['Date invalide.'], 'unknown'], retryAfterSeconds: 3 });
  });

  it('puts a value of a sentence with holes in the Arabic, set apart from its text', () => {
    const { filter, host, sent } = setup(ARABIC);
    const french = Object.keys(ERRORS_AR).find((key) => key.includes('{}'));

    expect(french).toBeDefined();

    const sentence = (french as string).split('{}').join('42');

    filter.catch(new ConflictException(sentence), host);

    const message = (sent[0].body as { message: string }).message;

    expect(message).toContain('⁨42⁩');
    expect(message).not.toBe(sentence);
  });

  it('leaves a sentence it does not know as it was written, even in Arabic', () => {
    const { filter, host, sent } = setup(ARABIC);

    filter.catch(new UnauthorizedException('Something no dictionary has'), host);

    expect(sent[0].body).toEqual(nestBody(new UnauthorizedException('Something no dictionary has')));
  });

  it('sends the very body of Nest when there is no header: French, byte for byte', () => {
    const exceptions = [
      new ConflictException('Date invalide.'),
      new HttpException({ statusCode: 400, message: ['Date invalide.', 'Autre.'], error: 'Bad Request' }, 400),
      new HttpException({ statusCode: 409, message: 'Date invalide.', error: 'Conflict', issues: ['Date invalide.'] }, 409),
      new HttpException('Date invalide.', 418),
      new HttpException({ code: 'ANYTHING', detail: 'Date invalide.' }, 422),
    ];

    for (const exception of exceptions) {
      const { filter, host, sent } = setup(requestWith());

      filter.catch(exception, host);

      expect(sent[0].status).toBe(exception.getStatus());
      expect(JSON.stringify(sent[0].body)).toBe(JSON.stringify(nestBody(exception)));
    }
  });

  it('is French as well for "fr", for a language the product does not speak, for an empty header and for a request without headers', () => {
    const requests = [requestWith({ 'x-app-locale': 'fr' }), requestWith({ 'x-app-locale': 'en' }), requestWith({ 'x-app-locale': '' }), requestWith({ 'accept-language': 'ar' }), {}, null, undefined];

    for (const request of requests) {
      const exception = new ConflictException('Date invalide.');
      const { filter, host, sent } = setup(request);

      filter.catch(exception, host);

      expect(JSON.stringify(sent[0].body)).toBe(JSON.stringify(nestBody(exception)));
    }
  });

  it('reads the language from the header only, not from Accept-Language', () => {
    const { filter, host, sent } = setup(requestWith({ 'accept-language': 'ar-TN,ar;q=0.9' }));
    const exception = new ConflictException('Date invalide.');

    filter.catch(exception, host);

    expect((sent[0].body as { message: string }).message).toBe('Date invalide.');
  });

  it('takes "AR" and the first of a repeated header as the app wrote them', () => {
    const upper = setup(requestWith({ 'x-app-locale': 'AR' }));
    const repeated = setup(requestWith({ 'x-app-locale': ['ar', 'fr'] }));

    upper.filter.catch(new ConflictException('Date invalide.'), upper.host);
    repeated.filter.catch(new ConflictException('Date invalide.'), repeated.host);

    expect((upper.sent[0].body as { message: string }).message).toBe(ERRORS_AR['Date invalide.']);
    expect((repeated.sent[0].body as { message: string }).message).toBe(ERRORS_AR['Date invalide.']);
  });

  it('does not touch the exception it was given: the French stays in it', () => {
    const { filter, host } = setup(ARABIC);
    const thrown = { statusCode: 409, message: 'Date invalide.', error: 'Conflict', issues: ['Date invalide.'] };
    const exception = new HttpException(thrown, 409);

    filter.catch(exception, host);

    expect(exception.getResponse()).toEqual({ statusCode: 409, message: 'Date invalide.', error: 'Conflict', issues: ['Date invalide.'] });
    expect(thrown.issues).toEqual(['Date invalide.']);
  });

  it('closes the answer without a second body when the headers are already gone', () => {
    const { filter, host, sent, ended, response } = setup(ARABIC, { headersSent: true });

    filter.catch(new ConflictException('Date invalide.'), host);

    expect(sent).toEqual([]);
    expect(ended).toEqual([response]);
  });

  it('leaves a socket handler the answer Nest gives it, in French or in Arabic', () => {
    const { filter, host, sent, emitted } = setup(ARABIC, { type: 'ws' });

    filter.catch(new ConflictException('Date invalide.'), host);

    expect(sent).toEqual([]);
    expect(emitted).toEqual([['exception', { status: 'error', message: 'Internal server error' }]]);
  });

  it('and reports the error it hides from the socket, as Nest’s own socket filter logs it, so that a global filter does not make it silent', () => {
    const logged: unknown[][] = [];

    class Recording extends I18nExceptionFilter {
      protected report(exception: HttpException): void {
        logged.push([exception]);
      }
    }

    const { host, emitted } = setup(ARABIC, { type: 'ws' });
    const exception = new ConflictException('Date invalide.');

    new Recording({ httpAdapter: {} } as never).catch(exception, host);

    expect(emitted.length).toBe(1);
    expect(logged).toEqual([[exception]]);
  });

  it('the line it writes names the kind of error and never its text', () => {
    const lines: string[] = [];
    const { filter, host } = setup(ARABIC, { type: 'ws' });

    (filter as unknown as { logger: { error: (line: string) => void } }).logger = { error: (line) => lines.push(line) };

    filter.catch(new ConflictException('Date invalide.'), host);

    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('ConflictException');
    expect(lines[0]).not.toContain('Date invalide.');
  });

  it('answers with the French body if the translation itself fails', () => {
    const { filter, host, sent } = setup(ARABIC);
    const exception = new ConflictException('Date invalide.');
    const hostile = Object.defineProperty({ statusCode: 409, message: 'Date invalide.', error: 'Conflict' }, 'issues', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    const broken = new HttpException(hostile, 409);

    filter.catch(exception, host);
    filter.catch(broken, host);

    expect((sent[0].body as { message: string }).message).toBe(ERRORS_AR['Date invalide.']);
    expect(sent[1].body).toBe(hostile);
    expect(sent[1].status).toBe(409);
  });

  it('catches HTTP exceptions only (anything else keeps going to Nest\'s own filter), and is registered once, globally', () => {
    const filter = stripComments(readSource('common/i18n/errors/i18n-exception.filter.ts'));
    const module = stripComments(readSource('app.module.ts'));

    expect(filter.match(/@Catch\(([^)]*)\)/g)).toEqual(['@Catch(HttpException)']);
    expect(module.match(/provide:\s*APP_FILTER/g)?.length).toBe(1);
    expect(module).toContain('{ provide: APP_FILTER, useClass: I18nExceptionFilter }');
  });
});
