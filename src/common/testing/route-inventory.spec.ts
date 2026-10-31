import * as fs from 'fs';
import * as path from 'path';

import { Role } from '../../../generated/prisma/client';
import { BACK_OFFICE_ROLES, TICKET_STAFF_ROLES } from '../auth/role-policy';
import { PermissionsGuard } from '../guards/permissions.guard';
import { ACCESS_MANIFEST, GATEWAY_MANIFEST } from './access-manifest';
import { LINK_SCENARIOS, SCENARIOS, SELF_SCENARIOS } from './access/all';
import { handlerOf } from './route-invoker';
import { ScannedRoute, routeKey, scanController } from './route-roles';
import { SRC_ROOT, listSourceFiles, readSource } from './source-scan';

/**
 * Every route of the server, and what keeps one person out of another's data (P1-17).
 *
 * The scenarios of `access/` call the real controllers and services as the wrong person. This spec makes
 * sure nothing escapes them: every route that exists is in a scenario, behind the roles of the back
 * office, or in `access-manifest.ts` with the test that proves it. A new endpoint without one of the three
 * fails here, and so does a scenario or an entry for a route that is gone.
 */

interface Found extends ScannedRoute {
  key: string;
  file: string;
}

function allRoutes(): Found[] {
  const found: Found[] = [];

  for (const file of listSourceFiles().filter((name) => name.endsWith('.controller.ts'))) {
    for (const route of scanController(readSource(file), TICKET_STAFF_ROLES)) {
      found.push({ ...route, key: routeKey(route.method, route.path), file });
    }
  }

  return found;
}

const ROUTES = allRoutes();
const BY_KEY = new Map<string, Found[]>();

for (const route of ROUTES) BY_KEY.set(route.key, [...(BY_KEY.get(route.key) ?? []), route]);

const OWNER = new Set(SCENARIOS.map((scenario) => scenario.route));
const SELF = new Set(SELF_SCENARIOS.map((scenario) => scenario.route));
const LINK = new Set(LINK_SCENARIOS.map((scenario) => scenario.route));
const BACK_OFFICE = BACK_OFFICE_ROLES as string[];

/** Only the back office is let in, and the guard that says so is applied: nobody else can reach the service. */
const backOfficeOnly = (route: Found) =>
  (route.how === 'roles' || route.how === 'class-roles' || route.how === 'ticket-staff') &&
  route.rolesEnforced &&
  route.roles !== null &&
  route.roles.length > 0 &&
  route.roles.every((role) => BACK_OFFICE.includes(role));

const withoutTest = (routes: Found[], manifest: Record<string, unknown> = ACCESS_MANIFEST) =>
  routes.filter((route) => !covered(route) && !backOfficeOnly(route) && !manifest[route.key]);

const covered = (route: Found) => OWNER.has(route.key) || SELF.has(route.key) || LINK.has(route.key);

describe('every route has a wrong-user test (P1-17)', () => {
  it('reads the controllers: there are routes, and no two have the same method and path', () => {
    expect(ROUTES.length).toBeGreaterThan(250);

    for (const [key, routes] of BY_KEY) {
      if (routes.length > 1) throw new Error(`${key} is declared twice (${routes.map((route) => route.file).join(', ')})`);
    }
  });

  it('puts each route in a scenario, behind the back office alone, or in the manifest', () => {
    const loose = withoutTest(ROUTES).map((route) => `${route.key}  (${route.file}, ${route.how}${route.roles ? ': ' + route.roles.join('|') : ''})`);

    if (loose.length > 0) {
      throw new Error(
        `these routes have no wrong-user test. Add a scenario in src/common/testing/access/, or a line in access-manifest.ts that names the test:\n  ${loose.join('\n  ')}`,
      );
    }
  });

  it('would fail for a new endpoint that nobody wrote a test for, whoever may call it', () => {
    const [sample] = scanController(
      `@Controller('things')\n@UseGuards(JwtAuthGuard)\nexport class ThingsController {\n  @Get(':id')\n  one(@Param('id') id: string) {\n    return this.things.one(id);\n  }\n\n  @Delete(':id')\n  @UseGuards(PermissionsGuard)\n  @RequirePermission(Permission.QUOTES_RESPOND)\n  remove(@Param('id') id: string) {\n    return this.things.remove(id);\n  }\n}\n`,
      TICKET_STAFF_ROLES,
    ).map((route): Found => ({ ...route, key: routeKey(route.method, route.path), file: 'things.controller.ts' }));
    const roleBound = scanController(
      `@Controller('things')\n@UseGuards(JwtAuthGuard, PermissionsGuard)\n@RequirePermission(Permission.CLIENT_REQUESTS)\nexport class ThingsController {\n  @Get()\n  all() {\n    return [];\n  }\n}\n`,
      TICKET_STAFF_ROLES,
    ).map((route): Found => ({ ...route, key: routeKey(route.method, route.path), file: 'things.controller.ts' }));

    expect(withoutTest([sample, ...roleBound], {}).map((route) => route.key)).toEqual(['GET /things/:', 'GET /things']);
    expect(withoutTest([sample], { 'GET /things/:': { kind: 'open', why: 'x' } })).toHaveLength(0);
  });

  it('has no scenario and no manifest line for a route that does not exist', () => {
    const stale = [
      ...[...OWNER, ...SELF, ...LINK].filter((key) => !BY_KEY.has(key)).map((key) => `scenario: ${key}`),
      ...Object.keys(ACCESS_MANIFEST).filter((key) => !BY_KEY.has(key)).map((key) => `manifest: ${key}`),
    ];

    expect(stale).toEqual([]);
  });

  it('keeps the manifest to what the scenarios do not cover', () => {
    const twice = Object.keys(ACCESS_MANIFEST).filter((key) => OWNER.has(key) || SELF.has(key) || LINK.has(key));

    expect(twice).toEqual([]);
  });

  it('every proof of the manifest is a file that holds the text it names', () => {
    const missing: string[] = [];

    for (const [key, entry] of Object.entries(ACCESS_MANIFEST)) {
      if (entry.kind !== 'proved') continue;

      expect(entry.proof.length).toBeGreaterThan(0);

      for (const proof of entry.proof) {
        const file = path.join(SRC_ROOT, proof.file);

        if (!fs.existsSync(file)) missing.push(`${key}: no file ${proof.file}`);
        else if (!fs.readFileSync(file, 'utf8').includes(proof.mentions)) missing.push(`${key}: ${proof.file} does not hold "${proof.mentions}"`);
      }
    }

    expect(missing).toEqual([]);
  });
});

describe('who may reach a route at all (P1-17)', () => {
  it('every route that is not public is behind the sign-in, and its roles are enforced', () => {
    const open = ROUTES.filter((route) => route.how !== 'public' && !route.guards.includes('JwtAuthGuard')).map((route) => route.key);
    const unenforced = ROUTES.filter((route) => !route.rolesEnforced).map((route) => route.key);

    expect(open).toEqual([]);
    expect(unenforced).toEqual([]);
  });

  it('a route that anybody may call is either one of the link routes or has a manifest line, and never reads who the caller is (it may read the address it was sent from)', () => {
    const publicRoutes = ROUTES.filter((route) => route.how === 'public');

    expect(publicRoutes.length).toBeGreaterThan(10);

    const unexplained = publicRoutes.filter((route) => !LINK.has(route.key) && !ACCESS_MANIFEST[route.key]).map((route) => route.key);
    const readsCaller = publicRoutes.filter((route) => /@CurrentUser\(|\b(?:req|request)\.user\b/.test(route.source)).map((route) => route.key);

    expect(unexplained).toEqual([]);
    expect(readsCaller).toEqual([]);
  });

  it('the manifest says a route is open or proved in the way the controller makes it: an open line is a public route', () => {
    const wrong = Object.entries(ACCESS_MANIFEST)
      .filter(([key, entry]) => entry.kind === 'open' && BY_KEY.get(key)?.[0].how !== 'public')
      .map(([key]) => key);

    expect(wrong).toEqual([]);
  });

  it('a route with a name in its path is not a "self" scenario: it needs another person\'s id, so it has an owner scenario', () => {
    const wrong: string[] = [];

    for (const key of SELF) {
      const route = BY_KEY.get(key)?.[0];

      if (!route) continue;

      const names = handlerOf(route).parameters.filter((parameter) => parameter.decorator === 'Param');

      if (names.length > 0) wrong.push(`${key} takes ${names.map((parameter) => parameter.args[0]).join(', ')}`);
    }

    expect(wrong).toEqual([]);
  });

  it('every route behind roles lets in exactly the roles that hold the permission it names, for each of the seven roles, and nobody who is not signed in', () => {
    const roles = Object.values(Role) as string[];
    const decided = ROUTES.filter((route) => (route.how === 'roles' || route.how === 'class-roles') && route.rolesEnforced && route.roles && route.permission);
    const wrong: string[] = [];

    expect(roles).toHaveLength(7);
    expect(decided.length).toBeGreaterThan(100);

    /** What the application's own PermissionsGuard does: it lets the caller in, refuses with a 403, or breaks (which is not an answer). */
    const asks = (permission: string, user: { id: number; role: string } | undefined): 'in' | 403 | 'broke' => {
      const guard = new PermissionsGuard({ getAllAndOverride: () => permission } as any);

      try {
        return guard.canActivate({
          getHandler: () => null,
          getClass: () => null,
          switchToHttp: () => ({ getRequest: () => ({ user }) }),
        } as any) === true
          ? 'in'
          : 'broke';
      } catch (error: any) {
        return typeof error?.getStatus === 'function' && error.getStatus() === 403 ? 403 : 'broke';
      }
    };

    for (const route of decided) {
      for (const role of roles) {
        const answer = asks(route.permission!, { id: 1, role });

        if (answer === 'broke') wrong.push(`${route.key}: ${role} gets no answer from the guard`);
        else if ((answer === 'in') !== route.roles!.includes(role)) wrong.push(`${route.key}: ${role} ${answer === 'in' ? 'is let in' : 'is kept out'} against its permission`);
      }

      // somebody who is not signed in is refused with a 403 of the guard, not by a crash that happens to stop them
      if (asks(route.permission!, undefined) !== 403) wrong.push(`${route.key}: somebody who is not signed in is not refused with a 403`);
    }

    expect(wrong).toEqual([]);
  });

  it('the back office has five roles, and a route behind the back office alone refuses customers and artisans', () => {
    expect(BACK_OFFICE).toHaveLength(5);

    const leaky = ROUTES.filter(backOfficeOnly).filter((route) => route.roles!.some((role) => role === 'CLIENT' || role === 'ARTISAN'));

    expect(leaky).toEqual([]);
  });
});

describe('nothing is out of the inventory\'s sight (P1-17)', () => {
  const files = listSourceFiles();

  it('every controller is a .controller.ts file with one @Controller and no parent class, and every route decorator is one the scanner reads', () => {
    const wrong: string[] = [];

    for (const file of files) {
      const source = readSource(file);
      const controllers = source.match(/@Controller\(/g)?.length ?? 0;

      if (!file.endsWith('.controller.ts') && controllers > 0) wrong.push(`${file}: a controller in a file that does not end in .controller.ts`);
      if (file.endsWith('.controller.ts') && controllers !== 1) wrong.push(`${file}: ${controllers} @Controller (the scanner reads the first one only)`);
      if (controllers > 0 && /class\s+\w+Controller\s+extends\b/.test(source)) wrong.push(`${file}: a controller with a parent class (its inherited routes are not scanned)`);
      if (controllers > 0 && /@(All|Options|Head|Search|Sse)\(/.test(source)) wrong.push(`${file}: a route decorator the scanner does not read (@All, @Options, @Head, @Search, @Sse)`);
    }

    expect(wrong).toEqual([]);
  });

  /** Every event a socket can send, and every connection, as `file event`. */
  function liveEvents(): string[] {
    const found: string[] = [];

    for (const file of files.filter((name) => name.endsWith('.gateway.ts'))) {
      const source = readSource(file);
      const base = path.basename(file);

      for (const match of source.matchAll(/@SubscribeMessage\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push(`${base} ${match[1]}`);

      if (/handleConnection\(/.test(source)) found.push(`${base} handleConnection`);
    }

    return found.sort();
  }

  it('every event of every gateway is in the gateway manifest, with a test that tries it with the wrong person, and no entry is for an event that is gone', () => {
    const events = liveEvents();

    expect(events.length).toBeGreaterThanOrEqual(8);
    expect(events.filter((event) => !GATEWAY_MANIFEST[event])).toEqual([]);
    expect(Object.keys(GATEWAY_MANIFEST).filter((key) => !events.includes(key))).toEqual([]);
  });

  it('every proof of the gateway manifest is a file that holds the text it names', () => {
    const missing: string[] = [];

    for (const [key, entry] of Object.entries(GATEWAY_MANIFEST)) {
      if (entry.kind !== 'proved') continue;

      expect(entry.proof.length).toBeGreaterThan(0);

      for (const proof of entry.proof) {
        const file = path.join(SRC_ROOT, proof.file);

        if (!fs.existsSync(file)) missing.push(`${key}: no file ${proof.file}`);
        else if (!fs.readFileSync(file, 'utf8').includes(proof.mentions)) missing.push(`${key}: ${proof.file} does not hold "${proof.mentions}"`);
      }
    }

    expect(missing).toEqual([]);
  });
});
