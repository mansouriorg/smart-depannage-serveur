import { balancedArguments, scanController, ScannedRoute, splitArguments, routeKey } from './route-roles';

/**
 * Calls a controller method the way the router would, from the route's own text (P1-17).
 *
 * A wrong-user spec says "this person calls `GET /messages/:messageId` with these parameters" and does not
 * name the method. This reads the method that carries the route, its parameter decorators, and builds the
 * argument list from the request the spec describes: `@CurrentUser('id')` takes the caller's id,
 * `@Param('x', ParseIntPipe)` takes the parameter and turns it into a whole number (or answers 400, as the
 * pipe does), `@Body()` the body, `@Query('x')` the query. So a controller that hands the wrong thing to its
 * service (the id of the body instead of the id of the caller) is exercised by the route and not bypassed by
 * a hand-written call, and a spec cannot call a method that is not the one behind the route.
 *
 * It does not guess: a parameter decorator it does not know, or a pipe it does not know, throws.
 */

export interface FakeRequest {
  user?: { id: number; userId?: number; email?: string; name?: string | null; role: string } | null;
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  file?: unknown;
  files?: unknown;
  ip?: string;
  headers?: Record<string, string>;
}

export interface HandlerParameter {
  decorator: string;
  args: string[];
}

export interface Handler {
  name: string;
  parameters: HandlerParameter[];
}

/** What a response object of Express records, for the routes that answer through `@Res()`. */
export class FakeResponse {
  statusCode = 200;
  headers: Record<string, unknown> = {};
  body: unknown = undefined;

  status(code: number) {
    this.statusCode = code;

    return this;
  }

  setHeader(name: string, value: unknown) {
    this.headers[name.toLowerCase()] = value;

    return this;
  }

  set(name: string | Record<string, unknown>, value?: unknown) {
    if (typeof name === 'string') this.setHeader(name, value);
    else for (const [key, entry] of Object.entries(name)) this.setHeader(key, entry);

    return this;
  }

  header(name: string, value: unknown) {
    return this.setHeader(name, value);
  }

  type(value: string) {
    return this.setHeader('content-type', value);
  }

  send(value?: unknown) {
    this.body = value;

    return this;
  }

  json(value?: unknown) {
    this.body = value;

    return this;
  }

  end(value?: unknown) {
    this.body = value;

    return this;
  }

  sendFile(file: string) {
    this.body = { sentFile: file, headers: { ...this.headers } };

    return this.body;
  }

  download(file: string, name?: string) {
    this.body = { downloaded: file, name, headers: { ...this.headers } };

    return this.body;
  }

  redirect(...args: unknown[]) {
    this.statusCode = 302;
    this.body = args;

    return this;
  }
}

/** Skips the decorators at the start of a class member and says where its name begins. */
function afterDecorators(member: string): number {
  let at = 0;

  for (;;) {
    while (/\s/.test(member[at] ?? '')) at += 1;

    if (member[at] !== '@') return at;

    at += 1;
    while (/[\w$.]/.test(member[at] ?? '')) at += 1;

    if (member[at] === '(') {
      const inside = balancedArguments(member, at);

      if (inside === null) throw new Error(`a decorator is not closed in: ${member.trim().slice(0, 80)}`);

      at += inside.length + 2;
    }
  }
}

/** The method behind a scanned route and the decorators of its parameters. */
export function handlerOf(route: ScannedRoute): Handler {
  const member = route.source;
  const start = afterDecorators(member);
  const head = /^(?:(?:public|private|protected|async|static)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>(]*>)?\s*\(/.exec(member.slice(start));

  if (!head) throw new Error(`cannot read the method of ${route.method} ${route.path}: ${member.trim().slice(0, 100)}`);

  const open = start + head[0].length - 1;
  const inside = balancedArguments(member, open);

  if (inside === null) throw new Error(`the parameters of ${head[1]} are not closed`);

  const parameters = splitArguments(inside).map((raw): HandlerParameter => {
    const decorator = /^@([A-Za-z]+)\s*(\(|\s|$)/.exec(raw);

    if (!decorator) throw new Error(`${head[1]}: a parameter without a decorator (${raw.slice(0, 60)})`);

    let args: string[] = [];

    if (decorator[2] === '(') {
      const call = balancedArguments(raw, decorator[0].length - 1);

      if (call === null) throw new Error(`${head[1]}: a parameter decorator is not closed (${raw.slice(0, 60)})`);

      args = splitArguments(call);
    }

    return { decorator: decorator[1], args };
  });

  return { name: head[1], parameters };
}

const literal = (text: string | undefined): string | undefined => {
  const found = text === undefined ? null : /^(?:'([^']*)'|"([^"]*)")$/.exec(text.trim());

  return found ? (found[1] ?? found[2]) : undefined;
};

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { status: 400, getStatus: () => 400, name: 'BadRequestException' });
}

function pipe(name: string, value: unknown, pipeText: string | undefined): unknown {
  if (pipeText === undefined) return value;

  const text = pipeText.trim();

  if (text === 'ParseIntPipe' || text.startsWith('new ParseIntPipe')) {
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value);

    throw badRequest(`Validation failed (numeric string is expected) for ${name}`);
  }

  if (text.startsWith('ParseBoolPipe') || text.startsWith('new ParseBoolPipe')) {
    if (value === undefined && /optional\s*:\s*true/.test(text)) return undefined;
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;

    throw badRequest(`Validation failed (boolean string is expected) for ${name}`);
  }

  if (text.startsWith('new ParseEnumPipe')) return value;

  throw new Error(`the pipe ${text} of ${name} is not known to the invoker`);
}

/** The argument list the router would give the method. */
export function argumentsFor(handler: Handler, request: FakeRequest, response: FakeResponse): unknown[] {
  const req = { ...request, headers: request.headers ?? {}, params: request.params ?? {}, query: request.query ?? {}, body: request.body };

  return handler.parameters.map((parameter) => {
    const key = literal(parameter.args[0]);

    switch (parameter.decorator) {
      case 'CurrentUser':
        return key ? (request.user as any)?.[key] : request.user;
      case 'Param':
        return key ? pipe(key, req.params[key], parameter.args[1]) : req.params;
      case 'Query':
        return key ? pipe(key, req.query[key], parameter.args[1]) : req.query;
      case 'Body':
        return key ? (req.body as any)?.[key] : req.body;
      case 'Request':
      case 'Req':
        return req;
      case 'UploadedFile':
        return request.file;
      case 'UploadedFiles':
        return request.files;
      case 'Ip':
        return request.ip ?? '127.0.0.1';
      case 'Res':
        return response;
      default:
        throw new Error(`${handler.name}: the parameter decorator @${parameter.decorator} is not known to the invoker`);
    }
  });
}

/** A controller, its source, and the routes read from it: what `Router.call` needs. */
export class Router {
  private readonly byKey = new Map<string, ScannedRoute>();
  private readonly handlers = new Map<ScannedRoute, Handler>();

  constructor(
    private readonly controllers: Array<{ source: string; instance: any }>,
    ticketStaff: readonly string[],
  ) {
    const owner = new Map<ScannedRoute, any>();

    for (const { source, instance } of controllers) {
      for (const route of scanController(source, ticketStaff)) {
        const key = routeKey(route.method, route.path);

        if (this.byKey.has(key)) throw new Error(`${key} is declared twice`);

        this.byKey.set(key, route);
        owner.set(route, instance);
      }
    }

    this.owners = owner;
  }

  private readonly owners: Map<ScannedRoute, any>;

  has(key: string): boolean {
    return this.byKey.has(key);
  }

  route(key: string): ScannedRoute {
    const route = this.byKey.get(key);

    if (!route) throw new Error(`no route ${key}`);

    return route;
  }

  /** Runs the method behind `key` with the request, and gives what the router would send (or throws what it would answer). */
  async call(key: string, request: FakeRequest): Promise<{ value: unknown; response: FakeResponse; handler: string }> {
    const route = this.route(key);
    let handler = this.handlers.get(route);

    if (!handler) {
      handler = handlerOf(route);
      this.handlers.set(route, handler);
    }

    const instance = this.owners.get(route);
    const method = instance[handler.name];

    if (typeof method !== 'function') throw new Error(`${key}: the controller has no method ${handler.name}`);

    const response = new FakeResponse();
    const value = await method.apply(instance, argumentsFor(handler, request, response));

    return { value: value === undefined ? response.body : value, response, handler: handler.name };
  }
}
