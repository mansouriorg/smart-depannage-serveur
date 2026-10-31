import { TICKET_STAFF_ROLES } from '../../common/auth/role-policy';
import { ROUTE_ACCESS } from '../../common/testing/route-access.golden';
import { routeKey, scanController } from '../../common/testing/route-roles';
import { listSourceFiles, readSource, stripComments } from '../../common/testing/source-scan';

/**
 * The legacy routes (P3-03). The first version of the API was copied by newer routes while the three screens (the website, the
 * dashboard, the phone app) were moved over one by one (P1-13 to P1-16). This ticket deleted the older copy of every route that no
 * screen calls any more, and kept the seven that one still does. Two lists keep that decision in the code:
 *
 *  - DELETED: routes that must stay absent, each with the route that answers in its place. Adding one back is a decision of its own;
 *  - KEPT: the routes a screen still calls, each with the screen and what it has to move to before the route is deleted.
 *
 * Delete a KEPT route only after its screen has moved (read the access log for a week, as the ticket says), and move it to DELETED in
 * the same commit. `route-access.spec.ts` (the table of who may call each route) and `audit-actions.spec.ts` (the audit list) follow
 * the controllers on their own; this spec says WHY the list is what it is.
 */

const DELETED: Record<string, string> = {
  // the interventions controller
  'POST /interventions': 'the website request form: POST /guest/interventions; a signed-in customer: POST /client/interventions',
  'GET /interventions': 'the customer: GET /client/interventions; the back office: GET /admin/interventions; the technician: GET /artisans/me/missions',
  'GET /interventions/:': 'the customer: GET /client/interventions/:; the back office: GET /admin/interventions/:',
  'PATCH /interventions/:': 'assigning: POST /admin/interventions/:/assign-artisan; the steps of the road: /artisans/me/missions/:/...; the status: PATCH /interventions/:/workflow/status',
  'GET /interventions/track/:': 'GET /guest/tracking/:',
  'PATCH /interventions/track/:/feedback': 'POST /guest/interventions/:/feedback',
  'POST /interventions/track/:/issue': 'POST /guest/interventions/:/problems',
  'GET /interventions/public/:/timeline': 'GET /guest/tracking/:, which carries the lines of the timeline meant for the customer',
  // the client interventions controller
  'GET /public/tracking/:': 'GET /guest/tracking/:',
  // the complaints controller
  'GET /complaints/admin': 'GET /admin/complaints',
  'GET /complaints/admin/dashboard': 'GET /admin/complaints and GET /admin/dashboard/kpis',
  // The old decision recorded a verdict word, asked for a refund and closed the complaint in one call, and told the complainant. The
  // routes below each do a part of it; none records the verdict word (Complaint.adminDecision is no longer written) and the refund
  // route does not tell the complainant (the old one did).
  'PATCH /complaints/admin/:/decision': 'PATCH /admin/complaints/:/refund for the money, PATCH /admin/complaints/:/close to close it; nothing records the verdict word any more',
  'PATCH /complaints/admin/:/refund': 'PATCH /admin/complaints/:/refund, which does not tell the complainant',
  // the notification preferences (a module of its own)
  'GET /notification-preferences/me': 'GET /notifications/preferences/me',
  'PATCH /notification-preferences/me': 'PATCH /notifications/preferences/me',
  // the internal notes of the messages controller
  'POST /messages/admin-notes/interventions/:': 'POST /admin/interventions/:/internal-notes (the same table; the accountant, who could write here, is refused there)',
  'GET /messages/admin-notes/interventions/:': 'the case file: GET /admin/interventions/:, which lists the notes',
  'DELETE /messages/admin-notes/:': 'nothing: a note can no longer be deleted through the API',
  // the service catalogue
  'GET /services/admin': 'GET /services/admin/categories?includeInactive=true (the old route always listed the inactive ones) and GET /services/admin/sub-services',
  'POST /services/categories': 'POST /services/admin/categories',
  'POST /services/sub-services': 'POST /services/admin/sub-services',
  'PATCH /services/sub-services/:': 'PATCH /services/admin/sub-services/:',
  'DELETE /services/sub-services/:': 'PATCH /services/admin/sub-services/:/deactivate (the old route only deactivated); DELETE /services/admin/sub-services/: deletes one that no job uses',
};

/** Routes a screen still calls: the screen, and what it has to move to before the route can go. */
const KEPT: Record<string, { file: string; screen: string; movesTo: string; doc?: string }> = {
  'POST /interventions/secure': {
    doc: 'POST /interventions/secure',
    file: 'modules/interventions/interventions.controller.ts',
    screen: 'dashboard, "create a ticket"',
    movesTo: 'a back-office route for creating a ticket on behalf of a customer (none exists yet)',
  },
  'GET /interventions/assigned': {
    doc: 'GET /interventions/assigned',
    file: 'modules/interventions/interventions.controller.ts',
    screen: 'phone app, home and missions tabs',
    movesTo: 'GET /artisans/me/missions (another answer: the mission board)',
  },
  'GET /interventions/dashboard/stats': {
    doc: 'GET /interventions/dashboard/stats',
    file: 'modules/interventions/interventions.controller.ts',
    screen: 'dashboard home',
    movesTo: 'GET /admin/dashboard/kpis (another answer)',
  },
  'POST /interventions/:/complete-work': {
    doc: 'POST /interventions/:id/complete-work',
    file: 'modules/interventions/interventions.controller.ts',
    screen: 'phone app, finish the job with a photo',
    movesTo: 'POST /interventions/:/proofs/after, then PATCH /artisans/me/missions/:/complete (two calls)',
  },
  'PATCH /complaints/admin/:/assign': {
    file: 'modules/complaints/complaints.controller.ts',
    screen: 'dashboard, complaints page (through the shared client)',
    movesTo: 'PATCH /admin/complaints/:/assign',
  },
  'PATCH /complaints/admin/:/status': {
    file: 'modules/complaints/complaints.controller.ts',
    screen: 'dashboard, complaints page (through the shared client)',
    movesTo: 'PATCH /admin/complaints/:/status',
  },
  'PATCH /complaints/admin/:/resolve': {
    file: 'modules/complaints/complaints.controller.ts',
    screen: 'dashboard, complaints page (through the shared client)',
    movesTo: 'PATCH /admin/complaints/:/close',
  },
};

const routesOf = (file: string): string[] => scanController(readSource(file), TICKET_STAFF_ROLES).map((route) => routeKey(route.method, route.path));

// The keys are lower case: the server matches a path without looking at the case, so `@Get('Track/:id')` would bring a deleted route back.
const lower = (key: string) => key.toLowerCase();
const ALL = new Map<string, string[]>();

for (const file of listSourceFiles().filter((name) => name.endsWith('.controller.ts'))) {
  for (const key of routesOf(file)) ALL.set(lower(key), [...(ALL.get(lower(key)) ?? []), file]);
}

describe('the legacy routes that were deleted stay deleted (P3-03)', () => {
  it('the scan finds the controllers, and the list is not empty', () => {
    // the table of who may call each route is made from the same controllers: the two counts are one
    expect(ALL.size).toBe(Object.keys(ROUTE_ACCESS).length);
    expect(Object.keys(DELETED).length).toBe(23);
  });

  it.each(Object.keys(DELETED))('%s is not a route of any controller', (key) => {
    expect([key, ALL.get(lower(key)) ?? []]).toEqual([key, []]);
  });

  it('every deleted route says what answers in its place (a real route, or a reason there is none)', () => {
    for (const [key, replacement] of Object.entries(DELETED)) {
      expect([key, replacement.length > 10]).toEqual([key, true]);
    }

    // The replacements that name a route are routes of today.
    const named = Object.values(DELETED).flatMap((text) => [...text.matchAll(/\b(GET|POST|PATCH|DELETE) (\/[A-Za-z0-9/:_-]+)/g)].map((match) => `${match[1]} ${match[2].replace(/:[A-Za-z]+/g, ':')}`));

    expect(named.length).toBeGreaterThan(15);
    expect(named.filter((key) => !ALL.has(lower(key)))).toEqual([]);
  });

  it('a deleted path answers 404, except one that another route takes for an id: GET /complaints/admin is read by GET /complaints/:id and answers 400', () => {
    const segments = (key: string) => key.split(' ')[1].split('/');
    const captured = Object.keys(DELETED).filter((key) =>
      [...ALL.keys()].some((route) => {
        const gone = segments(lower(key));
        const there = segments(route);

        return (
          route.split(' ')[0] === key.split(' ')[0].toLowerCase() &&
          gone.length === there.length &&
          gone.every((part, index) => (there[index].startsWith(':') ? true : !part.startsWith(':') && part === there[index]))
        );
      }),
    );

    expect(captured).toEqual(['GET /complaints/admin']);
  });

  it('the files of the deleted code are gone: the notification preferences module, the forms of the deleted routes', () => {
    const files = listSourceFiles();

    expect(files.filter((file) => file.startsWith('modules/notification-preferences/'))).toEqual([]);

    for (const file of [
      'modules/interventions/dto/update-intervention.dto.ts',
      'modules/interventions/dto/submit-feedback.dto.ts',
      'modules/interventions/dto/report-issue.dto.ts',
      'modules/intervention-workflow/dto/public-timeline-query.dto.ts',
    ]) {
      expect([file, files.includes(file)]).toEqual([file, false]);
    }

    expect(stripComments(readSource('app.module.ts'))).not.toMatch(/NotificationPreferences|notification-preferences/);
  });

  it('the methods of the deleted routes are gone from the services', () => {
    const gone: Record<string, string[]> = {
      'modules/interventions/interventions.service.ts': ['findAll', 'findByUser', 'findAllPending', 'findOne', 'findOneForActor', 'update', 'updateAsArtisan', 'findByTrackingToken', 'submitFeedback', 'reportActiveIssue'],
      'modules/client-interventions/client-interventions.service.ts': ['publicTracking'],
      'modules/intervention-workflow/intervention-workflow.service.ts': ['getPublicTimeline'],
      'modules/complaints/complaints.service.ts': ['adminDashboard', 'adminDecision', 'refundDecision', 'adminFindAll'],
      'modules/service-catalog/service-catalog.service.ts': ['removeSubService'],
    };

    for (const [file, names] of Object.entries(gone)) {
      const text = stripComments(readSource(file));

      for (const name of names) expect([file, name, new RegExp(`\\basync ${name}\\s*\\(`).test(text)]).toEqual([file, name, false]);
    }
  });
});

describe('the legacy routes that a screen still calls are still there, and say which screen (P3-03)', () => {
  it.each(Object.keys(KEPT))('%s is a route of its controller', (key) => {
    expect([key, ALL.get(lower(key))]).toEqual([key, [KEPT[key].file]]);
  });

  it('the interventions controller holds these four routes and no other; the complaints controller holds these three under /complaints/admin', () => {
    expect(routesOf('modules/interventions/interventions.controller.ts').sort()).toEqual(Object.keys(KEPT).filter((key) => key.includes('/interventions/')).sort());
    expect(routesOf('modules/complaints/complaints.controller.ts').filter((key) => key.includes('/complaints/admin/')).sort()).toEqual(
      Object.keys(KEPT).filter((key) => key.includes('/complaints/admin/')).sort(),
    );
  });

  it('the header of the interventions controller lists each of the four, with the screen, so that the list is read where the routes are', () => {
    const header = readSource('modules/interventions/interventions.controller.ts').split('@Controller')[0].replace(/[\s*]+/g, ' ');
    const listed = Object.entries(KEPT).filter(([, kept]) => kept.doc !== undefined);

    expect(listed.length).toBe(4);

    for (const [key, kept] of listed) {
      expect([key, header.includes(kept.doc as string)]).toEqual([key, true]);
      expect([key, header.includes(kept.screen)]).toEqual([key, true]);
    }
  });

  it('a kept route has not been left without a reason: each says what its screen moves to', () => {
    for (const [key, kept] of Object.entries(KEPT)) {
      expect([key, kept.movesTo.length > 10 && kept.screen.length > 5]).toEqual([key, true]);
    }
  });
});

describe('the alias of the first strategy is gone (P3-03)', () => {
  it('the signed-in user carries `id`, not `userId`, and nothing reads `userId` from the request', () => {
    expect(stripComments(readSource('modules/auth/strategies/jwt.strategy.ts'))).not.toMatch(/\buserId\b/);
    expect(stripComments(readSource('modules/auth/types/authenticated-user.type.ts'))).not.toMatch(/\buserId\b/);

    // a read as a property, as a bracket (`user['userId']`), by the decorator that reads a field by name, or by taking it apart
    const reads = [
      /\b(?:req|request)\.user\??\.userId\b/,
      /\buser\??\.userId\b/,
      /\buser\??\[\s*['"`]userId['"`]\s*\]/,
      /\bCurrentUser\(\s*['"`]userId['"`]/,
      /\{[^}]*\buserId\b[^}]*\}\s*=\s*(?:req|request)\.user\b/,
    ];
    const readers = listSourceFiles().filter((file) => reads.some((read) => read.test(stripComments(readSource(file)))));

    expect(readers).toEqual([]);
  });
});
