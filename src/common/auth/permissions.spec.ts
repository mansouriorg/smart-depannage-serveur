import { Role } from '../../../generated/prisma/client';
import { scanController } from '../testing/route-roles';
import { listSourceFiles, readSource, stripComments } from '../testing/source-scan';
import { PERMISSION_ROLES, Permission, can, isPermission, permissionsOf, rolesWith } from './permissions';
import { BACK_OFFICE_ROLES, TICKET_STAFF_ROLES, isBackOffice, isTicketStaff } from './role-policy';
import { STAFF_ROLES } from './staff-pages';

/**
 * The role-permission matrix (P3-02): the one place that says which roles may do what.
 */

const ROLES = Object.values(Role) as string[];
const PERMISSIONS = Object.values(Permission) as Permission[];
const sorted = (list: readonly string[]) => [...list].sort();


describe('the shape of the matrix', () => {
  it('has the seven roles of the database, and every line names at least one of them, each once, in the order of the enum', () => {
    expect(ROLES).toHaveLength(7);
    expect(PERMISSIONS.length).toBeGreaterThan(60);

    for (const permission of PERMISSIONS) {
      const holders = [...PERMISSION_ROLES[permission]];

      expect([permission, holders.length > 0]).toEqual([permission, true]);
      expect([permission, new Set(holders).size]).toEqual([permission, holders.length]);
      expect([permission, holders.every((role) => ROLES.includes(role))]).toEqual([permission, true]);
      expect([permission, holders.map((role) => ROLES.indexOf(role))]).toEqual([permission, [...holders.map((role) => ROLES.indexOf(role))].sort((a, b) => a - b)]);
    }
  });

  it('names every permission once, in lower case with dots and hyphens, and the constant is the name in capitals', () => {
    const values = Object.values(Permission);

    expect(new Set(values).size).toBe(values.length);

    for (const [constant, value] of Object.entries(Permission)) {
      expect(value).toMatch(/^[a-z]+(-[a-z]+)*\.[a-z]+(-[a-z]+)*$/);
      expect(constant).toBe(value.toUpperCase().replace(/[.-]/g, '_'));
    }
  });

  it('a super administrator holds every permission of the back office, an administrator all but the creation of staff accounts and the edit of other people’s notifications', () => {
    // The permissions that belong to a customer or a technician (their own money, their own missions) are not the back office's.
    const personal = PERMISSIONS.filter((permission) => PERMISSION_ROLES[permission].every((role) => role === Role.CLIENT || role === Role.ARTISAN));

    expect(sorted(personal)).toEqual(
      sorted([
        Permission.ARTISAN_PRESENCE,
        Permission.CASH_COLLECT,
        Permission.INVOICES_MINE,
        Permission.MISSIONS_WORK,
        Permission.PAYMENTS_PAY,
        Permission.QUOTES_RESPOND,
      ]),
    );

    const ofTheBackOffice = PERMISSIONS.filter((permission) => !personal.includes(permission));

    expect(ofTheBackOffice.length).toBeGreaterThan(55);

    for (const permission of ofTheBackOffice) expect([permission, can(Role.SUPER_ADMIN, permission)]).toEqual([permission, true]);

    const missingForAdmin = ofTheBackOffice.filter((permission) => !can(Role.ADMIN, permission));

    expect(sorted(missingForAdmin)).toEqual(sorted([Permission.STAFF_CREATE, Permission.NOTIFICATIONS_EDIT_ANY]));
  });

  it('a customer or a technician never holds a permission of the back office alone', () => {
    const backOfficeOnly = PERMISSIONS.filter((permission) => PERMISSION_ROLES[permission].every((role) => BACK_OFFICE_ROLES.includes(role)));

    expect(backOfficeOnly.length).toBeGreaterThan(30);

    for (const permission of backOfficeOnly) {
      expect([permission, can(Role.CLIENT, permission)]).toEqual([permission, false]);
      expect([permission, can(Role.ARTISAN, permission)]).toEqual([permission, false]);
    }
  });
});

describe('who holds the sensitive permissions (a change here is a decision, so the line is pinned)', () => {
  const holders: Record<string, string[]> = {
    [Permission.STAFF_CREATE]: ['SUPER_ADMIN'],
    [Permission.USERS_MANAGE]: ['ADMIN', 'SUPER_ADMIN'],
    [Permission.SETTINGS_MANAGE]: ['ADMIN', 'SUPER_ADMIN'],
    [Permission.CATALOG_MANAGE]: ['ADMIN', 'SUPER_ADMIN'],
    [Permission.AUDIT_READ]: ['ADMIN', 'SUPER_ADMIN'],
    [Permission.FILES_VISIBILITY]: ['ADMIN', 'SUPER_ADMIN'],
    [Permission.NOTIFICATIONS_MANAGE]: ['ADMIN', 'SUPER_ADMIN'],
    [Permission.NOTIFICATIONS_EDIT_ANY]: ['SUPER_ADMIN'],
    [Permission.PAYMENTS_REFUND]: ['ADMIN', 'SUPER_ADMIN', 'ACCOUNTANT'],
    [Permission.INVOICES_VOID]: ['ADMIN', 'SUPER_ADMIN', 'ACCOUNTANT'],
    [Permission.CASH_WRITE]: ['ADMIN', 'SUPER_ADMIN', 'ACCOUNTANT'],
    [Permission.COMPLAINTS_REFUND]: ['ADMIN', 'SUPER_ADMIN', 'ACCOUNTANT'],
    [Permission.ARTISANS_MANAGE]: ['ADMIN', 'SUPER_ADMIN'],
    [Permission.TICKETS_DISPATCH]: ['ADMIN', 'SUPER_ADMIN', 'DISPATCHER'],
    [Permission.BACK_OFFICE_ACCESS]: ['ADMIN', 'SUPER_ADMIN', 'SUPPORT', 'DISPATCHER', 'ACCOUNTANT'],
    [Permission.TICKETS_READ]: ['ADMIN', 'SUPER_ADMIN', 'SUPPORT', 'DISPATCHER'],
  };

  for (const [permission, roles] of Object.entries(holders)) {
    it(`${permission}: ${roles.join(', ')}`, () => {
      expect(sorted(rolesWith(permission as Permission))).toEqual(sorted(roles));
    });
  }
});

describe('the helpers', () => {
  it('can: a role the matrix does not know, no role and a permission that does not exist hold nothing', () => {
    expect(can('ROOT', Permission.USERS_READ)).toBe(false);
    expect(can('', Permission.USERS_READ)).toBe(false);
    expect(can(undefined, Permission.USERS_READ)).toBe(false);
    expect(can(null, Permission.USERS_READ)).toBe(false);
    expect(can('admin', Permission.USERS_READ)).toBe(false);
    expect(can(Role.ADMIN, 'nothing.at-all' as Permission)).toBe(false);
    expect(can(Role.ACCOUNTANT, Permission.PAYMENTS_REFUND)).toBe(true);
    expect(can(Role.DISPATCHER, Permission.PAYMENTS_REFUND)).toBe(false);
    expect(can(Role.SUPPORT, Permission.PAYMENTS_REFUND)).toBe(false);
  });

  it('rolesWith gives a copy, and the matrix cannot be changed through it or through the table', () => {
    const copy = rolesWith(Permission.AUDIT_READ);

    copy.push(Role.CLIENT);

    expect(rolesWith(Permission.AUDIT_READ)).toEqual(['ADMIN', 'SUPER_ADMIN']);
    expect(() => (PERMISSION_ROLES[Permission.AUDIT_READ] as Role[]).push(Role.CLIENT)).toThrow();

    try {
      (PERMISSION_ROLES as unknown as Record<string, Role[]>)['audit.read'] = [Role.CLIENT];
    } catch {
      // a frozen table refuses by throwing (strict mode) or silently (sloppy mode): either way it must not change
    }

    expect(rolesWith(Permission.AUDIT_READ)).toEqual(['ADMIN', 'SUPER_ADMIN']);
    expect(rolesWith('nothing.at-all' as Permission)).toEqual([]);
  });

  it('permissionsOf lists what can says, for each of the seven roles', () => {
    for (const role of ROLES) {
      const listed = permissionsOf(role);

      expect(listed).toEqual(PERMISSIONS.filter((permission) => can(role, permission)));
    }

    expect(permissionsOf('ROOT')).toEqual([]);
    expect(permissionsOf(Role.CLIENT)).toContain(Permission.CLIENT_REQUESTS);
    expect(permissionsOf(Role.CLIENT)).not.toContain(Permission.USERS_READ);
  });

  it('can and rolesWith do not read the prototype of the table: a name that is not a permission holds for nobody', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'users.destroy', '']) {
      for (const role of ROLES) {
        expect([name, role, can(role, name as unknown as Permission)]).toEqual([name, role, false]);
      }

      expect([name, rolesWith(name as unknown as Permission)]).toEqual([name, []]);
    }
  });

  it('isPermission: only the names of the matrix', () => {
    expect(isPermission('finance.read')).toBe(true);
    expect(isPermission('finance.write')).toBe(false);
    expect(isPermission('toString')).toBe(false);
    expect(isPermission('__proto__')).toBe(false);
    expect(isPermission(undefined)).toBe(false);
    expect(isPermission(3)).toBe(false);
  });
});

describe('the role policy is the matrix, not a second list', () => {
  it('the ticket staff are the roles that hold tickets.read, the back office the roles that hold back-office.access', () => {
    expect(TICKET_STAFF_ROLES).toEqual(rolesWith(Permission.TICKETS_READ));
    expect(BACK_OFFICE_ROLES).toEqual(rolesWith(Permission.BACK_OFFICE_ACCESS));

    for (const role of ROLES) {
      expect([role, isTicketStaff(role)]).toEqual([role, can(role, Permission.TICKETS_READ)]);
      expect([role, isBackOffice(role)]).toEqual([role, can(role, Permission.BACK_OFFICE_ACCESS)]);
    }

    expect(isBackOffice(undefined)).toBe(false);
    expect(isTicketStaff('ADMINISTRATOR')).toBe(false);
  });

  it('the copies that must not import anything (the status rules and the dashboard table, both copied into the shared package) say the same as the matrix', () => {
    // The status rules import nothing (the file is copied as it is into the shared package), so the list is read from its text.
    const written = /const STAFF_ROLE_NAMES\s*=\s*\[([^\]]*)\]/.exec(readSource('modules/intervention-workflow/intervention-status.ts'));
    expect(written).not.toBeNull();
    const names = (written?.[1] ?? '').split(',').map((name) => name.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    expect(sorted(names)).toEqual(sorted(rolesWith(Permission.TICKETS_READ)));
    expect(sorted(STAFF_ROLES)).toEqual(sorted(rolesWith(Permission.BACK_OFFICE_ACCESS)));
  });
});

describe('the seven lists of the dashboard table (staff-pages.ts) are rows of the matrix', () => {
  // The file is copied as it is into the shared package, so it cannot import the matrix: its lists are read from its text.
  const text = stripComments(readSource('common/auth/staff-pages.ts'));
  const listOf = (name: string): string[] => {
    const found = new RegExp(`const ${name}: readonly StaffRole\\[\\] = \\[([^\\]]*)\\];`).exec(text);

    expect(found).not.toBeNull();

    return (found?.[1] ?? '').split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  };

  const PINNED: Array<[string, Permission]> = [
    ['TICKET_STAFF', Permission.TICKETS_READ],
    ['VERIFIERS', Permission.ARTISANS_REVIEW],
    ['MANAGERS', Permission.USERS_MANAGE],
    ['FINANCE_STAFF', Permission.FINANCE_READ],
    ['COMPLAINT_STAFF', Permission.COMPLAINTS_READ],
    ['COMPANY_READERS', Permission.COMPANY_READ],
    ['DISPATCHERS', Permission.TICKETS_DISPATCH],
  ];

  for (const [name, permission] of PINNED) {
    it(`${name} is the roles of ${permission}`, () => {
      expect(sorted(listOf(name))).toEqual(sorted(rolesWith(permission)));
    });
  }

  it('they are all the lists the file declares', () => {
    const declared = [...text.matchAll(/const ([A-Z_]+): readonly StaffRole\[\] = \[/g)].map((found) => found[1]);

    expect(sorted(declared)).toEqual(sorted(PINNED.map(([name]) => name)));
  });
});

describe('a service asks the row of the route it backs', () => {
  it('the cash ledger reads with cash.read and writes with cash.write, not with the finance row', () => {
    const source = stripComments(readSource('modules/cash-ledger/cash-ledger.service.ts'));

    expect(source).toMatch(/CASH_READERS: Role\[\] = rolesWith\(Permission\.CASH_READ\)/);
    expect(source).toMatch(/CASH_WRITERS: Role\[\] = rolesWith\(Permission\.CASH_WRITE\)/);
    expect(source).not.toMatch(/FINANCE_READ|FINANCE_ROLES/);

    // the readers and the writers are the ones the routes name
    const body = (name: string) => source.slice(source.indexOf(`async ${name}(`)).split('\n  }\n')[0];

    for (const reader of ['getArtisanLedger', 'listBalances']) expect([reader, /this\.assertFinance\(role\)/.test(body(reader))]).toEqual([reader, true]);
    for (const writer of ['recordRemittance', 'recordAdjustment']) expect([writer, /this\.assertCashWriter\(role\)/.test(body(writer))]).toEqual([writer, true]);
  });
});

/** A staff role named in code: as `Role.X`, as a text in any quotes (`'ADMIN'`, `"ADMIN"`, backticks), or through an alias of the enum. */
const STAFF_ROLE_NAMED = /\bRole(?:\[\s*['"`]|\??\.)(ADMIN|SUPER_ADMIN|SUPPORT|DISPATCHER|ACCOUNTANT)\b|['"`](ADMIN|SUPER_ADMIN|SUPPORT|DISPATCHER|ACCOUNTANT)['"`]|\b(?:UserRole|PrismaRole|RoleEnum)\.(ADMIN|SUPER_ADMIN|SUPPORT|DISPATCHER|ACCOUNTANT)\b/;

describe('the scan for role lists that are not the matrix', () => {
  it('sees the ways a staff role can be named', () => {
    for (const text of ["Role.ADMIN", "role === 'SUPPORT'", 'role === "DISPATCHER"', 'role === `ACCOUNTANT`', '["ADMIN","SUPER_ADMIN"].includes(role)', "Role['ADMIN']", "Role?.SUPPORT", "UserRole.ADMIN"]) {
      expect([text, STAFF_ROLE_NAMED.test(text)]).toEqual([text, true]);
    }
  });

  it('does not see what is not a staff role', () => {
    for (const text of ["Role.CLIENT", "'CLIENT'", 'const ADMINISTRATOR = 1', 'ADMIN_PANEL', "isAdmin(role)", "'admin'"]) {
      expect([text, STAFF_ROLE_NAMED.test(text)]).toEqual([text, false]);
    }
  });
});

describe('no route and no service keeps a list of roles of its own', () => {
  const files = listSourceFiles();

  it('finds the sources', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it('@Roles and RolesGuard are gone', () => {
    const left = files.filter((file) => /@Roles\(|\bRolesGuard\b|decorators\/roles\.decorator|guards\/roles\.guard/.test(stripComments(readSource(file))));

    expect(left).toEqual([]);
  });

  it('a staff role is named in code only where the matrix, the hierarchy and the two copied tables are', () => {
    // The hierarchy (role-policy.ts: who may act on whom) and the seed that makes the first administrator are not lists of who may do what.
    const allowed = new Set(['common/auth/permissions.ts', 'common/auth/role-policy.ts', 'common/auth/staff-pages.ts', 'modules/intervention-workflow/intervention-status.ts']);
    const named = STAFF_ROLE_NAMED;
    const found = files.filter((file) => !allowed.has(file) && named.test(stripComments(readSource(file))));

    expect(found).toEqual([]);
  });

  it('every route of a controller that has PermissionsGuard names its permission (a guard with nothing to check lets everybody in)', () => {
    const loose: string[] = [];

    for (const file of files.filter((name) => name.endsWith('.controller.ts'))) {
      for (const route of scanController(readSource(file), TICKET_STAFF_ROLES)) {
        if (route.guards.includes('PermissionsGuard') && route.permission === null) loose.push(`${file}: ${route.method} ${route.path}`);
      }
    }

    expect(loose).toEqual([]);
  });

  it('every permission is used: by a route that names it or by a service that asks the matrix (a row nobody reads is a promise nobody keeps)', () => {
    const text = files.filter((file) => file !== 'common/auth/permissions.ts').map((file) => stripComments(readSource(file))).join('\n');
    const unused = Object.keys(Permission).filter((name) => !new RegExp(`Permission\\.${name}\\b`).test(text));

    expect(unused).toEqual([]);
  });

  it('a route that names a permission has the guard that enforces it', () => {
    const unenforced: string[] = [];

    for (const file of files.filter((name) => name.endsWith('.controller.ts'))) {
      for (const route of scanController(readSource(file), TICKET_STAFF_ROLES)) {
        if (route.permission !== null && !route.rolesEnforced) unenforced.push(`${file}: ${route.method} ${route.path}`);
      }
    }

    expect(unenforced).toEqual([]);
  });
});
