import { Permission, rolesWith } from './permissions';
import { TICKET_STAFF_ROLES } from './role-policy';
import { routeKey, scanController } from '../testing/route-roles';
import { listSourceFiles, readSource } from '../testing/source-scan';

/**
 * The routes that move money, change accounts or settings, or read the audit log name the permission written here, and the roles that
 * hold it are the ones written here (P3-02). Changing who may do one of these is a decision: it is made in this file, with the matrix.
 * The matrix spec pins the permissions; this one pins the routes to them, so that a route cannot be moved to a lighter permission.
 */

const ROUTES = new Map<string, ReturnType<typeof scanController>[number]>();

for (const file of listSourceFiles().filter((name) => name.endsWith('.controller.ts'))) {
  for (const route of scanController(readSource(file), TICKET_STAFF_ROLES)) ROUTES.set(routeKey(route.method, route.path), route);
}

const ADMINS = ['ADMIN', 'SUPER_ADMIN'];
const MONEY = ['ADMIN', 'SUPER_ADMIN', 'ACCOUNTANT'];
const DISPATCH = ['ADMIN', 'SUPER_ADMIN', 'DISPATCHER'];
const BACK_OFFICE = ['ADMIN', 'SUPER_ADMIN', 'SUPPORT', 'DISPATCHER', 'ACCOUNTANT'];

/** [route, permission, the roles that may call it] */
const PINNED: Array<[string, string, string[]]> = [
  // accounts
  ['POST /users', 'users.manage', ADMINS],
  ['PATCH /users/:', 'users.manage', ADMINS],
  ['DELETE /users/:', 'users.manage', ADMINS],
  ['PATCH /users/:/reactivate', 'users.manage', ADMINS],
  ['POST /users/:/password-setup-link', 'users.manage', ADMINS],
  ['POST /users/staff/create', 'staff.create', ['SUPER_ADMIN']],
  ['POST /admin/artisans', 'artisans.manage', ADMINS],
  ['PATCH /admin/artisans/:/approve', 'artisans.manage', ADMINS],
  ['PATCH /admin/artisans/:/suspend', 'artisans.manage', ADMINS],
  ['PATCH /admin/clients/:', 'clients.edit', ['ADMIN', 'SUPER_ADMIN', 'SUPPORT']],
  ['PATCH /admin/clients/:/deactivate', 'clients.deactivate', ADMINS],
  // jobs
  ['POST /admin/interventions/:/assign-artisan', 'tickets.dispatch', DISPATCH],
  ['PATCH /admin/interventions/:/cancel', 'tickets.dispatch', DISPATCH],
  ['POST /matching/admin/interventions/:/assign-best', 'tickets.dispatch', DISPATCH],
  // money
  ['PATCH /payments/:/confirm', 'payments.handle', BACK_OFFICE],
  ['PATCH /payments/:/refund', 'payments.refund', MONEY],
  // the customer checks their own payment: the service looks at whose it is
  ['POST /payments/:/check', 'payments.check', ['CLIENT', ...BACK_OFFICE]],
  ['PATCH /payments/:/receipt-url', 'payments.edit', MONEY],
  ['POST /invoices/generate', 'invoices.issue', BACK_OFFICE],
  ['PATCH /invoices/:/cancel', 'invoices.void', MONEY],
  ['POST /invoices/:/credit-notes', 'invoices.void', MONEY],
  ['POST /cash-ledger/artisans/:/remittances', 'cash.write', MONEY],
  ['POST /cash-ledger/artisans/:/adjustments', 'cash.write', MONEY],
  ['PATCH /admin/complaints/:/refund', 'complaints.refund', MONEY],
  ['GET /finance/summary', 'finance.read', ['ADMIN', 'SUPER_ADMIN', 'ACCOUNTANT']],
  // settings and notices
  ['PATCH /admin/settings/company', 'settings.manage', ADMINS],
  ['POST /admin/settings/service-zones', 'settings.manage', ADMINS],
  ['POST /services/admin/categories', 'catalog.manage', ADMINS],
  ['DELETE /services/admin/sub-services/:', 'catalog.manage', ADMINS],
  ['POST /notifications', 'notifications.manage', ADMINS],
  // the audit log
  ['GET /admin/audit-log', 'audit.read', ADMINS],
];

describe('the sensitive routes name the permission that guards them (P3-02)', () => {
  it('finds every route in the controllers', () => {
    expect(PINNED.filter(([key]) => !ROUTES.has(key)).map(([key]) => key)).toEqual([]);
  });

  it('each names its permission, with the guard that enforces it, and the roles are the ones listed', () => {
    for (const [key, permission, roles] of PINNED) {
      const route = ROUTES.get(key);

      expect([key, route?.permission, route?.rolesEnforced, [...(route?.roles ?? [])].sort()]).toEqual([key, permission, true, [...roles].sort()]);
    }
  });

  it('the route that assigns a complaint is the one every back-office role may call; the people it can be assigned to are the narrower set of the matrix', () => {
    const route = ROUTES.get('PATCH /admin/complaints/:/assign');

    expect([route?.permission, [...(route?.roles ?? [])].sort()]).toEqual(['complaints.handle', ['ACCOUNTANT', 'ADMIN', 'DISPATCHER', 'SUPER_ADMIN', 'SUPPORT']]);
    expect([...rolesWith(Permission.COMPLAINTS_ASSIGNEE)].sort()).toEqual(['ADMIN', 'DISPATCHER', 'SUPER_ADMIN', 'SUPPORT']);
  });
});
