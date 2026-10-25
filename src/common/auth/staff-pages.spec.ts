import * as fs from 'fs';
import * as path from 'path';

import { Role } from '../../../generated/prisma/client';
import { ScannedRoute, routeKey, scanController } from '../testing/route-roles';
import { BACK_OFFICE_ROLES, TICKET_STAFF_ROLES } from './role-policy';
import {
  ApiCall,
  DASHBOARD_PAGES,
  DASHBOARD_SHELL_CALLS,
  STAFF_ACTIONS,
  STAFF_ROLES,
  STAFF_ROLE_LABELS,
  staffCan,
  canOpenDashboardPath,
  dashboardHomeFor,
  isDashboardPath,
  normalizeDashboardPath,
  dashboardPageFor,
  dashboardPagesFor,
  staffRoleLabel,
  staffRoleOf,
} from './staff-pages';

/**
 * The table of staff-pages.ts against the routes it points to (P1-12). The controllers are read as
 * text (see route-roles.ts); the table must name only routes that exist, never offer a page or a
 * button to a role whose call the API refuses, and for a button offer it to exactly the roles the
 * API accepts.
 */
const MODULES = path.join(__dirname, '../../modules');
const CONTROLLERS = [
  'admin/admin.controller.ts',
  'users/users.controller.ts',
  'interventions/interventions.controller.ts',
  'proofs/proofs.controller.ts',
  'matching/matching.controller.ts',
  'finance/finance.controller.ts',
  'payments/payments.controller.ts',
  'invoices/invoices.controller.ts',
  'cash-ledger/cash-ledger.controller.ts',
  'business/business.controller.ts',
  'complaints/complaints.controller.ts',
  'reviews/reviews.controller.ts',
];

function routesOfTheApi(): Map<string, ScannedRoute> {
  const routes = new Map<string, ScannedRoute>();

  for (const file of CONTROLLERS) {
    const source = fs.readFileSync(path.join(MODULES, file), 'utf8');

    for (const route of scanController(source, TICKET_STAFF_ROLES)) {
      const key = routeKey(route.method, route.path);

      // Two routes with the same address in the five controllers would make the lookup below guess.
      if (routes.has(key)) throw new Error(`${key} is declared twice (${file})`);

      routes.set(key, route);
    }
  }

  return routes;
}

const API = routesOfTheApi();
const staffOnly = (roles: readonly string[]) => roles.filter((role) => (STAFF_ROLES as readonly string[]).includes(role));
const sorted = (roles: readonly string[]) => [...roles].sort();

function routeOf(call: ApiCall): ScannedRoute {
  const route = API.get(routeKey(call.method, call.path));

  if (!route) throw new Error(`${call.method} ${call.path} is not a route of the API (renamed or removed?)`);

  return route;
}

/**
 * The calls of the pages that no `@Roles` restricts: the code of the route (or of its service)
 * decides who gets what the page shows. For each, who is served, why, and a pattern that the route's
 * own source must still contain, so that a change to the check is seen here, not assumed away.
 * A page call to a route with no @Roles that is not in this list fails below.
 */
const MODULE_SOURCE = (file: string) => fs.readFileSync(path.join(MODULES, file), 'utf8');

const SERVED: Record<string, { roles: readonly string[]; because: string; evidence: RegExp; service?: { file: string; evidence: RegExp } }> = {
  'GET /interventions': {
    roles: TICKET_STAFF_ROLES,
    because: 'staff get the full list, an artisan the open jobs, anybody else only their own',
    evidence: /if \(isTicketStaff\(req\.user\.role\)\) \{\s*return this\.interventionsService\.findAll\(\);/,
  },
  'GET /interventions/:': {
    roles: TICKET_STAFF_ROLES,
    because: 'the service gives a ticket to staff, to its customer and to its artisan, and a 404 to anybody else',
    evidence: /findOneForActor\(/,
    service: {
      file: 'interventions/interventions.service.ts',
      evidence: /async findOneForActor\([\s\S]*?if \(isTicketStaff\(actor\.role\)\) \{\s*return intervention;[\s\S]*?throw new NotFoundException/,
    },
  },
  'PATCH /interventions/:': {
    roles: TICKET_STAFF_ROLES,
    because: 'staff update any ticket, an artisan their own mission, everybody else is refused (no button of the dashboard uses it since P1-13; support can still call it by hand)',
    evidence: /if \(isTicketStaff\(req\.user\.role\)\) \{\s*return this\.interventionsService\.update\([\s\S]*?throw new ForbiddenException/,
  },
  'GET /users/profile': {
    roles: STAFF_ROLES,
    because: 'the signed-in person\'s own profile, read from the token',
    evidence: /@CurrentUser\('id'\) userId: number[\s\S]*getProfile\(userId\)/,
  },
  'PATCH /users/profile': {
    roles: STAFF_ROLES,
    because: 'the signed-in person\'s own profile, written from the token',
    evidence: /@CurrentUser\('id'\) userId: number[\s\S]*updateProfile\(\s*userId/,
  },
  'GET /business/payouts/preview': {
    roles: STAFF_ROLES,
    because: 'what a payout would pay: every staff role may read it (the service checks the role is a staff role)',
    evidence: /this\.service\.previewArtisanPayout\(/,
    service: { file: 'business/business.service.ts', evidence: /async previewArtisanPayout\([^)]*\) \{\s*this\.assertStaff\(role\);/ },
  },
  'GET /business/payouts': {
    roles: STAFF_ROLES,
    because: 'the list of payouts: every staff role may read it (the service checks the role is a staff role)',
    evidence: /this\.service\.listPayouts\(/,
    service: { file: 'business/business.service.ts', evidence: /async listPayouts\([^)]*\) \{\s*this\.assertStaff\(role\);/ },
  },
  'POST /business/payouts': {
    roles: STAFF_ROLES,
    because: 'making a payout: every staff role may (the service checks the role is a staff role; the page leaves the choice of who to the people who see it)',
    evidence: /this\.service\.createArtisanPayout\(/,
    service: { file: 'business/business.service.ts', evidence: /async createArtisanPayout\([^)]*\) \{\s*this\.assertStaff\(role\);/ },
  },
  'PATCH /business/payouts/:/paid': {
    roles: STAFF_ROLES,
    because: 'marking a payout paid: every staff role may (the service checks the role is a staff role)',
    evidence: /this\.service\.markPayoutPaid\(/,
    service: { file: 'business/business.service.ts', evidence: /async markPayoutPaid\([^)]*\) \{\s*this\.assertStaff\(role\);/ },
  },
  'PATCH /business/payouts/:/cancel': {
    roles: STAFF_ROLES,
    because: 'cancelling a payout: every staff role may (the service checks the role is a staff role)',
    evidence: /this\.service\.cancelPayout\(/,
    service: { file: 'business/business.service.ts', evidence: /async cancelPayout\([^)]*\) \{\s*this\.assertStaff\(role\);/ },
  },
  // The complaints and the reviews (P2-09): the routes carry no @Roles, and the service refuses a customer or an artisan.
  'PATCH /complaints/admin/:/assign': {
    roles: STAFF_ROLES,
    because: 'giving a complaint to an agent: every staff role may (the service checks the role is a staff role)',
    evidence: /this\.service\.assignComplaint\(/,
    service: { file: 'complaints/complaints.service.ts', evidence: /async assignComplaint\([^)]*\) \{\s*this\.assertStaff\(role\);/ },
  },
  'PATCH /complaints/admin/:/status': {
    roles: STAFF_ROLES,
    because: 'moving a complaint\'s status: every staff role may (the service checks the role is a staff role)',
    evidence: /this\.service\.updateStatus\(/,
    service: { file: 'complaints/complaints.service.ts', evidence: /async updateStatus\([^)]*\) \{\s*this\.assertStaff\(role\);/ },
  },
  'PATCH /complaints/admin/:/resolve': {
    roles: STAFF_ROLES,
    because: 'resolving a complaint: every staff role may (the service checks the role is a staff role)',
    evidence: /this\.service\.resolveComplaint\(/,
    service: { file: 'complaints/complaints.service.ts', evidence: /async resolveComplaint\([^)]*\) \{\s*this\.assertStaff\(role\);/ },
  },
  'POST /complaints/:/messages': {
    roles: STAFF_ROLES,
    because: 'a message on a complaint: its customer, its artisan and every staff role (the service lets staff in, and only staff write an internal one)',
    evidence: /this\.service\.addMessage\(/,
    service: {
      file: 'complaints/complaints.service.ts',
      evidence: /const isStaff = this\.isStaff\(role\);\s*if \(!isClient && !isArtisan && !isAuthor && !isStaff\) \{\s*throw new ForbiddenException/,
    },
  },
  'GET /reviews/admin': {
    roles: STAFF_ROLES,
    because: 'the moderation queue: every staff role may read it (the service checks the role is a staff role)',
    evidence: /this\.service\.adminFindAll\(/,
    service: { file: 'reviews/reviews.service.ts', evidence: /async adminFindAll\([^)]*\) \{\s*this\.assertStaff\(role\);/ },
  },
  'PATCH /reviews/admin/:/moderate': {
    roles: STAFF_ROLES,
    because: 'deciding a review: every staff role may (the service checks the role is a staff role)',
    evidence: /this\.service\.moderateReview\(/,
    service: { file: 'reviews/reviews.service.ts', evidence: /async moderateReview\([^)]*\) \{\s*this\.assertStaff\(role\);/ },
  },
  'GET /users/me': {
    roles: STAFF_ROLES,
    because: 'the signed-in person\'s own account, read from the token',
    evidence: /@CurrentUser\('id'\) userId: number[\s\S]*getProfile\(userId\)/,
  },
};

/** The roles an API call really serves for what the page needs: the roles of its route, or what SERVED says for a route the code decides. */
function servedRoles(call: ApiCall): readonly string[] {
  const route = routeOf(call);

  if (route.roles !== null) return route.roles;

  const served = SERVED[routeKey(call.method, call.path)];

  if (!served) {
    throw new Error(`${call.method} ${call.path} has no @Roles (${route.how}): say in SERVED who it serves, and the evidence`);
  }

  return served.roles;
}

describe('the staff roles', () => {
  it('are the back-office roles of the role policy, and exist in the database enum', () => {
    expect(sorted(STAFF_ROLES)).toEqual(sorted(BACK_OFFICE_ROLES));

    for (const role of STAFF_ROLES) {
      expect(Object.values(Role)).toContain(role);
      expect(STAFF_ROLE_LABELS[role].length).toBeGreaterThan(2);
    }
  });

  it('staffRoleOf tells staff from customers, artisans and rubbish', () => {
    expect(staffRoleOf('DISPATCHER')).toBe('DISPATCHER');
    expect(staffRoleOf('ACCOUNTANT')).toBe('ACCOUNTANT');

    for (const other of ['CLIENT', 'ARTISAN', 'admin', '', null, undefined, 3, {}]) {
      expect(staffRoleOf(other)).toBeNull();
    }
  });

  it('staffRoleLabel gives the French name, and the text itself for a role it does not know', () => {
    expect(staffRoleLabel('SUPER_ADMIN')).toBe('Super administrateur');
    expect(staffRoleLabel('DISPATCHER')).toBe('Dispatcheur');
    expect(staffRoleLabel('CLIENT')).toBe('CLIENT');
    expect(staffRoleLabel(undefined)).toBe('');
  });
});

describe('the pages of the dashboard', () => {
  it('have one name, one address under /dashboard, and at least one role of the staff each', () => {
    expect(new Set(DASHBOARD_PAGES.map((page) => page.id)).size).toBe(DASHBOARD_PAGES.length);
    expect(new Set(DASHBOARD_PAGES.map((page) => page.path)).size).toBe(DASHBOARD_PAGES.length);

    for (const page of DASHBOARD_PAGES) {
      expect(page.path === '/dashboard' || page.path.startsWith('/dashboard/')).toBe(true);
      expect(page.path.endsWith('/') || page.path !== page.path.toLowerCase()).toBe(false);
      expect(page.roles.length).toBeGreaterThan(0);
      expect(staffOnly(page.roles)).toEqual([...page.roles]);
      expect(page.label.length).toBeGreaterThan(2);
    }
  });

  it('give every staff role a page to land on, one that the role may open', () => {
    for (const role of STAFF_ROLES) {
      const home = dashboardHomeFor(role);

      expect(dashboardPagesFor(role).length).toBeGreaterThan(0);
      expect(home).toBe(dashboardPagesFor(role)[0].path);
      expect(canOpenDashboardPath(role, home)).toBe(true);
    }
  });

  it('A DISPATCHER sees only the dispatch pages (done when, P1-12)', () => {
    expect(dashboardPagesFor('DISPATCHER').map((page) => page.id)).toEqual(['overview', 'interventions', 'technicians', 'settings']);
    expect(dashboardHomeFor('DISPATCHER')).toBe('/dashboard');

    for (const closed of ['/dashboard/applications', '/dashboard/feedbacks', '/dashboard/applications/3']) {
      expect(canOpenDashboardPath('DISPATCHER', closed)).toBe(false);
    }

    for (const open of ['/dashboard', '/dashboard/tickets', '/dashboard/tickets/12', '/dashboard/technicians', '/dashboard/settings']) {
      expect(canOpenDashboardPath('DISPATCHER', open)).toBe(true);
    }
  });

  it('the other roles: admins see everything, support checks applicants and runs the complaints, the accountant has the finance console, the complaints, the company and her profile', () => {
    const everything = DASHBOARD_PAGES.map((page) => page.id);

    expect(dashboardPagesFor('ADMIN').map((page) => page.id)).toEqual(everything);
    expect(dashboardPagesFor('SUPER_ADMIN').map((page) => page.id)).toEqual(everything);
    expect(dashboardPagesFor('SUPPORT').map((page) => page.id)).toEqual(['overview', 'interventions', 'applications', 'technicians', 'feedbacks', 'complaints', 'settings']);
    expect(dashboardPagesFor('ACCOUNTANT').map((page) => page.id)).toEqual(['finance', 'complaints', 'company', 'settings']);
    expect(dashboardHomeFor('ACCOUNTANT')).toBe('/dashboard/finance');
  });

  it('a customer, an artisan or an unknown role has no page and lands on the sign-in page', () => {
    for (const other of ['CLIENT', 'ARTISAN', 'ROOT', '', null, undefined]) {
      expect(dashboardPagesFor(other)).toEqual([]);
      expect(dashboardHomeFor(other)).toBe('/');
      expect(canOpenDashboardPath(other, '/dashboard')).toBe(false);
      expect(canOpenDashboardPath(other, '/dashboard/settings')).toBe(false);
    }
  });

  it('dashboardPageFor: the pages under a page belong to it; the query, the case and a final slash do not matter', () => {
    expect(dashboardPageFor('/dashboard')?.id).toBe('overview');
    expect(dashboardPageFor('/dashboard/')?.id).toBe('overview');
    expect(dashboardPageFor('/dashboard/tickets')?.id).toBe('interventions');
    expect(dashboardPageFor('/dashboard/tickets/12')?.id).toBe('interventions');
    expect(dashboardPageFor('/dashboard/tickets/12?tab=proofs#x')?.id).toBe('interventions');
    expect(dashboardPageFor('/Dashboard//Tickets/')?.id).toBe('interventions');
    expect(dashboardPageFor('/dashboard/applications/4')?.id).toBe('applications');
  });

  it('dashboardPageFor: a word that only begins like a page is not the page; unknown addresses are no page', () => {
    expect(dashboardPageFor('/dashboard/ticketsx')).toBeUndefined();
    expect(dashboardPageFor('/dashboard/settingsfoo/1')).toBeUndefined();
    expect(dashboardPageFor('/dashboardx')).toBeUndefined();
    expect(dashboardPageFor('/dashboard/unknown')).toBeUndefined();
    expect(dashboardPageFor('/')).toBeUndefined();
    expect(dashboardPageFor('/login')).toBeUndefined();
  });

  it('cannot be got around with an encoded letter, a backslash or a walk up the tree', () => {
    expect(dashboardPageFor('/dashboard/tick%65ts')?.id).toBe('interventions');
    expect(canOpenDashboardPath('DISPATCHER', '/dashboard/applic%61tions')).toBe(false);
    expect(canOpenDashboardPath('DISPATCHER', '/dashboard\\applications')).toBe(false);
    expect(normalizeDashboardPath('/dashboard/tickets/../applications')).toBeNull();
    expect(canOpenDashboardPath('DISPATCHER', '/dashboard/tickets/../applications')).toBe(false);
    expect(canOpenDashboardPath('ADMIN', '/dashboard/tickets/../applications')).toBe(false);
    expect(canOpenDashboardPath('DISPATCHER', '/dashboard/tickets%2f..%2fapplications')).toBe(false);
    expect(canOpenDashboardPath('DISPATCHER', '/dashboard/%E0%A4%A')).toBe(false);
  });

  it('an address of the dashboard that no page claims is shut for every role, even an admin', () => {
    expect(canOpenDashboardPath('SUPER_ADMIN', '/dashboard/unknown')).toBe(false);
    expect(canOpenDashboardPath('ADMIN', '/dashboard/tickets-secret')).toBe(false);
  });

  it('isDashboardPath: what is under /dashboard, and what cannot be read', () => {
    expect(isDashboardPath('/dashboard')).toBe(true);
    expect(isDashboardPath('/dashboard/anything?x=1')).toBe(true);
    expect(isDashboardPath('/DASHBOARD/x')).toBe(true);
    expect(isDashboardPath('/dashboard/%E0%A4%A')).toBe(true);
    expect(isDashboardPath('/dashboard/../x')).toBe(true);
    expect(isDashboardPath('/')).toBe(false);
    expect(isDashboardPath('/dashboards')).toBe(false);
    expect(isDashboardPath('/_next/static/x.js')).toBe(false);
  });
});

describe('the buttons of the dashboard', () => {
  it('staffCan(): the roles of each action, and nobody else', () => {
    expect(staffCan('DISPATCHER', 'changeTicket')).toBe(true);
    expect(staffCan('DISPATCHER', 'assignTicket')).toBe(true);
    expect(staffCan('ADMIN', 'assignTicket')).toBe(true);
    expect(staffCan('SUPER_ADMIN', 'changeTicket')).toBe(true);
    // Support reads the list; giving a job or moving its status is the dispatcher's (the admin routes never let support).
    expect(staffCan('SUPPORT', 'changeTicket')).toBe(false);
    expect(staffCan('SUPPORT', 'assignTicket')).toBe(false);
    expect(staffCan('ACCOUNTANT', 'changeTicket')).toBe(false);
    expect(staffCan('ACCOUNTANT', 'assignTicket')).toBe(false);
    expect(staffCan('SUPPORT', 'verifyDocument')).toBe(true);
    expect(staffCan('SUPPORT', 'decideApplication')).toBe(false);
    expect(staffCan('DISPATCHER', 'decideApplication')).toBe(false);
    expect(staffCan('ADMIN', 'decideApplication')).toBe(true);
    expect(staffCan('SUPER_ADMIN', 'inviteTechnician')).toBe(true);
    expect(staffCan('DISPATCHER', 'inviteTechnician')).toBe(false);
    expect(staffCan('DISPATCHER', 'manageTechnician')).toBe(false);
    expect(staffCan('CLIENT', 'changeTicket')).toBe(false);
    expect(staffCan(undefined, 'reviewProof')).toBe(false);
  });
});

describe('the table against the routes of the API', () => {
  it('knows the routes the tests below depend on (the scan finds the controllers)', () => {
    expect(API.size).toBeGreaterThan(40);
    expect(API.get(routeKey('PATCH', '/admin/artisans/:profileId/approve'))?.roles).toEqual(['ADMIN', 'SUPER_ADMIN']);
    expect(API.get(routeKey('GET', '/users/profile'))?.roles).toBeNull();
    // The route that answers differently by role is not "ticket staff only": it lets everybody in.
    expect(API.get(routeKey('GET', '/interventions'))?.how).toBe('in-code');
    expect(API.get(routeKey('GET', '/interventions/dashboard/stats'))?.how).toBe('ticket-staff');
  });

  it('every route of the five controllers that names roles is backed by RolesGuard (@Roles alone enforces nothing)', () => {
    const unenforced = [...API.entries()].filter(([, route]) => !route.rolesEnforced).map(([key, route]) => `${key} (${route.guards.join(', ') || 'no guard'})`);

    expect(unenforced).toEqual([]);
  });

  for (const [key, served] of Object.entries(SERVED)) {
    it(`${key}: no @Roles, and the route (or its service) still shows the check that serves ${served.roles.length} roles (${served.because})`, () => {
      const route = API.get(key);

      expect(route).toBeDefined();
      expect(route?.roles).toBeNull();
      expect(served.evidence.test(route?.source ?? '')).toBe(true);

      if (served.service) {
        expect(served.service.evidence.test(MODULE_SOURCE(served.service.file))).toBe(true);
      }
    });
  }

  for (const page of DASHBOARD_PAGES) {
    it(`page ${page.id}: every call exists, and no role of the page is refused by one of them`, () => {
      expect(page.calls.length).toBeGreaterThan(0);

      for (const call of page.calls) {
        const roles = servedRoles(call);

        for (const role of page.roles) {
          expect(`${role} -> ${call.method} ${call.path}: ${roles.includes(role)}`).toBe(`${role} -> ${call.method} ${call.path}: true`);
        }
      }
    });

    for (const call of page.calls.filter((candidate) => candidate.only)) {
      it(`page ${page.id}: ${call.method} ${call.path} is for this page alone (exactly its roles, no other staff role)`, () => {
        const route = routeOf(call);

        expect(route.roles).not.toBeNull();
        expect(sorted(staffOnly(route.roles ?? []))).toEqual(sorted(page.roles));
      });
    }
  }

  it('the frame of every page (who is signed in) is served to all five staff roles', () => {
    expect(DASHBOARD_SHELL_CALLS.length).toBeGreaterThan(0);

    for (const call of DASHBOARD_SHELL_CALLS) {
      const roles = servedRoles(call);

      for (const role of STAFF_ROLES) {
        expect(`${role} -> ${call.method} ${call.path}: ${roles.includes(role)}`).toBe(`${role} -> ${call.method} ${call.path}: true`);
      }
    }
  });

  for (const action of STAFF_ACTIONS) {
    it(`action ${action.id}: every call exists and accepts exactly the roles that are shown the button`, () => {
      expect(action.calls.length).toBeGreaterThan(0);

      for (const call of action.calls) {
        // A button must be backed by a rule: a route open to every signed-in account would show it to all.
        // A route that decides in code says who it serves in SERVED.
        const roles = servedRoles(call);

        expect(sorted(staffOnly(roles))).toEqual(sorted([...action.roles, ...(action.alsoServed ?? [])]));
      }
    });
  }

  it('a role that is served the calls of a button without being shown it is said so once, and is not also shown it (P2-09)', () => {
    const said = STAFF_ACTIONS.filter((action) => action.alsoServed !== undefined);

    expect(said.map((action) => action.id)).toEqual(['handleComplaint', 'moderateReview']);

    for (const action of said) {
      expect(action.alsoServed?.length).toBeGreaterThan(0);
      expect(new Set(action.alsoServed).size).toBe(action.alsoServed?.length);
      expect(action.roles.filter((role) => action.alsoServed?.includes(role))).toEqual([]);
    }
  });

  it('the roles of an action are within the pages that hold it (the page that shows the button is open to them)', () => {
    const placed: Record<string, string> = {
      assignTicket: 'interventions',
      changeTicket: 'interventions',
      addNote: 'interventions',
      reviewProof: 'interventions',
      verifyDocument: 'applications',
      decideApplication: 'applications',
      inviteTechnician: 'technicians',
      manageTechnician: 'technicians',
      handleComplaint: 'complaints',
      decideComplaintRefund: 'complaints',
      moderateReview: 'feedbacks',
      editCompany: 'company',
    };

    expect(Object.keys(placed).sort()).toEqual(STAFF_ACTIONS.map((action) => action.id).sort());

    for (const action of STAFF_ACTIONS) {
      const page = DASHBOARD_PAGES.find((candidate) => candidate.id === placed[action.id]);

      for (const role of action.roles) {
        expect(page?.roles).toContain(role);
      }
    }
  });

  it('the matching routes (who could take this job, and giving it to somebody) are for the roles that give jobs, no other staff role (P1-13)', () => {
    const matching = [...API.entries()].filter(([key]) => key.includes('/matching/'));

    expect(matching.map(([key]) => key).sort()).toEqual([
      'GET /matching/admin/artisans',
      'GET /matching/admin/interventions/:/artisans',
      'POST /matching/admin/interventions/:/assign-best',
      'POST /matching/admin/interventions/:/assign/:',
    ]);

    for (const [key, route] of matching) {
      expect(`${key}: ${sorted(route.roles ?? [])}`).toBe(`${key}: ADMIN,DISPATCHER,SUPER_ADMIN`);
      expect(route.rolesEnforced).toBe(true);
    }
  });

  it('the list of jobs is for the roles that work on jobs, and an accountant has no use for it (P1-13)', () => {
    expect(sorted(API.get(routeKey('GET', '/admin/interventions'))?.roles ?? [])).toEqual(['ADMIN', 'DISPATCHER', 'SUPER_ADMIN', 'SUPPORT']);
  });

  it('the interventions page reads a job from the case file route, not from the older route that returns the raw row (P1-14)', () => {
    const calls = DASHBOARD_PAGES.find((page) => page.id === 'interventions')?.calls.map((call) => `${call.method} ${call.path}`) ?? [];

    expect(calls).toContain('GET /admin/interventions/:id');
    expect(calls).not.toContain('GET /interventions/:id');
  });

  it('the case file of a job and the notes written on it are for the roles that work on jobs, and no other staff role (P1-14)', () => {
    for (const [method, path] of [
      ['GET', '/admin/interventions/:id'],
      ['POST', '/admin/interventions/:id/internal-notes'],
    ] as const) {
      const route = API.get(routeKey(method, path));

      expect(`${method} ${path}: ${sorted(route?.roles ?? [])}`).toBe(`${method} ${path}: ADMIN,DISPATCHER,SUPER_ADMIN,SUPPORT`);
      expect(route?.rolesEnforced).toBe(true);
    }
  });

  it('the status and cancel routes the buttons call are the dispatcher\'s, not support\'s (the older PATCH /interventions/:id is the one that lets support in)', () => {
    for (const path of ['/admin/interventions/:id/status', '/admin/interventions/:id/cancel', '/admin/interventions/:id/assign-artisan']) {
      expect(sorted(API.get(routeKey(path.endsWith('assign-artisan') ? 'POST' : 'PATCH', path))?.roles ?? [])).toEqual(['ADMIN', 'DISPATCHER', 'SUPER_ADMIN']);
    }
  });

  it('the reads of the applicants are marked as the applications page\'s alone (so the test above keeps other roles out of them)', () => {
    const applications = DASHBOARD_PAGES.find((page) => page.id === 'applications');

    expect(applications?.calls.map((call) => `${call.method} ${call.path} ${call.only === true}`)).toEqual([
      'GET /admin/artisans true',
      'GET /admin/artisans/:profileId true',
    ]);
  });

  it('ACCOUNTANT is served by no call of the pages but the finance console, the complaints, the company, her own profile and the frame (P2-08, P2-09)', () => {
    const hers = ['settings', 'finance', 'complaints', 'company'];

    // The moderation queue's read is the one exception: the service lets every staff role read reviews (SERVED says so), the
    // page is shown to three of them.
    const readsEveryStaffRole = 'GET /reviews/admin';

    for (const page of DASHBOARD_PAGES.filter((candidate) => !hers.includes(candidate.id))) {
      for (const call of page.calls.filter((candidate) => `${candidate.method} ${candidate.path}` !== readsEveryStaffRole)) {
        expect(servedRoles(call)).not.toContain('ACCOUNTANT');
      }
    }

    expect(servedRoles({ method: 'GET', path: '/reviews/admin' })).toEqual(STAFF_ROLES);
  });
});

describe('every controller of the server: @Roles is only worth something with RolesGuard', () => {
  const controllers: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
      else if (entry.name.endsWith('.controller.ts')) controllers.push(path.join(dir, entry.name));
    }
  };

  walk(MODULES);

  it('finds the controllers', () => {
    expect(controllers.length).toBeGreaterThan(15);
  });

  it('no route names roles without a RolesGuard on the class or on the method', () => {
    const unenforced: string[] = [];

    for (const file of controllers) {
      for (const route of scanController(fs.readFileSync(file, 'utf8'), TICKET_STAFF_ROLES)) {
        if (!route.rolesEnforced) unenforced.push(`${path.basename(file)}: ${route.method} ${route.path}`);
      }
    }

    expect(unenforced).toEqual([]);
  });
});

describe('the finance console in the table (P2-08)', () => {
  const finance = DASHBOARD_PAGES.find((page) => page.id === 'finance');

  it('is a page of the administrators and the accountant, and of nobody else', () => {
    expect([...(finance?.roles ?? [])].sort()).toEqual(['ACCOUNTANT', 'ADMIN', 'SUPER_ADMIN']);
    expect(finance?.path).toBe('/dashboard/finance');

    for (const role of ['ADMIN', 'SUPER_ADMIN', 'ACCOUNTANT']) expect(canOpenDashboardPath(role, '/dashboard/finance')).toBe(true);
    for (const role of ['SUPPORT', 'DISPATCHER', 'CLIENT', 'ARTISAN', null, undefined, '']) expect(canOpenDashboardPath(role, '/dashboard/finance')).toBe(false);
  });

  it('holds the pages under it: payments, invoices, refunds, payouts, cash', () => {
    for (const sub of ['payments', 'invoices', 'refunds', 'payouts', 'cash']) {
      expect(dashboardPageFor(`/dashboard/finance/${sub}`)?.id).toBe('finance');
      expect(canOpenDashboardPath('ACCOUNTANT', `/dashboard/finance/${sub}`)).toBe(true);
      expect(canOpenDashboardPath('SUPPORT', `/dashboard/finance/${sub}`)).toBe(false);
      expect(canOpenDashboardPath('DISPATCHER', `/dashboard/finance/${sub}`)).toBe(false);
    }

    expect(dashboardPageFor('/dashboard/financeur')).toBeUndefined();
    expect(dashboardPageFor('/dashboard/finance/../tickets')).toBeUndefined();
  });

  it('comes before the profile in the menu, after the pages of the work on jobs', () => {
    expect(dashboardPagesFor('ADMIN').map((page) => page.id)).toEqual(['overview', 'interventions', 'applications', 'technicians', 'feedbacks', 'finance', 'complaints', 'company', 'settings']);
  });

  it('reads with the five finance routes, each for the page\'s roles alone (a role that cannot open the page reads none of it)', () => {
    const reads = (finance?.calls ?? []).filter((call) => call.path.startsWith('/finance/'));

    expect(reads.map((call) => `${call.method} ${call.path}`).sort()).toEqual(['GET /finance/invoices', 'GET /finance/payments', 'GET /finance/payments/export', 'GET /finance/refunds-due', 'GET /finance/summary']);
    expect(reads.every((call) => call.only === true)).toBe(true);
  });

  it('reads the cash of the artisans from the ledger routes, which are for the same three roles', () => {
    for (const path of ['/cash-ledger/balances', '/cash-ledger/artisans/:artisanId']) {
      const call = finance?.calls.find((candidate) => candidate.path === path);

      expect(call?.only).toBe(true);
      expect(sorted(API.get(routeKey('GET', path))?.roles ?? [])).toEqual(['ACCOUNTANT', 'ADMIN', 'SUPER_ADMIN']);
    }
  });

  it('calls the writes the buttons need, each served to all three roles', () => {
    const writes = (finance?.calls ?? []).filter((call) => call.method !== 'GET').map((call) => `${call.method} ${call.path}`);

    expect(writes.sort()).toEqual([
      'PATCH /business/payouts/:payoutId/cancel',
      'PATCH /business/payouts/:payoutId/paid',
      'PATCH /payments/:paymentId/cancel',
      'PATCH /payments/:paymentId/confirm',
      'PATCH /payments/:paymentId/fail',
      'PATCH /payments/:paymentId/refund',
      'POST /business/payouts',
      'POST /cash-ledger/artisans/:artisanId/remittances',
      'POST /invoices/:invoiceId/credit-notes',
    ]);
  });

  it('refunds and credit notes are the finance roles\' alone: support and dispatch cannot give money back', () => {
    for (const [method, path] of [
      ['PATCH', '/payments/:paymentId/refund'],
      ['POST', '/invoices/:invoiceId/credit-notes'],
      ['POST', '/cash-ledger/artisans/:artisanId/remittances'],
    ] as const) {
      expect(sorted(API.get(routeKey(method, path))?.roles ?? [])).toEqual(['ACCOUNTANT', 'ADMIN', 'SUPER_ADMIN']);
    }
  });

  it('the payout routes serve every staff role (the service accepts any of the five): a fact the table states, not a choice it makes', () => {
    const service = MODULE_SOURCE('business/business.service.ts');

    expect(/private isStaff\(role: Role\): boolean \{\s*const staffRoles: Role\[\] = \[\s*Role\.ADMIN,\s*Role\.SUPER_ADMIN,\s*Role\.SUPPORT,\s*Role\.DISPATCHER,\s*Role\.ACCOUNTANT,\s*\];/.test(service)).toBe(true);
  });
});

describe('the complaints, the reviews and the company in the table (P2-09)', () => {
  const page = (id: string) => DASHBOARD_PAGES.find((candidate) => candidate.id === id);
  const action = (id: string) => STAFF_ACTIONS.find((candidate) => candidate.id === id);

  it('Réclamations is open to the team that runs complaints and to the accountant, and not to dispatch', () => {
    expect([...(page('complaints')?.roles ?? [])].sort()).toEqual(['ACCOUNTANT', 'ADMIN', 'SUPER_ADMIN', 'SUPPORT']);
    expect(page('complaints')?.path).toBe('/dashboard/complaints');

    for (const role of ['ADMIN', 'SUPER_ADMIN', 'SUPPORT', 'ACCOUNTANT']) {
      expect(canOpenDashboardPath(role, '/dashboard/complaints')).toBe(true);
      expect(canOpenDashboardPath(role, '/dashboard/complaints/12')).toBe(true);
    }

    for (const role of ['DISPATCHER', 'CLIENT', 'ARTISAN', null, undefined, '']) {
      expect(canOpenDashboardPath(role, '/dashboard/complaints')).toBe(false);
      expect(canOpenDashboardPath(role, '/dashboard/complaints/12')).toBe(false);
    }

    expect(dashboardPageFor('/dashboard/complaintsx')).toBeUndefined();
  });

  it('Entreprise is the administrators\' to change and the accountant\'s to read; support and dispatch have no use for it', () => {
    expect([...(page('company')?.roles ?? [])].sort()).toEqual(['ACCOUNTANT', 'ADMIN', 'SUPER_ADMIN']);
    expect(canOpenDashboardPath('SUPPORT', '/dashboard/company')).toBe(false);
    expect(canOpenDashboardPath('DISPATCHER', '/dashboard/company')).toBe(false);
    expect(canOpenDashboardPath('ACCOUNTANT', '/dashboard/company')).toBe(true);

    expect(staffCan('ADMIN', 'editCompany')).toBe(true);
    expect(staffCan('SUPER_ADMIN', 'editCompany')).toBe(true);
    expect(staffCan('ACCOUNTANT', 'editCompany')).toBe(false);
    expect(staffCan('SUPPORT', 'editCompany')).toBe(false);
    expect(sorted(API.get(routeKey('PATCH', '/admin/settings/company'))?.roles ?? [])).toEqual(['ADMIN', 'SUPER_ADMIN']);
  });

  it('the reads of the complaints and of the company are served to the roles of their page and to no other', () => {
    expect(sorted(API.get(routeKey('GET', '/admin/complaints'))?.roles ?? [])).toEqual(['ACCOUNTANT', 'ADMIN', 'SUPER_ADMIN', 'SUPPORT']);
    expect(sorted(API.get(routeKey('GET', '/admin/complaints/:complaintId'))?.roles ?? [])).toEqual(['ACCOUNTANT', 'ADMIN', 'SUPER_ADMIN', 'SUPPORT']);
    expect(sorted(API.get(routeKey('GET', '/admin/settings/company'))?.roles ?? [])).toEqual(['ACCOUNTANT', 'ADMIN', 'SUPER_ADMIN']);

    // What the page table says is what the route answers: a dispatcher's hand-made request is refused, not served.
    expect(sorted(page('complaints')?.roles ?? [])).toEqual(sorted(API.get(routeKey('GET', '/admin/complaints'))?.roles ?? []));
    expect(sorted(page('company')?.roles ?? [])).toEqual(sorted(API.get(routeKey('GET', '/admin/settings/company'))?.roles ?? []));
  });

  it('"Avis & Retours" keeps its roles and reads the moderation queue, no longer the star ratings of the jobs', () => {
    expect([...(page('feedbacks')?.roles ?? [])].sort()).toEqual(['ADMIN', 'SUPER_ADMIN', 'SUPPORT']);
    expect(page('feedbacks')?.calls.map((call) => `${call.method} ${call.path}`)).toEqual(['GET /reviews/admin']);
  });

  it('the buttons: support runs a complaint and moderates, the accountant decides refunds, nobody else does either', () => {
    expect(staffCan('SUPPORT', 'handleComplaint')).toBe(true);
    expect(staffCan('ADMIN', 'handleComplaint')).toBe(true);
    expect(staffCan('ACCOUNTANT', 'handleComplaint')).toBe(false);
    expect(staffCan('DISPATCHER', 'handleComplaint')).toBe(false);

    expect(staffCan('ACCOUNTANT', 'decideComplaintRefund')).toBe(true);
    expect(staffCan('ADMIN', 'decideComplaintRefund')).toBe(true);
    expect(staffCan('SUPPORT', 'decideComplaintRefund')).toBe(false);
    expect(staffCan('DISPATCHER', 'decideComplaintRefund')).toBe(false);

    expect(staffCan('SUPPORT', 'moderateReview')).toBe(true);
    expect(staffCan('SUPER_ADMIN', 'moderateReview')).toBe(true);
    expect(staffCan('ACCOUNTANT', 'moderateReview')).toBe(false);
    expect(staffCan('DISPATCHER', 'moderateReview')).toBe(false);
  });

  it('says plainly that the dispatcher and the accountant could still call the routes of a complaint and of a review by hand', () => {
    expect(action('handleComplaint')?.alsoServed).toEqual(['DISPATCHER', 'ACCOUNTANT']);
    expect(action('moderateReview')?.alsoServed).toEqual(['DISPATCHER', 'ACCOUNTANT']);
    expect(action('decideComplaintRefund')?.alsoServed).toBeUndefined();
    expect(action('editCompany')?.alsoServed).toBeUndefined();
  });

  it('a refund on a complaint is decided on the route that is the finance roles\' alone, and no older route is offered', () => {
    expect(sorted(API.get(routeKey('PATCH', '/admin/complaints/:complaintId/refund'))?.roles ?? [])).toEqual(['ACCOUNTANT', 'ADMIN', 'SUPER_ADMIN']);

    const calls = STAFF_ACTIONS.flatMap((candidate) => candidate.calls).map((call) => `${call.method} ${call.path}`);

    for (const older of ['PATCH /complaints/admin/:complaintId/refund', 'PATCH /complaints/admin/:complaintId/decision']) {
      expect(calls).not.toContain(older);
    }
  });

  it('the screens read the complaint list and case from the back-office routes, not from the older customer-facing ones', () => {
    const calls = (page('complaints')?.calls ?? []).map((call) => `${call.method} ${call.path}`);

    expect(calls).toContain('GET /admin/complaints');
    expect(calls).toContain('GET /admin/complaints/:complaintId');
    expect(calls).toContain('GET /users');
    expect(calls).not.toContain('GET /complaints/admin');
    expect(calls).not.toContain('GET /complaints/:complaintId');
  });
});
