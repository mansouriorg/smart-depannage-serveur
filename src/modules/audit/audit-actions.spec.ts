import * as fs from 'fs';
import * as path from 'path';

import { Permission } from '../../common/auth/permissions';
import { BACK_OFFICE_ROLES, TICKET_STAFF_ROLES } from '../../common/auth/role-policy';
import { ScannedRoute, routeKey, scanController } from '../../common/testing/route-roles';
import { SRC_ROOT, balanced, listSourceFiles, readSource, stripComments } from '../../common/testing/source-scan';
import { AUDITED_ROUTES, NOT_AUDITED_ROUTES } from './audit-actions';
import { AUDIT_OUTCOMES, AuditOutcome, isAuditOutcome } from './audit-outcome';
import { GLOBAL_PREFIX, auditRouteKey, isSensitiveField } from './audit-record';

/**
 * The audit log covers every write a person of the back office can make (P3-02).
 *
 * The list of actions (`audit-actions.ts`) is checked against the controllers themselves: a write route that a back-office account
 * can reach and that nobody listed fails here, and so does an entry for a route that is gone.
 */

interface Found extends ScannedRoute {
  key: string;
  file: string;
}

function allRoutes(): Found[] {
  const found: Found[] = [];

  for (const file of listSourceFiles().filter((name) => name.endsWith('.controller.ts'))) {
    for (const route of scanController(readSource(file), TICKET_STAFF_ROLES)) found.push({ ...route, key: routeKey(route.method, route.path), file });
  }

  return found;
}

const ROUTES = allRoutes();
const BACK_OFFICE = BACK_OFFICE_ROLES as string[];

/** Whether a person of the back office can call the route: it lets every signed-in account in, or names a back-office role. */
const reachable = (route: Found) => route.how === 'signed-in' || route.how === 'in-code' || (route.roles ?? []).some((role) => BACK_OFFICE.includes(role));

const WRITES = ROUTES.filter((route) => route.method !== 'GET' && reachable(route));
const BY_KEY = new Map(WRITES.map((route) => [route.key, route]));

describe('the audit log covers every write of the back office (P3-02)', () => {
  it('reads the controllers', () => {
    expect(ROUTES.length).toBeGreaterThan(250);
    expect(WRITES.length).toBeGreaterThan(120);
  });

  it('every write route a back-office account can reach is logged, or left out with a reason: one of the two', () => {
    const neither = WRITES.filter((route) => !AUDITED_ROUTES[route.key] && !NOT_AUDITED_ROUTES[route.key]).map((route) => route.key);
    const both = WRITES.filter((route) => AUDITED_ROUTES[route.key] && NOT_AUDITED_ROUTES[route.key]).map((route) => route.key);

    expect(neither).toEqual([]);
    expect(both).toEqual([]);
  });

  it('no entry is for a route that is gone, or for one a back-office account cannot call', () => {
    const stale = [...Object.keys(AUDITED_ROUTES), ...Object.keys(NOT_AUDITED_ROUTES)].filter((key) => !BY_KEY.has(key));

    expect(stale).toEqual([]);
  });

  it('the key the interceptor builds from the route Express matched is the key the list uses, for every route', () => {
    expect(GLOBAL_PREFIX).toBe('/api');

    for (const route of ROUTES) {
      expect([route.key, auditRouteKey(route.method, `${GLOBAL_PREFIX}${route.path}`)]).toEqual([route.key, route.key]);
    }
  });

  it('the global prefix of main.ts is the one the interceptor strips', () => {
    const main = fs.readFileSync(path.resolve(SRC_ROOT, 'main.ts'), 'utf8');

    expect(main).toContain("setGlobalPrefix('api')");
  });

  describe('each entry', () => {
    const entries = Object.entries(AUDITED_ROUTES);

    it('names its action as area.verb, and its target as a word', () => {
      for (const [key, entry] of entries) {
        expect([key, /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(entry.action)]).toEqual([key, true]);
        expect([key, /^[A-Z][A-Za-z]+$/.test(entry.targetType)]).toEqual([key, true]);
      }
    });

    it('says where the id of the target is: a parameter of the path, the answer, the own account, or nowhere, never two', () => {
      for (const [key, entry] of entries) {
        const ways = [entry.param !== undefined, entry.fromResult !== undefined, entry.self === true].filter(Boolean).length;

        expect([key, ways <= 1]).toEqual([key, true]);

        if (entry.param !== undefined) {
          const real = BY_KEY.get(key);

          expect([key, real !== undefined && new RegExp(`:${entry.param}(?![A-Za-z0-9_])`).test(real.path)]).toEqual([key, true]);
        }

        if (entry.fromResult !== undefined) {
          // a dotted path into the answer, written the way the answer is: `id`, `profile.id`
          expect([key, /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)*$/.test(entry.fromResult), entry.fromResult.endsWith('id') || entry.fromResult.endsWith('.id')]).toEqual([key, true, true]);
          expect([key, BY_KEY.get(key)?.method]).toEqual([key, 'POST']);
        }
      }
    });

    it('the routes that name no target id are these, and no others: the id of a thing is the point of a row', () => {
      const noId = entries.filter(([, entry]) => entry.param === undefined && entry.fromResult === undefined && entry.self !== true).map(([key]) => key);

      expect(noId.sort()).toEqual(['PATCH /admin/settings/company', 'POST /business/reports/monthly', 'POST /notifications/test-delivery']);
    });

    it('the answers that wrap the id of what they created are written the way the list says', () => {
      const wrapped = entries.filter(([, entry]) => entry.fromResult !== undefined && entry.fromResult !== 'id').map(([key, entry]) => `${key} -> ${entry.fromResult}`);

      expect(wrapped.sort()).toEqual(['POST /admin/artisans -> profile.id', 'POST /files/artisan/documents -> asset.id', 'POST /files/artisan/identity -> asset.id', 'POST /files/artisan/insurance -> asset.id']);

      const admin = stripComments(readSource('modules/admin/admin.service.ts'));
      const artisan = admin.slice(admin.indexOf('async createArtisanManually'));

      expect(/return \{[^}]*\bprofile,/.test(artisan.slice(0, artisan.indexOf('\n  }\n')))).toBe(true);

      const files = stripComments(readSource('modules/files/files.service.ts'));
      const upload = files.slice(files.indexOf('async uploadArtisanDocument'));

      expect(/return \{\s*asset:/.test(upload.slice(0, upload.indexOf('\n  }\n')))).toBe(true);
    });

    it('the parameter a row is logged by is read as a whole number by the route (ParseIntPipe): `0x2A` or `1e1` never reaches a handler that would read it as 42 or 10', () => {
      const loose: string[] = [];
      let checked = 0;

      for (const [key, entry] of entries) {
        if (entry.param === undefined) continue;

        checked += 1;

        const route = BY_KEY.get(key) as Found;

        if (!new RegExp(`@Param\\(\\s*'${entry.param}'\\s*,\\s*ParseIntPipe\\s*\\)`).test(route.source)) loose.push(`${key} (${entry.param})`);
      }

      expect(checked).toBeGreaterThan(90);
      expect(loose).toEqual([]);
    });

    it('a target type is one of these, and each is the kind of thing its id is (one id space for one type)', () => {
      const types = [...new Set(entries.map(([, entry]) => entry.targetType))].sort();

      expect(types).toEqual([
        'AdminInternalNote',
        'Appointment',
        'AppointmentRequest',
        'ArtisanDocument',
        'ArtisanProfile',
        'ClientAddress',
        'CompanySettings',
        'Complaint',
        'File',
        'Intervention',
        'Invoice',
        'Message',
        'MonthlyReport',
        'Notification',
        'NotificationTemplate',
        'Payment',
        'Payout',
        'ProofCapture',
        'Quote',
        'Review',
        'ServiceCategory',
        'ServiceZone',
        'SubService',
        'User',
      ]);
    });

    it('an artisan profile is only ever reached by its own id, never by the id of the account', () => {
      const byType = (type: string) => entries.filter(([, entry]) => entry.targetType === type);

      // /admin/artisans/:profileId... is the profile; /cash-ledger/artisans/:artisanId and /admin/clients/:clientId are accounts.
      for (const [key, entry] of byType('ArtisanProfile')) expect([key, key.startsWith('POST /admin/artisans') || key.startsWith('PATCH /admin/artisans/'), entry.param ?? entry.fromResult]).toEqual([key, true, entry.param ?? entry.fromResult]);

      for (const [key, entry] of byType('User')) {
        if (entry.param === 'artisanId') expect([key, key.startsWith('POST /cash-ledger/artisans/:/')]).toEqual([key, true]);
        if (entry.param === 'clientId') expect([key, key.startsWith('PATCH /admin/clients/:') || key.startsWith('POST /admin/clients/:')]).toEqual([key, true]);
      }

      expect(byType('ArtisanProfile').length).toBeGreaterThanOrEqual(7);
      expect(byType('User').filter(([, entry]) => entry.param === 'artisanId').length).toBe(2);
    });

    it('a route with a parameter in its path points at it, and a route that creates points at its answer', () => {
      for (const [key, entry] of entries) {
        const hasParam = /:/.test(key);

        if (entry.self || entry.fromResult) continue;
        // An action on something named in the path, or on something with no id (settings, a report, a test send).
        if (hasParam) expect([key, entry.param !== undefined]).toEqual([key, true]);
      }
    });

    it('keeps the value of no field that looks like a secret, and lists each field once', () => {
      for (const [key, entry] of entries) {
        for (const name of entry.details ?? []) expect([key, name, isSensitiveField(name)]).toEqual([key, name, false]);

        expect([key, new Set(entry.details ?? []).size]).toEqual([key, (entry.details ?? []).length]);
      }
    });

    it('gives one kind of target to one action, whichever route does it', () => {
      const byAction = new Map<string, Set<string>>();

      for (const [, entry] of entries) byAction.set(entry.action, (byAction.get(entry.action) ?? new Set()).add(entry.targetType));

      for (const [action, types] of byAction) expect([action, [...types]]).toEqual([action, [[...types][0]]]);
    });
  });

  describe('the fields whose value is kept exist', () => {
    /** Where a class, an interface or an object type alias of that name opens: group 1 is what stands between its name and the brace. */
    const definition = (name: string) => new RegExp(`(?:class|interface)\\s+${name}\\b([^{]*)\\{|type\\s+${name}\\s*=\\s*(\\{)`);

    /** The names a class declares as properties (its own, and those of the class it extends or maps), read from the source. */
    function propertiesOf(file: string, className: string, seen = new Set<string>()): Set<string> {
      const names = new Set<string>();
      const key = `${file}#${className}`;

      if (seen.has(key)) return names;
      seen.add(key);

      const source = stripComments(readSource(file));
      const found = definition(className).exec(source);

      if (!found) return names;

      for (const base of /extends\s+([A-Za-z0-9_]+(?:\([^)]*\))?)/.exec(found[1] ?? '')?.[1].match(/[A-Z][A-Za-z0-9_]+(?=[,)]|$)/g) ?? []) {
        if (!/Type$/.test(base)) for (const name of propertiesOf(file, base, seen)) names.add(name);
      }

      const body = balanced(source, found.index + found[0].length - 1);
      let depth = 0;

      for (const line of body.split('\n')) {
        if (depth === 0) {
          const property = /^\s*(?:public\s+|readonly\s+)*([A-Za-z_][A-Za-z0-9_]*)[?!]?\s*[:=]/.exec(line);

          if (property) names.add(property[1]);
        }

        for (const char of line) depth += char === '{' || char === '(' || char === '[' ? 1 : char === '}' || char === ')' || char === ']' ? -1 : 0;
      }

      return names;
    }

    /** Where a controller got a class from: the file of its import, relative to `src/`. */
    function fileOfClass(controllerFile: string, className: string): string | null {
      const source = readSource(controllerFile);
      const imported = new RegExp(`import\\s*\\{[^}]*\\b${className}\\b[^}]*\\}\\s*from\\s*'(\\.[^']*)'`).exec(source);

      if (imported) {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(controllerFile), imported[1]));
        const candidate = [`${resolved}.ts`, `${resolved}/index.ts`].find((name) => fs.existsSync(path.resolve(SRC_ROOT, name)));

        if (candidate && definition(className).test(readSource(candidate))) return candidate;
      }

      return definition(className).test(source) ? controllerFile : null;
    }

    /** The names of the fields the body of the route can carry, or null when its type cannot be read. */
    function bodyFields(route: Found): Set<string> | null {
      const found = /@Body\(\s*\)\s*[A-Za-z_][A-Za-z0-9_]*\s*:\s*([A-Za-z0-9_]+|\{)/.exec(route.source);

      if (!found) return null;

      if (found[1] === '{') {
        const open = route.source.indexOf('{', found.index + found[0].length - 1);

        return new Set([...balanced(route.source, open).matchAll(/([A-Za-z_][A-Za-z0-9_]*)\??\s*:/g)].map((match) => match[1]));
      }

      const file = fileOfClass(route.file, found[1]);

      return file ? propertiesOf(file, found[1]) : null;
    }

    it('reads the body type of every route that keeps a value', () => {
      const unreadable = Object.entries(AUDITED_ROUTES)
        .filter(([, entry]) => (entry.details ?? []).length > 0)
        .filter(([key]) => bodyFields(BY_KEY.get(key) as Found) === null)
        .map(([key]) => key);

      expect(unreadable).toEqual([]);
    });

    it('every field named in `details` is a field of the body of the route, or a parameter of its path', () => {
      const wrong: string[] = [];
      let checked = 0;

      for (const [key, entry] of Object.entries(AUDITED_ROUTES)) {
        const route = BY_KEY.get(key) as Found;
        const fields = bodyFields(route) ?? new Set<string>();
        const params = new Set([...route.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]));

        for (const name of entry.details ?? []) {
          checked += 1;
          if (!fields.has(name) && !params.has(name)) wrong.push(`${key}: ${name}`);
        }
      }

      expect(checked).toBeGreaterThan(35);
      expect(wrong).toEqual([]);
    });
  });

  describe('what is left out', () => {
    it('is this list and no other: adding a route here is a decision, so it is made in this file', () => {
      expect(Object.keys(NOT_AUDITED_ROUTES).sort()).toEqual(
        [
          'DELETE /notifications/:',
          'DELETE /notifications/push-tokens/:',
          'PATCH /messages/:/read',
          'PATCH /messages/interventions/:/read',
          'PATCH /notification-preferences/me',
          'PATCH /notifications/:/read',
          'PATCH /notifications/preferences/me',
          'PATCH /notifications/read-all',
          'PATCH /users/location',
          'POST /auth/email/send-verification',
          'POST /auth/phone/send-code',
          'POST /complaints/:/messages',
          'POST /messages/interventions/:',
          'POST /notifications/push-tokens',
        ].sort(),
      );
    });

    it('each has a reason in words', () => {
      for (const [key, reason] of Object.entries(NOT_AUDITED_ROUTES)) expect([key, reason.length >= 30 && /\s/.test(reason)]).toEqual([key, true]);
    });

    it('none of them is a route that changes a business record: only chat, read marks, own devices, codes and pings', () => {
      const allowedPermissions = new Set<string>([Permission.NOTIFICATIONS_OWN, Permission.LOCATION_REPORT]);
      // The routes any signed-in account may call and that are left out, named one by one: a new one must be added here on purpose.
      const allowedSignedIn = new Set<string>([
        'PATCH /notification-preferences/me',
        'POST /auth/email/send-verification',
        'POST /auth/phone/send-code',
        'PATCH /messages/interventions/:/read',
        'PATCH /messages/:/read',
        'POST /messages/interventions/:',
        'POST /complaints/:/messages',
      ]);
      let signedIn = 0;
      let withPermission = 0;

      for (const key of Object.keys(NOT_AUDITED_ROUTES)) {
        const found = BY_KEY.get(key);
        const permission = found?.permission ?? null;

        expect([key, found !== undefined]).toEqual([key, true]);

        if (permission === null) {
          signedIn += 1;
          expect([key, allowedSignedIn.has(key)]).toEqual([key, true]);
        } else {
          withPermission += 1;
          expect([key, allowedPermissions.has(permission)]).toEqual([key, true]);
        }
      }

      // Both branches ran: the check is not vacuous.
      expect([signedIn, withPermission]).toEqual([allowedSignedIn.size, Object.keys(NOT_AUDITED_ROUTES).length - allowedSignedIn.size]);
    });
  });

  describe('the writes that matter are all in the log', () => {
    const MUST = new Set<string>([
      Permission.USERS_MANAGE,
      Permission.STAFF_CREATE,
      Permission.ARTISANS_MANAGE,
      Permission.ARTISANS_REVIEW,
      Permission.CLIENTS_EDIT,
      Permission.CLIENTS_DEACTIVATE,
      Permission.NOTES_WRITE,
      Permission.TICKETS_DISPATCH,
      Permission.TICKETS_NOTE,
      Permission.TICKETS_WORKFLOW,
      Permission.PROOFS_REVIEW,
      Permission.COMPLAINTS_HANDLE,
      Permission.COMPLAINTS_REFUND,
      Permission.CASH_WRITE,
      Permission.PAYMENTS_HANDLE,
      Permission.PAYMENTS_REFUND,
      Permission.PAYMENTS_EDIT,
      Permission.PAYMENTS_CHECK,
      Permission.INVOICES_ISSUE,
      Permission.INVOICES_VOID,
      Permission.QUOTES_WRITE,
      Permission.QUOTES_EXPIRE,
      Permission.SETTINGS_MANAGE,
      Permission.CATALOG_MANAGE,
      Permission.NOTIFICATIONS_MANAGE,
      Permission.FILES_VISIBILITY,
    ]);

    it('every write route behind one of these permissions is logged', () => {
      const missing = WRITES.filter((route) => route.permission !== null && MUST.has(route.permission) && !AUDITED_ROUTES[route.key]).map((route) => route.key);
      const checked = WRITES.filter((route) => route.permission !== null && MUST.has(route.permission));

      expect(checked.length).toBeGreaterThan(80);
      expect(missing).toEqual([]);
    });

    it('the writes on money that the older routes decide in the service (payouts, complaints, reviews, scheduling) are logged too', () => {
      for (const key of [
        'POST /business/payouts',
        'PATCH /business/payouts/:/paid',
        'PATCH /business/payouts/:/cancel',
        'PATCH /complaints/admin/:/refund',
        'PATCH /reviews/admin/:/moderate',
        'POST /scheduling/admin/interventions/:/schedule',
        'PATCH /scheduling/admin/requests/:/review',
        'POST /auth/change-password',
        'POST /auth/logout-everywhere',
        'POST /users/me/email-change',
        'DELETE /users/me',
      ]) {
        expect([key, AUDITED_ROUTES[key] !== undefined]).toEqual([key, true]);
      }
    });
  });
});

describe('only the audit service writes the log, and it never rewrites a closed row (P3-02)', () => {
  const files = listSourceFiles();

  it('finds the sources', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it('nothing else in the server touches the table', () => {
    const users = files.filter((file) => /\.auditLog\b/.test(stripComments(readSource(file))) && !file.startsWith('modules/audit/'));

    expect(users).toEqual([]);
  });

  it('the audit service creates, closes (only a row that is still STARTED), and reads: no update, delete or upsert', () => {
    const source = stripComments(readSource('modules/audit/audit.service.ts'));
    const calls = [...source.matchAll(/\.auditLog\.(\w+)\(/g)].map((match) => match[1]).sort();

    expect(calls).toEqual(['create', 'findMany', 'updateMany']);
    expect(source).toMatch(/updateMany\(\{\s*where:\s*\{\s*id,\s*outcome:\s*AuditOutcome\.STARTED\s*\}/);
  });

  it('no route in the audit module writes: the only one reads', () => {
    const routes = scanController(readSource('modules/audit/audit.controller.ts'), TICKET_STAFF_ROLES);

    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual(['GET /admin/audit-log']);
    expect(routes[0]).toMatchObject({ permission: Permission.AUDIT_READ, rolesEnforced: true, roles: ['ADMIN', 'SUPER_ADMIN'] });
  });
});

describe('the log is wired into the server and the database (P3-02)', () => {
  const app = stripComments(readSource('app.module.ts'));

  it('the interceptor is global and comes first, so it is the outermost', () => {
    const providers = app.slice(app.indexOf('providers: ['));
    const order = [...providers.matchAll(/useClass:\s*(\w+)/g)].map((match) => match[1]);

    expect(order[0]).toBe('AuditInterceptor');
    expect(providers).toMatch(/provide:\s*APP_INTERCEPTOR,\s*useClass:\s*AuditInterceptor/);
    expect(app).toMatch(/imports:\s*\[[\s\S]*\bAuditModule\b[\s\S]*\]/);
  });

  it('the module gives the service to the interceptor', () => {
    const module = stripComments(readSource('modules/audit/audit.module.ts'));

    expect(module).toMatch(/controllers:\s*\[AuditController\]/);
    expect(module).toMatch(/providers:\s*\[AuditService\]/);
    expect(module).toMatch(/exports:\s*\[AuditService\]/);
  });

  const schema = fs.readFileSync(path.resolve(SRC_ROOT, '../prisma/schema.prisma'), 'utf8');
  const model = /model AuditLog \{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? '';

  it('the table has what the service writes and reads', () => {
    for (const column of ['actorId', 'actorRole', 'action', 'routeKey', 'targetType', 'targetId', 'outcome', 'statusCode', 'changedFields', 'details', 'createdAt', 'finishedAt']) {
      expect([column, new RegExp(`^\\s+${column}\\s`, 'm').test(model)]).toEqual([column, true]);
    }
  });

  it('the table has no relation: the log outlives the accounts and the jobs it speaks about', () => {
    expect(model).not.toContain('@relation');
    expect(model).not.toMatch(/\bUser\b\s/);
  });

  it('the table is indexed for the questions the screen asks: when, who, what, on what', () => {
    for (const index of ['createdAt', 'actorId, createdAt', 'action, createdAt', 'targetType, targetId', 'outcome, createdAt']) {
      expect([index, model.includes(`@@index([${index}])`)]).toEqual([index, true]);
    }
  });

  it('the outcome is text that starts as STARTED, not a database enum: the contract shared with the apps does not change in this step', () => {
    expect(/^\s+outcome\s+String\s+@default\("STARTED"\)/m.test(model)).toBe(true);
    expect(schema).not.toMatch(/enum AuditOutcome/);
    expect(AuditOutcome.STARTED).toBe('STARTED');
  });

  it('the outcomes are these three, and a text that is not one of them is not an outcome', () => {
    expect([...AUDIT_OUTCOMES]).toEqual(['STARTED', 'SUCCEEDED', 'FAILED']);
    expect(Object.isFrozen(AUDIT_OUTCOMES)).toBe(true);
    expect(['STARTED', 'SUCCEEDED', 'FAILED'].every(isAuditOutcome)).toBe(true);

    for (const value of ['started', 'DONE', '', null, undefined, 3, {}]) expect([value, isAuditOutcome(value)]).toEqual([value, false]);
  });
});
