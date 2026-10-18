/**
 * Reads a controller's source and says, for each route, which roles may call it (P1-12).
 *
 * A unit test does not go through Nest's decorators, so the roles of a route cannot be read from
 * metadata there. This reads the lines that decide it instead, the way `artisans.apply-route.spec.ts`
 * reads the upload limits. It knows the ways this server restricts a route:
 *
 *  - `@Roles(Role.A, Role.B)` on the method, or on the class when the method has none. It only
 *    holds when `RolesGuard` is in a `@UseGuards(...)` of the class or the method: the roles of a
 *    route without it are not enforced (`rolesEnforced: false`), and the specs fail on that;
 *  - a gate in the body, `if (!isTicketStaff(...)) throw ...` (the older ticket routes decide in code);
 *  - any other use of `isTicketStaff(` in the body: the route lets every signed-in account in and
 *    answers differently by role (`in-code`), so its roles are NOT known here and the spec has to
 *    say who it really serves;
 *  - nothing: every signed-in account (`signed-in`; the service of the route may still decide), or
 *    anybody at all when no `JwtAuthGuard` is applied (`public`).
 *
 * It does not guess. A `@Roles(...)` argument that is not `Role.NAME`, a route decorator whose path
 * is not a plain string, or a member with two routes makes it throw, so that a controller written
 * in a way it does not understand fails the specs instead of being under-read.
 *
 * The members of the class are found by counting braces, not by the layout of the file, so a
 * checkout with Windows line endings (or a method written on one line) reads the same.
 */

export interface ScannedRoute {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** With the controller's prefix and a leading slash, `:parameters` as written. */
  path: string;
  /** The roles that may call it; null when every signed-in account may (or anybody, see `how`), or when the code decides. */
  roles: string[] | null;
  how: 'roles' | 'class-roles' | 'ticket-staff' | 'in-code' | 'signed-in' | 'public';
  /** The guards that apply to it, from the class and the method (`AuthGuard('jwt')` is read as `JwtAuthGuard`). */
  guards: string[];
  /** False when the roles come from `@Roles` but `RolesGuard` is not applied: nothing enforces them. */
  rolesEnforced: boolean;
  /** The text of the member (its decorators and its body, comments removed): what a spec may look into as evidence. */
  source: string;
}

const ROUTE_DECORATOR = /@(Get|Post|Patch|Put|Delete)\(/g;
const GATE = /if\s*\(\s*!\s*isTicketStaff\s*\([^)]*\)\s*\)\s*\{?\s*throw\b/;

/** The text between the parenthesis that opens at `open` and the one that closes it, or null when it is not closed. */
function balancedArguments(text: string, open: number): string | null {
  let depth = 0;
  let quote: string | null = null;

  for (let i = open; i < text.length; i += 1) {
    const char = text[i];

    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = null;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') quote = char;
    else if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }

  return null;
}

/** The arguments of a call split at the commas that are not inside a bracket or a string. */
function splitArguments(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';

  for (let i = 0; i < args.length; i += 1) {
    const char = args[i];

    if (quote) {
      current += char;
      if (char === '\\') current += args[++i] ?? '';
      else if (char === quote) quote = null;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') quote = char;
    if ('([{'.includes(char)) depth += 1;
    if (')]}'.includes(char)) depth -= 1;

    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  if (current.trim()) parts.push(current.trim());

  return parts;
}

/** The roles named in the first `@Roles(...)` of a text, or null when it has none. Throws on an argument it cannot read. */
export function rolesIn(text: string): string[] | null {
  const at = text.indexOf('@Roles(');

  if (at < 0) return null;

  const args = balancedArguments(text, at + '@Roles'.length);

  if (args === null) throw new Error('@Roles( is not closed');

  const parts = splitArguments(args);

  if (!parts.length) throw new Error('@Roles() names no role');

  return parts.map((part) => {
    const match = /^Role\.([A-Z_]+)$/.exec(part);

    if (!match) throw new Error(`@Roles( has an argument that is not Role.NAME: ${part}`);

    return match[1];
  });
}

/** The guards of every `@UseGuards(...)` in a text (`AuthGuard('jwt')` is `JwtAuthGuard`). */
export function guardsIn(text: string): string[] {
  const guards: string[] = [];

  for (const match of text.matchAll(/@UseGuards\(/g)) {
    const args = balancedArguments(text, (match.index ?? 0) + '@UseGuards'.length);

    if (args === null) throw new Error('@UseGuards( is not closed');

    for (const part of splitArguments(args)) {
      guards.push(/^AuthGuard\(\s*['"]jwt['"]\s*\)$/.test(part) ? 'JwtAuthGuard' : part);
    }
  }

  return guards;
}

/** The source without its comments: a line like "// must come before @Get(':id')" is not a route. */
export function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** The same text with the inside of every string blanked, so that a brace in a message is not counted. */
function maskStrings(text: string): string {
  let out = '';
  let quote: string | null = null;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quote) {
      if (char === '\\') {
        out += '  ';
        i += 1;
      } else if (char === quote) {
        quote = null;
        out += char;
      } else {
        out += char === '\n' ? '\n' : ' ';
      }
      continue;
    }

    if (char === "'" || char === '"' || char === '`') quote = char;
    out += char;
  }

  return out;
}

/** The members of a class body: each ends at the `}` that closes its body or at the `;` that ends it. */
function membersOf(body: string): string[] {
  const masked = maskStrings(body);
  const members: string[] = [];
  let start = 0;
  let braces = 0;
  let parens = 0;

  for (let i = 0; i < masked.length; i += 1) {
    const char = masked[i];

    if (char === '(' || char === '[') parens += 1;
    else if (char === ')' || char === ']') parens -= 1;
    else if (char === '{') braces += 1;
    else if (char === '}') {
      braces -= 1;

      if (braces < 0) {
        // The closing brace of the class.
        if (body.slice(start, i).trim()) members.push(body.slice(start, i));
        return members;
      }

      if (braces === 0 && parens === 0) {
        members.push(body.slice(start, i + 1));
        start = i + 1;
      }
    } else if (char === ';' && braces === 0 && parens === 0) {
      members.push(body.slice(start, i + 1));
      start = i + 1;
    }
  }

  throw new Error('the class is not closed');
}

const joinPath = (...parts: string[]) =>
  `/${parts
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')}`;

/** The path of a route decorator: '' for `@Get()`, the text for a plain string, and an error for anything else. */
function routePath(args: string, member: string): string {
  const text = args.trim();

  if (text === '') return '';

  const literal = /^(?:'([^']*)'|"([^"]*)"|`([^`$]*)`)$/.exec(text);

  if (!literal) throw new Error(`a route decorator has a path that is not a plain string (${text}) in: ${member.trim().slice(0, 80)}`);

  return literal[1] ?? literal[2] ?? literal[3] ?? '';
}

/**
 * Every route of a controller. `ticketStaff` is what `isTicketStaff` accepts (the caller passes the
 * list of the role policy, so a change there is seen here).
 */
export function scanController(rawSource: string, ticketStaff: readonly string[]): ScannedRoute[] {
  const source = withoutComments(rawSource);
  const controller = /@Controller\(\s*(?:'([^']*)'|"([^"]*)")?\s*\)/.exec(source);

  if (!controller) throw new Error('no @Controller( found');

  const prefix = controller[1] ?? controller[2] ?? '';
  const classStart = source.indexOf('export class', controller.index);

  if (classStart < 0) throw new Error('no class after @Controller(');

  const open = source.indexOf('{', classStart);

  if (open < 0) throw new Error('the class has no body');

  const header = source.slice(controller.index, classStart);
  const classRoles = rolesIn(header);
  const classGuards = guardsIn(header);
  const routes: ScannedRoute[] = [];

  for (const member of membersOf(source.slice(open + 1))) {
    const decorators = [...member.matchAll(ROUTE_DECORATOR)];

    if (decorators.length === 0) continue;

    if (decorators.length > 1) throw new Error(`a method with two route decorators: ${member.trim().slice(0, 80)}`);

    const decorator = decorators[0];
    const args = balancedArguments(member, (decorator.index ?? 0) + decorator[0].length - 1);

    if (args === null) throw new Error(`a route decorator is not closed: ${member.trim().slice(0, 80)}`);

    const own = rolesIn(member);
    const guards = [...classGuards, ...guardsIn(member)];
    let roles: string[] | null;
    let how: ScannedRoute['how'];

    if (own) {
      roles = own;
      how = 'roles';
    } else if (classRoles) {
      roles = classRoles;
      how = 'class-roles';
    } else if (GATE.test(member)) {
      roles = [...ticketStaff];
      how = 'ticket-staff';
    } else if (member.includes('isTicketStaff(')) {
      roles = null;
      how = 'in-code';
    } else {
      roles = null;
      how = guards.includes('JwtAuthGuard') ? 'signed-in' : 'public';
    }

    routes.push({
      method: decorator[1].toUpperCase() as ScannedRoute['method'],
      path: joinPath(prefix, routePath(args, member)),
      roles,
      how,
      guards,
      rolesEnforced: how === 'roles' || how === 'class-roles' ? guards.includes('RolesGuard') : true,
      source: member,
    });
  }

  return routes;
}

/** `/users/:id` and `/users/:userId` are the same route. */
export const routeKey = (method: string, path: string) => `${method.toUpperCase()} ${path.replace(/:[A-Za-z0-9_]+/g, ':')}`;
