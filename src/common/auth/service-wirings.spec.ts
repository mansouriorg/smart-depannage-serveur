import { emptyWorld } from '../testing/world';

/**
 * Two services decide by role in code (P3-02) and no route test reaches them: who counts as the back office when a chat message is
 * sorted by sender, and who may be created as a staff member. They ask the matrix; this pins the answer they give.
 */

const STAFF = ['ADMIN', 'SUPER_ADMIN', 'SUPPORT', 'DISPATCHER', 'ACCOUNTANT'];
const OTHERS = ['CLIENT', 'ARTISAN'];

/** What a call answers: its message when it is refused, 'ok' when it goes through. */
async function outcome(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();

    return 'ok';
  } catch (error) {
    return (error as Error).message;
  }
}

describe('the back office, as the notifications service sees it (P3-02)', () => {
  it('a message sent by one of the five staff roles is a message from the back office, and by nobody else', () => {
    const { svc } = emptyWorld();
    const isAdminRole = (role: unknown) => (svc.notifications as any).isAdminRole(role);

    for (const role of STAFF) expect([role, isAdminRole(role)]).toEqual([role, true]);
    for (const role of [...OTHERS, 'ROOT', undefined, null, 'constructor']) expect([String(role), isAdminRole(role)]).toEqual([String(role), false]);
  });
});

describe('who may be created as a staff member (P3-02)', () => {
  const create = async (role: unknown) => {
    const world = emptyWorld();

    (world.svc.users as any).sendPasswordSetupLink = async () => undefined;

    const email = `new-${String(role).toLowerCase()}@mail.tn`;
    const answer = await outcome(() => world.svc.users.createStaffUser({ name: 'Nouveau', email, role }));

    return { answer, created: world.memory.rows('user').filter((user: any) => user.email === email) };
  };

  it('each of the five staff roles goes through and the account is made with that role', async () => {
    for (const role of STAFF) {
      const { answer, created } = await create(role);

      expect([role, answer, created.map((user: any) => user.role)]).toEqual([role, 'ok', [role]]);
    }
  });

  it('a customer, a technician and anything else are refused before anything is made', async () => {
    for (const role of [...OTHERS, 'ROOT', 'constructor', '', undefined, null]) {
      const { answer, created } = await create(role);

      expect([String(role), answer, created.length]).toEqual([String(role), 'Rôle staff invalide.', 0]);
    }
  });
});
