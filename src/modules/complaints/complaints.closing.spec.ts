import { resetLocale } from '../../common/locale/locale';
import { World, emptyWorld } from '../../common/testing/world';
import { REFUND_NOT_ANSWERED } from './complaints.service';

/**
 * Closing a complaint (P2-09): not while the refund the customer asked for waits for an answer. The payout of the artisan is held
 * for such a refund, and a closed complaint offers no way to decide it, so the money would stay held for ever.
 */

interface Desk {
  world: World;
  admin: any;
  complaint: (data?: Record<string, any>) => any;
  stored: (id: number) => any;
}

function desk(): Desk {
  resetLocale();

  const world = emptyWorld();
  const m = world.memory;
  const admin = m.plant('user', { role: 'ADMIN', name: 'Admin Chef', email: 'chef@example.test', phone: null });
  const client = m.plant('user', { role: 'CLIENT', name: 'Salma Ben Ali', email: 'salma@example.test', phone: null });
  const artisan = m.plant('user', { role: 'ARTISAN', name: 'Karim Plombier', email: 'karim@example.test', phone: null });
  const job = m.plant('intervention', { clientId: client.id, artisanId: artisan.id, status: 'COMPLETED', serviceType: 'PLOMBIER', address: 'Tunis', description: 'Fuite' });

  const complaint = (data: Record<string, any> = {}) =>
    m.plant('complaint', { interventionId: job.id, userId: client.id, title: 'Fuite', description: 'Toujours là', status: 'IN_REVIEW', refundRequested: true, refundDecision: 'PENDING', ...data });

  return { world, admin, complaint, stored: (id: number) => m.rows('complaint').find((row: any) => row.id === id) };
}

async function refusal(work: () => Promise<unknown>): Promise<{ status: number; message: string } | null> {
  try {
    await work();
  } catch (error) {
    const known = error as { getStatus?: () => number; message?: string };

    return { status: typeof known.getStatus === 'function' ? known.getStatus() : 500, message: String(known.message) };
  }

  return null;
}

const resolve = (d: Desk, id: number) => d.world.svc.complaints.resolveComplaint(d.admin.id, 'ADMIN' as any, id, { resolutionNotes: 'Réparé.' } as any);
const move = (d: Desk, id: number, status: string) => d.world.svc.complaints.updateStatus(d.admin.id, 'ADMIN' as any, id, { status, note: 'Pour le dossier.' } as any);

describe('closing a complaint while its refund waits for an answer (P2-09)', () => {
  it('refuses to resolve it, and changes nothing', async () => {
    const d = desk();
    const waiting = d.complaint();

    expect(await refusal(() => resolve(d, waiting.id))).toEqual({ status: 409, message: REFUND_NOT_ANSWERED });
    expect(d.stored(waiting.id)).toMatchObject({ status: 'IN_REVIEW', refundDecision: 'PENDING' });
    expect(d.stored(waiting.id).resolutionNotes ?? null).toBeNull();
  });

  it('refuses to reject it, and to mark it resolved by the status route', async () => {
    const d = desk();
    const waiting = d.complaint();

    expect((await refusal(() => move(d, waiting.id, 'REJECTED')))?.status).toBe(409);
    expect((await refusal(() => move(d, waiting.id, 'RESOLVED')))?.status).toBe(409);
    expect(d.stored(waiting.id).status).toBe('IN_REVIEW');
  });

  it('says what to do: decide the refund first', () => {
    expect(REFUND_NOT_ANSWERED).toBe('Le client a demandé un remboursement : décidez-en d’abord (accepter ou refuser), puis clôturez la réclamation.');
  });

  it('still moves it between the stages of the work', async () => {
    const d = desk();
    const waiting = d.complaint();

    for (const status of ['WAITING_CLIENT', 'WAITING_ARTISAN', 'IN_REVIEW']) {
      expect(await refusal(() => move(d, waiting.id, status))).toBeNull();
      expect(d.stored(waiting.id).status).toBe(status);
    }
  });

  it('closes it once the refund has an answer, whichever it is', async () => {
    for (const decision of ['APPROVED', 'REJECTED', 'NOT_REQUESTED']) {
      const d = desk();
      const answered = d.complaint({ refundDecision: decision });

      expect(await refusal(() => resolve(d, answered.id))).toBeNull();
      expect(d.stored(answered.id)).toMatchObject({ status: 'RESOLVED', refundDecision: decision });

      const other = d.complaint({ refundDecision: decision });

      expect(await refusal(() => move(d, other.id, 'REJECTED'))).toBeNull();
      expect(d.stored(other.id).status).toBe('REJECTED');
    }
  });

  it('closes a complaint where nobody asked for a refund', async () => {
    const d = desk();
    const plain = d.complaint({ refundRequested: false, refundDecision: 'NOT_REQUESTED' });

    expect(await refusal(() => resolve(d, plain.id))).toBeNull();
    expect(d.stored(plain.id).status).toBe('RESOLVED');
  });

  it('unblocks the closing once the refund is refused from the screen of the refund decision', async () => {
    const d = desk();
    const waiting = d.complaint();

    await d.world.svc.admin.decideRefund(d.admin.id, waiting.id, { approved: false, note: 'Hors garantie.' } as any);
    expect(d.stored(waiting.id).refundDecision).toBe('REJECTED');

    expect(await refusal(() => move(d, waiting.id, 'REJECTED'))).toBeNull();
    expect(d.stored(waiting.id).status).toBe('REJECTED');
  });

  it('refuses to mark it refunded, which closes it too', async () => {
    const d = desk();
    const waiting = d.complaint();

    expect((await refusal(() => move(d, waiting.id, 'REFUNDED')))?.status).toBe(409);
    expect(d.stored(waiting.id)).toMatchObject({ status: 'IN_REVIEW', refundDecision: 'PENDING' });
    expect(d.stored(waiting.id).closedAt ?? null).toBeNull();

    const answered = d.complaint({ refundDecision: 'APPROVED' });

    expect(await refusal(() => move(d, answered.id, 'REFUNDED'))).toBeNull();
    expect(d.stored(answered.id).status).toBe('REFUNDED');
  });

  it('refuses it when the refund became a question after the complaint was read (a decision at the same moment)', async () => {
    const d = desk();
    const waiting = d.complaint();
    const stale = { ...d.stored(waiting.id), refundDecision: 'NOT_REQUESTED' };
    const complaints = d.world.svc.complaints as any;
    const original = complaints.getComplaintOrFail;

    // The read that the check relies on shows a complaint without a question; the row already has one.
    complaints.getComplaintOrFail = async () => stale;

    try {
      expect((await refusal(() => resolve(d, waiting.id)))?.status).toBe(409);
      expect((await refusal(() => move(d, waiting.id, 'REJECTED')))?.status).toBe(409);
      expect((await refusal(() => move(d, waiting.id, 'RESOLVED')))?.status).toBe(409);
    } finally {
      complaints.getComplaintOrFail = original;
    }

    expect(d.stored(waiting.id)).toMatchObject({ status: 'IN_REVIEW', refundDecision: 'PENDING' });
    expect(d.stored(waiting.id).closedAt ?? null).toBeNull();
    expect(d.stored(waiting.id).resolutionNotes ?? null).toBeNull();
  });

  it('is the same for the older routes of the admin module', async () => {
    const d = desk();
    const admin = d.world.svc.admin as any;
    const waiting = d.complaint();
    const notes = () => d.world.memory.rows('adminInternalNote').length;

    expect((await refusal(() => admin.closeComplaint(d.admin.id, waiting.id, { content: 'Fini.' })))?.status).toBe(409);
    for (const status of ['RESOLVED', 'REJECTED', 'REFUNDED']) {
      expect((await refusal(() => admin.updateComplaintStatus(d.admin.id, waiting.id, { status, note: 'Pour le dossier.' })))?.status).toBe(409);
    }
    expect(d.stored(waiting.id)).toMatchObject({ status: 'IN_REVIEW', refundDecision: 'PENDING' });
    expect(d.stored(waiting.id).closedAt ?? null).toBeNull();
    expect(notes()).toBe(0);

    expect(await refusal(() => admin.updateComplaintStatus(d.admin.id, waiting.id, { status: 'WAITING_CLIENT' }))).toBeNull();
    expect(d.stored(waiting.id).status).toBe('WAITING_CLIENT');

    const answered = d.complaint({ refundDecision: 'REJECTED' });

    expect(await refusal(() => admin.closeComplaint(d.admin.id, answered.id, { content: 'Fini.' }))).toBeNull();
    expect(d.stored(answered.id)).toMatchObject({ status: 'RESOLVED' });
    expect(d.stored(answered.id).closedAt).toBeTruthy();
    expect(notes()).toBe(1);

    const other = d.complaint({ refundDecision: 'NOT_REQUESTED', refundRequested: false });

    expect(await refusal(() => admin.updateComplaintStatus(d.admin.id, other.id, { status: 'REJECTED' }))).toBeNull();
    expect(d.stored(other.id).status).toBe('REJECTED');
  });

  it('is the same for the older routes of the admin module when the refund became a question after the complaint was read', async () => {
    const d = desk();
    const admin = d.world.svc.admin as any;
    const waiting = d.complaint();
    const stale = { ...d.stored(waiting.id), refundDecision: 'NOT_REQUESTED', internalNotes: [] };
    const original = admin.getComplaintDetail;

    admin.getComplaintDetail = async () => stale;

    try {
      expect((await refusal(() => admin.closeComplaint(d.admin.id, waiting.id, { content: 'Fini.' })))?.status).toBe(409);
      expect((await refusal(() => admin.updateComplaintStatus(d.admin.id, waiting.id, { status: 'RESOLVED' })))?.status).toBe(409);
    } finally {
      admin.getComplaintDetail = original;
    }

    expect(d.stored(waiting.id)).toMatchObject({ status: 'IN_REVIEW', refundDecision: 'PENDING' });
    expect(d.stored(waiting.id).closedAt ?? null).toBeNull();
    expect(d.world.memory.rows('adminInternalNote').length).toBe(0);
  });

  it('does not know a complaint that does not exist', async () => {
    const d = desk();

    expect((await refusal(() => resolve(d, 9999)))?.status).toBe(404);
  });
});
