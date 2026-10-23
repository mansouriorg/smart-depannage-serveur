import { attempt, changedRows } from './access-matrix';
import { World, buildWorld } from './world';

/**
 * An administrator cannot reach an account of their own rank or above (P1-17). The users controller asks `canManage` before it
 * changes, deactivates, reactivates or sends a password link for an account, and before it hands out a role; whoever holds the
 * password link can sign in as the account, so a missing check on any one of these routes is a way to become a super administrator.
 * Each route is tried through the real controller, as an administrator and as a super administrator, on an account of every role.
 */
const ROUTES: Array<{ route: string; what: string; request: (id: number) => Record<string, unknown> }> = [
  { route: 'PATCH /users/:', what: 'change the account', request: (id) => ({ params: { id }, body: { name: 'Autre nom' } }) },
  { route: 'DELETE /users/:', what: 'deactivate the account', request: (id) => ({ params: { id } }) },
  { route: 'POST /users/:/password-setup-link', what: 'send a link to choose the password', request: (id) => ({ params: { id } }) },
  { route: 'PATCH /users/:/reactivate', what: 'reactivate the account', request: (id) => ({ params: { id } }) },
];

/** The world, with a second administrator to be the target of the first. */
function setup() {
  const w = buildWorld();
  const otherAdmin: any = w.memory.plant('user', { role: 'ADMIN', email: 'second.admin@example.test', isActive: true, deletedAt: null });

  return { w, targets: { superAdmin: w.people.superAdmin.id, otherAdmin: otherAdmin.id as number, support: w.people.support.id, dispatcher: w.people.dispatcher.id, accountant: w.people.accountant.id, client: w.people.clientA.id, artisan: w.people.artisanA.id } };
}

const quiet = (w: World) => w.sink.filter((call) => !call.startsWith('rateLimit'));

describe('an administrator cannot reach an account of their own rank or above (P1-17)', () => {
  for (const { route, what, request } of ROUTES) {
    for (const target of ['superAdmin', 'otherAdmin'] as const) {
      it(`${route}: an administrator cannot ${what} of ${target === 'superAdmin' ? 'a super administrator' : 'another administrator'}: 403 and nothing changes`, async () => {
        const { w, targets } = setup();
        const base = w.memory.snapshot();
        const outcome = await attempt(w, w.people.admin, route, request(targets[target]) as any);

        expect(outcome.ok).toBe(false);
        expect(outcome.status).toBe(403);
        expect(changedRows(base, w.memory.snapshot())).toEqual([]);
        expect(quiet(w)).toEqual([]);
      });
    }

    for (const target of ['support', 'dispatcher', 'accountant', 'client', 'artisan'] as const) {
      it(`${route}: the control, an administrator can ${what} of a ${target}`, async () => {
        const { w, targets } = setup();
        const outcome = await attempt(w, w.people.admin, route, request(targets[target]) as any);

        expect(`${outcome.status}: ${outcome.error?.message ?? ''}`).toBe('200: ');
      });
    }

    it(`${route}: the control, a super administrator can ${what} of an administrator`, async () => {
      const { w, targets } = setup();
      const outcome = await attempt(w, w.people.superAdmin, route, request(targets.otherAdmin) as any);

      expect(`${outcome.status}: ${outcome.error?.message ?? ''}`).toBe('200: ');
    });
  }
});

describe('an administrator cannot hand out a role of their own rank or above (P1-17)', () => {
  for (const role of ['ADMIN', 'SUPER_ADMIN']) {
    it(`PATCH /users/: giving the role ${role} to a support account is a 403 and changes nothing`, async () => {
      const { w, targets } = setup();
      const base = w.memory.snapshot();
      const outcome = await attempt(w, w.people.admin, 'PATCH /users/:', { params: { id: targets.support }, body: { role } } as any);

      expect(outcome.status).toBe(403);
      expect(changedRows(base, w.memory.snapshot())).toEqual([]);
    });

    it(`POST /users: creating an account with the role ${role} is a 403 and creates nothing`, async () => {
      const { w } = setup();
      const base = w.memory.snapshot();
      const outcome = await attempt(w, w.people.admin, 'POST /users', { body: { email: 'new.person@example.test', password: 'Motdepasse1', name: 'Nouveau', role } } as any);

      expect(outcome.status).toBe(403);
      expect(changedRows(base, w.memory.snapshot())).toEqual([]);
    });
  }

  it('the control: an administrator gives the role SUPPORT, a super administrator gives ADMIN', async () => {
    const { w, targets } = setup();

    expect((await attempt(w, w.people.admin, 'PATCH /users/:', { params: { id: targets.client }, body: { role: 'SUPPORT' } } as any)).status).toBe(200);
    expect((await attempt(w, w.people.superAdmin, 'PATCH /users/:', { params: { id: targets.support }, body: { role: 'ADMIN' } } as any)).status).toBe(200);
  });
});
