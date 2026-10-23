import { attempt, changedRows, runScenario, runSelf } from './access-matrix';
import { SCENARIOS, SELF_SCENARIOS } from './access/all';
import { buildWorld } from './world';

/**
 * The second line (P1-17). `access-matrix.spec.ts` asks the roles of the route first, as the application does, so a
 * service that trusts its `@Roles` is never tried. Here the roles are not asked, as if somebody had taken the `@Roles`
 * off a controller by mistake, and every customer and artisan that a scenario does not name must still be turned away by
 * the service itself: the other household's, and the one of the wrong kind (the artisan on a customer's route, the
 * customer on an artisan's, the customer on a staff route). Taking one check out of a service, or one `@Roles` off a
 * controller, is then not enough to open a route.
 *
 * Not tried: the staff roles (the door is their line on most routes, and `route-inventory.spec.ts` runs the real
 * guard for every route and every one of the seven roles), and the few services that do not look at the caller's role
 * and rely on the door alone, named below with the reason.
 */
const DOOR_ONLY: Record<string, string> = {
  'GET /users/:': 'the users service reads an account for whoever asks: the back office is the door',
  'GET /users': 'the same, a list of accounts',
  'GET /users/artisans': 'the same, the list of artisans for the dispatcher',
};

/** The services of the admin controller never look at the role of the caller: the door (`@Roles` on the controller) is their only line. */
const isDoorOnly = (route: string) => route in DOOR_ONLY || /^[A-Z]+ \/admin(\/|$)/.test(route);

const TRIED = SCENARIOS.map((scenario, at) => ({ scenario, at })).filter(({ scenario }) => !scenario.gateOnly && !isDoorOnly(scenario.route));
const PARTIES = ['client', 'artisan', 'artisans'];

describe('with the roles of the route not asked, the service still turns away the wrong customer and the wrong artisan (P1-17)', () => {
  it('almost every route of the matrix is tried, and the ones that are left out are named', () => {
    expect(TRIED.length).toBeGreaterThan(SCENARIOS.length * 0.8);
    expect(SCENARIOS.filter((scenario) => isDoorOnly(scenario.route)).length).toBeGreaterThan(10);

    for (const route of Object.keys(DOOR_ONLY)) expect(SCENARIOS.map((scenario) => scenario.route)).toContain(route);
  });

  TRIED.forEach(({ scenario, at }) => {
    it(`${scenario.route} #${at}${scenario.note ? ` (${scenario.note})` : ''}`, async () => {
      expect(await runScenario(scenario, { doorOpen: true })).toEqual([]);
    });
  });
});

/**
 * Routes that serve the caller and rely on the door for the kind of caller, because what they do is harmless whoever calls:
 * they write the caller's own row and nothing else.
 */
const DOOR_ONLY_SELF = {
  'PATCH /users/location': 'the artisan app sends the position of the phone; a customer who set their own coordinates through it (the roles of the route keep them out) would change nothing of anybody else\'s',
} as Record<string, string>;

/** The routes that serve the caller (their own account, their own list): the ones that name a customer or an artisan among those served. */
const SHARED_SELF = SELF_SCENARIOS.map((scenario, at) => ({ scenario, at })).filter(({ scenario }) => (scenario.servedRoles ?? []).some((role) => role === 'CLIENT' || role === 'ARTISAN') && !DOOR_ONLY_SELF[scenario.route]);

describe('the same for the routes that serve the caller (P1-17)', () => {
  it('there are some, and the routes left out are real routes of the matrix', () => {
    expect(SHARED_SELF.length).toBeGreaterThan(10);

    for (const route of Object.keys(DOOR_ONLY_SELF)) expect(SELF_SCENARIOS.map((scenario) => scenario.route)).toContain(route);
  });

  SHARED_SELF.forEach(({ scenario, at }) => {
    it(`${scenario.route} #${at}${scenario.note ? ` (${scenario.note})` : ''}`, async () => {
      expect(await runSelf(scenario, { doorOpen: true })).toEqual([]);
    });
  });
});

describe('the second line is really tried (controls)', () => {
  it('a route that only the door protects serves the customer when the door is open', async () => {
    const adminOnly = SCENARIOS.find((scenario) => scenario.route === 'GET /admin/clients/:' && !scenario.allowed.some((party) => PARTIES.includes(party)));

    expect(adminOnly).toBeDefined();
    expect((await runScenario(adminOnly!)).join('\n')).toBe('');

    const problems = await runScenario(adminOnly!, { doorOpen: true });

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toContain('clientA');
  });

  it('with the door open, a scenario that names too few people is caught', async () => {
    const shared = TRIED.find(({ scenario }) => scenario.route === 'GET /interventions/:' && !scenario.prepare)!.scenario;
    const problems = await runScenario({ ...shared, allowed: ['ticketStaff'] }, { doorOpen: true });

    expect(problems.join('\n')).toContain('clientA');
  });
});

/**
 * The routes that only the back office may call and that have no scenario (nothing of a household is served): the door is
 * their first line, `route-inventory.spec.ts` runs the real guard for every role, and the service is the second. A customer or an
 * artisan who got past the door (the customer is the owner of the invoice, the artisan the artisan of its job) must still be
 * turned away by the service itself, and must leave nothing behind: no row changed, nothing sent.
 */
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
const BACK_OFFICE_ONLY: Array<{ route: string; what: string; request: (ids: Record<string, number>) => Record<string, unknown> }> = [
  { route: 'POST /invoices/generate', what: 'issuing the invoice of a job', request: (ids) => ({ body: { interventionId: ids.intervention, amountHT: 100 } }) },
  { route: 'PATCH /invoices/:/pdf', what: 'setting the address of the PDF of an invoice', request: (ids) => ({ params: { invoiceId: ids.invoice }, body: { pdfUrl: 'https://example.test/invoice.pdf' } }) },
  { route: 'POST /invoices/:/send-email', what: 'sending an invoice by e-mail', request: (ids) => ({ params: { invoiceId: ids.invoice }, body: {} }) },
  { route: 'PATCH /invoices/:/cancel', what: 'cancelling an invoice', request: (ids) => ({ params: { invoiceId: ids.invoice }, body: { reason: 'no' } }) },
  { route: 'GET /invoices/export', what: 'the export of every invoice', request: () => ({ query: {} }) },
  { route: 'POST /files/invoices/:/pdf', what: 'putting a PDF on an invoice', request: (ids) => ({ params: { invoiceId: ids.invoice }, file: { fieldname: 'file', originalname: 'facture.pdf', mimetype: 'application/pdf', size: PDF.length, buffer: PDF } }) },
  { route: 'PATCH /files/:/visibility', what: 'making a file public', request: (ids) => ({ params: { fileId: ids.damagePhoto }, body: { visibility: 'PUBLIC' } }) },
];

describe('the back office routes without a scenario: the service is the second line (P1-17)', () => {
  for (const { route, what, request } of BACK_OFFICE_ONLY) {
    for (const who of ['clientA', 'artisanA', 'clientB', 'artisanB']) {
      it(`${route} (${what}) with the door open: ${who} is refused by the service and nothing changes`, async () => {
        const w = buildWorld();
        const before = w.memory.snapshot();
        const outcome = await attempt(w, w.people[who], route, request(w.ids.A) as any, { doorOpen: true });

        expect(outcome.ok).toBe(false);
        expect(outcome.status).toBe(403);
        expect(changedRows(before, w.memory.snapshot())).toEqual([]);
        expect(w.sink.filter((call) => !call.startsWith('rateLimit'))).toEqual([]);
      });
    }

    it(`${route}: the control, an administrator is not turned away by the service`, async () => {
      const w = buildWorld();
      const outcome = await attempt(w, w.people.admin, route, request(w.ids.A) as any, { doorOpen: true });

      expect(outcome.status).not.toBe(403);
    });
  }
});

/**
 * The same for the routes whose scenario is only a gate (a payout, an export, the dispatcher's tools): they are not run again above
 * because what is behind the gate needs more set-up than is worth building. A customer or an artisan, with the door open, must
 * still be turned away by the service with a 403, and leave nothing behind.
 */
const GATES = SCENARIOS.filter((scenario) => scenario.gateOnly && !isDoorOnly(scenario.route));

describe('the gate-only routes: the service is the second line (P1-17)', () => {
  it('there are some', () => {
    expect(GATES.length).toBeGreaterThanOrEqual(9);
  });

  GATES.forEach((scenario) => {
    for (const who of ['clientA', 'artisanA', 'clientB', 'artisanB']) {
      it(`${scenario.route}: with the door open, ${who} gets a 403 from the service and nothing changes`, async () => {
        const w = buildWorld();

        scenario.prepare?.(w);

        const request = await scenario.request('A', w);
        const base = w.memory.snapshot();
        const outcome = await attempt(w, w.people[who], scenario.route, request, { doorOpen: true });

        expect(outcome.ok).toBe(false);
        expect(outcome.status).toBe(403);
        expect(changedRows(base, w.memory.snapshot())).toEqual([]);
        expect(w.sink.filter((call) => !call.startsWith('rateLimit'))).toEqual([]);
      });
    }
  });
});
