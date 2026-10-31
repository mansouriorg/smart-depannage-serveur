import { emptyWorld } from '../../common/testing/world';

/**
 * Assigning a complaint from the dashboard (P3-02): the person it goes to is one who handles complaints. That is the same set as
 * the complaints module's: support, dispatchers and admins (the dashboard used to refuse dispatchers). Not an accountant, not a
 * customer, not a technician.
 */

function desk() {
  const world = emptyWorld();
  const m = world.memory;
  const admin = m.plant('user', { role: 'ADMIN', name: 'Amel' });
  const client = m.plant('user', { role: 'CLIENT', name: 'Salma' });
  const job = m.plant('intervention', { clientId: client.id, status: 'ASSIGNED', serviceType: 'PLOMBIER' });
  const complaint = m.plant('complaint', { interventionId: job.id, userId: client.id, title: 'Souci', description: 'Le problème est revenu.', status: 'OPEN', refundDecision: 'NOT_REQUESTED', refundRequested: false, refundApproved: false });
  const agent = (role: string) => m.plant('user', { role, name: role });

  return { world, m, admin, complaint, agent, row: () => m.rows('complaint').find((r: any) => r.id === complaint.id) };
}

describe('who a complaint can be assigned to from the dashboard (P3-02)', () => {
  it.each(['SUPPORT', 'DISPATCHER', 'ADMIN', 'SUPER_ADMIN'])('a %s can', async (role) => {
    const d = desk();
    const person = d.agent(role);

    await d.world.svc.admin.assignComplaint(d.admin.id, d.complaint.id, { supportAgentId: person.id });

    expect(d.row()).toMatchObject({ assignedToId: person.id, status: 'IN_REVIEW' });
  });

  it.each(['ACCOUNTANT', 'CLIENT', 'ARTISAN'])('a %s cannot', async (role) => {
    const d = desk();
    const person = d.agent(role);
    let refused: unknown = null;

    try {
      await d.world.svc.admin.assignComplaint(d.admin.id, d.complaint.id, { supportAgentId: person.id });
    } catch (error) {
      refused = error;
    }

    expect((refused as Error | null)?.message).toBe('Agent support invalide.');
    expect(d.row()).toMatchObject({ assignedToId: null, status: 'OPEN' });
  });

  it('nobody at all cannot either', async () => {
    const d = desk();
    let refused: unknown = null;

    try {
      await d.world.svc.admin.assignComplaint(d.admin.id, d.complaint.id, { supportAgentId: 99999 });
    } catch (error) {
      refused = error;
    }

    expect((refused as Error | null)?.message).toBe('Agent support invalide.');
  });

  it('a support agent whose account is switched off, or deleted, cannot be given a complaint', async () => {
    const off = desk();
    const away = off.m.plant('user', { role: 'SUPPORT', name: 'Parti', isActive: false });
    const gone = off.m.plant('user', { role: 'SUPPORT', name: 'Supprimé', deletedAt: new Date('2026-09-01T00:00:00Z') });

    for (const person of [away, gone]) {
      let refused: unknown = null;

      try {
        await off.world.svc.admin.assignComplaint(off.admin.id, off.complaint.id, { supportAgentId: person.id });
      } catch (error) {
        refused = error;
      }

      expect([person.name, (refused as Error | null)?.message]).toEqual([person.name, 'Agent support invalide.']);
    }

    expect(off.row()).toMatchObject({ assignedToId: null, status: 'OPEN' });
  });

  it('an active support agent is still given it', async () => {
    const d = desk();
    const person = d.m.plant('user', { role: 'SUPPORT', name: 'Actif', isActive: true, deletedAt: null });

    await d.world.svc.admin.assignComplaint(d.admin.id, d.complaint.id, { supportAgentId: person.id });

    expect(d.row()).toMatchObject({ assignedToId: person.id });
  });
});
