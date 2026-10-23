import { attempt, changedRows } from './access-matrix';
import { SCENARIOS } from './access/all';
import { buildWorld } from './world';

/**
 * The right person in the wrong state (P1-17). The matrix tries people who are not meant to be served; this file tries
 * people who were, and are not any more: an artisan whose profile is not approved (or no longer), and the artisan
 * who wrote a complaint on a job that was then given to somebody else.
 */
const NOT_APPROVED = ['DRAFT', 'PENDING_REVIEW', 'REJECTED', 'SUSPENDED'];
const MISSIONS = SCENARIOS.filter((scenario) => scenario.route.includes('/artisans/me/missions/:') && scenario.allowed.includes('artisan'));

describe('an artisan whose profile is not approved is turned away from every mission (P1-17)', () => {
  it('the control: all of the mission routes are there, and an approved artisan is served on each', async () => {
    expect(MISSIONS.length).toBeGreaterThanOrEqual(14);

    for (const scenario of MISSIONS) {
      const w = buildWorld();

      scenario.prepare?.(w);

      const outcome = await attempt(w, w.people.artisanA, scenario.route, await scenario.request('A', w));

      expect(outcome.ok).toBe(true);
    }
  });

  MISSIONS.forEach((scenario) => {
    it(`${scenario.route}: a 403 that says the profile must be approved, whatever its state, and no row changes`, async () => {
      for (const verificationStatus of NOT_APPROVED) {
        const w = buildWorld();

        scenario.prepare?.(w);
        w.set('artisanProfile', { verificationStatus });

        const base = w.memory.snapshot();
        const outcome = await attempt(w, w.people.artisanA, scenario.route, await scenario.request('A', w));

        expect(`${verificationStatus}: ${outcome.status}`).toBe(`${verificationStatus}: 403`);
        expect(String(outcome.error?.message)).toMatch(/approuvé/);
        expect(changedRows(base, w.memory.snapshot())).toEqual([]);
      }
    });
  });
});

describe('the artisan who wrote a complaint and was then taken off the job (P1-17)', () => {
  const ROUTE = 'POST /complaints/:/artisan-response';
  const scenario = SCENARIOS.find((entry) => entry.route === ROUTE)!;

  it('may still read the complaint they wrote, but cannot answer in the name of the artisan of the job', async () => {
    const w = buildWorld();

    // household A's job is with artisan A; the complaint on it was written by artisan B, who had the job before
    w.set('complaint', { userId: w.people.artisanB.id });

    const base = w.memory.snapshot();
    const request = await scenario.request('A', w);
    const refused = await attempt(w, w.people.artisanB, ROUTE, request);

    expect(refused.ok).toBe(false);
    expect(refused.status).toBe(403);
    expect(changedRows(base, w.memory.snapshot())).toEqual([]);

    const author = await attempt(w, w.people.artisanB, 'GET /complaints/:', { params: { complaintId: w.ids.A.complaint } });

    expect(author.ok).toBe(true);

    const assigned = await attempt(w, w.people.artisanA, ROUTE, request);

    expect(assigned.ok).toBe(true);
  });
});

/**
 * Who a complaint can be given to (P1-17): the staff who work on tickets, in a working account. A dispatcher who sends one to a
 * customer, an artisan, the accountant or a closed account would put the complaint (and the notification about it) in the wrong hands.
 */
describe('a complaint is assigned to staff who can take it, and to nobody else (P1-17)', () => {
  const ASSIGN = 'PATCH /complaints/admin/:/assign';
  const assign = async (to: (w: ReturnType<typeof buildWorld>) => number, tweak?: (w: ReturnType<typeof buildWorld>) => void) => {
    const w = buildWorld();

    tweak?.(w);

    const base = w.memory.snapshot();
    const outcome = await attempt(w, w.people.dispatcher, ASSIGN, { params: { complaintId: w.ids.A.complaint }, body: { assignedToId: to(w) } });

    return { w, base, outcome };
  };

  for (const who of ['support', 'dispatcher', 'admin', 'superAdmin']) {
    it(`the control: a ${who} takes it`, async () => {
      const { w, outcome } = await assign((world) => world.people[who].id);

      expect(outcome.ok).toBe(true);
      expect((w.memory.rows('complaint').find((row) => row.id === w.ids.A.complaint) as any).assignedToId).toBe(w.people[who].id);
    });
  }

  for (const who of ['clientA', 'artisanA', 'clientB', 'accountant']) {
    it(`${who} cannot be given the complaint: not found, nothing changes and nobody is told`, async () => {
      const { w, base, outcome } = await assign((world) => world.people[who].id);

      expect(outcome.ok).toBe(false);
      expect(outcome.status).toBe(404);
      expect(changedRows(base, w.memory.snapshot())).toEqual([]);
      expect(w.sink.filter((call) => !call.startsWith('rateLimit'))).toEqual([]);
    });
  }

  it('a closed account, or a deactivated one, cannot be given the complaint either', async () => {
    for (const patch of [{ isActive: false }, { deletedAt: new Date('2026-09-01T00:00:00Z') }]) {
      const { w, base, outcome } = await assign((world) => world.people.support.id, (world) => world.set('user', patch, world.people.support.id));

      expect(outcome.status).toBe(404);
      expect(changedRows(base, w.memory.snapshot())).toEqual([]);
    }
  });
});
