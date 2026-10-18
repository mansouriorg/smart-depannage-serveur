import { leaked, leakedTo, poisonedJob, secret } from '../../common/testing/poison';
import { RealtimeService } from './realtime.service';

/**
 * P1-08: what is pushed over the sockets, to whom. Every emit is captured with its room; a secret
 * is planted in every place that is not for the people in that room, and a leak names itself.
 */
type Emit = { to: 'admins' | 'client' | 'artisan' | 'room' | 'user'; id?: number; event: string; payload: any };

function makeWorld(rows: { job?: any; message?: any; complaint?: any; payment?: any; quote?: any } = {}) {
  const emits: Emit[] = [];
  const job = () => rows.job ?? poisonedJob();
  const prisma: any = {
    intervention: { findUnique: async () => job() },
    message: { findUnique: async () => rows.message ?? null },
    complaint: { findUnique: async () => rows.complaint ?? null },
    payment: { findUnique: async () => rows.payment ?? null },
    quote: { findUnique: async () => rows.quote ?? null },
  };
  const gateway: any = {
    emitToAdmins: (event: string, payload: any) => emits.push({ to: 'admins', event, payload }),
    emitToClient: (id: number, event: string, payload: any) => emits.push({ to: 'client', id, event, payload }),
    emitToArtisan: (id: number, event: string, payload: any) => emits.push({ to: 'artisan', id, event, payload }),
    emitToIntervention: (id: number, event: string, payload: any) => emits.push({ to: 'room', id, event, payload }),
    emitToUser: (id: number, event: string, payload: any) => emits.push({ to: 'user', id, event, payload }),
  };

  return { service: new RealtimeService(prisma, gateway), emits };
}

const by = (emits: Emit[], to: Emit['to']) => emits.filter((emit) => emit.to === to);
const nonStaff = (emits: Emit[]) => emits.filter((emit) => emit.to !== 'admins');

describe('what the sockets push (P1-08)', () => {
  it('a status change: the dashboard the row and who acted; the customer, the artisan and the room each their own copy', async () => {
    const world = makeWorld();

    await world.service.emitStatusChange({ interventionId: 1, oldStatus: 'CREATED', newStatus: 'ARTISAN_ASSIGNED', actorId: 5 });

    const [admins] = by(world.emits, 'admins');
    const [client] = by(world.emits, 'client');
    const [artisan] = by(world.emits, 'artisan');
    const [room] = by(world.emits, 'room');

    expect(admins.payload.actorId).toBe(5);
    expect(admins.payload.intervention.adminInternalNotes).toBe('SECRET<job.adminInternalNotes>');

    expect(leakedTo(client.payload, 'client')).toEqual([]);
    expect(leakedTo(artisan.payload, 'artisan')).toEqual([]);
    expect(leakedTo(room.payload, 'room')).toEqual([]);

    for (const emit of nonStaff(world.emits)) {
      expect(emit.payload).not.toHaveProperty('actorId');
      expect(emit.payload.newStatus).toBe('ARTISAN_ASSIGNED');
    }

    expect(client.payload.intervention.artisan).toEqual({ id: 20, name: 'Ali', phone: '+21621111111' });
    expect(artisan.payload.intervention.client.phone).toBe('+21620000000');
    expect(JSON.stringify(room.payload)).not.toContain('+21620000000');
    expect(JSON.stringify(room.payload)).not.toContain('salah@example.tn');
    expect(room.payload.intervention).not.toHaveProperty('client');
    expect(room.payload.intervention).not.toHaveProperty('artisan');
  });

  it('a job with no artisan yet: nothing is pushed to an artisan', async () => {
    const world = makeWorld({ job: poisonedJob({ artisanId: null, artisan: null }) });

    await world.service.emitStatusChange({ interventionId: 1, newStatus: 'CREATED' });

    expect(by(world.emits, 'artisan')).toEqual([]);
  });

  it('a new message: the people in that chat get it without the writer\'s address; nobody hears the internal chat', async () => {
    const [first, support, artisanSupport, internal] = poisonedJob().messages.map((message: any) => ({
      ...message,
      intervention: { id: 1, clientId: 10, artisanId: 20, status: 'ARTISAN_ASSIGNED' },
    }));

    const heard = async (message: any) => {
      const world = makeWorld({ message });

      await world.service.emitNewMessage(message.id);

      return world.emits;
    };

    const chat = await heard(first);

    expect(chat.map((emit) => emit.to)).toEqual(['client', 'artisan', 'admins']);
    expect(leaked(nonStaff(chat).map((emit) => emit.payload))).toEqual([]);
    expect(by(chat, 'admins')[0].payload.message.sender.email).toBe('SECRET<sender.email>');

    expect((await heard(support)).map((emit) => emit.to)).toEqual(['client', 'admins']);
    expect((await heard(artisanSupport)).map((emit) => emit.to)).toEqual(['artisan', 'admins']);
    expect((await heard(internal)).map((emit) => emit.to)).toEqual(['admins']);
  });

  it('a complaint: the dashboard the whole of it; the room only that there is one; its author theirs, with no note of the back office', async () => {
    const complaint = {
      ...poisonedJob().complaints[0],
      createdAt: new Date(),
      user: { id: 10, name: 'Salah', email: secret('sender.email'), role: 'CLIENT' },
      intervention: { id: 1, clientId: 10, artisanId: 20, status: 'ARTISAN_ASSIGNED', serviceType: 'PLOMBIER', address: 'Tunis' },
    };
    const world = makeWorld({ complaint });

    await world.service.emitComplaintAlert(1);

    const [room] = by(world.emits, 'room');
    const [owner] = by(world.emits, 'user');

    expect(owner.id).toBe(10);
    expect(leaked(room.payload)).toEqual([]);
    expect(room.payload).not.toHaveProperty('complaint');
    expect(room.payload).not.toHaveProperty('userId');
    expect(room.payload.title).toBe('Retard');
    expect(leaked(owner.payload)).toEqual([]);
    expect(owner.payload.complaint).toMatchObject({ id: 1, title: 'Retard', status: 'IN_REVIEW' });
    expect(by(world.emits, 'admins')[0].payload.complaint.adminNotes).toBe('SECRET<complaint.adminNotes>');
  });

  it('a payment: the customer theirs; the artisan and the room that it was made, and for how much', async () => {
    const payment = { ...poisonedJob().payments[0], quote: null, invoice: null, quoteId: null, invoiceId: null, intervention: { id: 1, clientId: 10, artisanId: 20, status: 'PAID' } };
    const world = makeWorld({ payment });

    await world.service.emitPaymentConfirmation(1);

    expect(leaked(nonStaff(world.emits).map((emit) => emit.payload))).toEqual([]);
    expect(by(world.emits, 'client')[0].payload.method).toBe('CASH');

    for (const emit of [by(world.emits, 'artisan')[0], by(world.emits, 'room')[0]]) {
      expect(emit.payload.amount).toBe(120);
      expect(emit.payload).not.toHaveProperty('method');
      expect(emit.payload.payment).not.toHaveProperty('reference');
    }

    expect(by(world.emits, 'admins')[0].payload.payment.adminNote).toBe('SECRET<payment.adminNote>');
  });

  it('an accepted quote: the customer the quote; the artisan and the room the amounts and the status', async () => {
    const quote = { ...poisonedJob().quotes[0], acceptedAt: null, intervention: { id: 1, clientId: 10, artisanId: 20, status: 'QUOTE_ACCEPTED', serviceType: 'PLOMBIER', address: 'Tunis' } };
    const world = makeWorld({ quote });

    await world.service.emitQuoteAccepted(1);

    expect(leaked(nonStaff(world.emits).map((emit) => emit.payload))).toEqual([]);
    expect(by(world.emits, 'client')[0].payload.quote.id).toBe(1);

    for (const emit of [by(world.emits, 'artisan')[0], by(world.emits, 'room')[0]]) {
      expect(emit.payload.amountTTC).toBe(120);
      expect(emit.payload).not.toHaveProperty('quote');
    }

    expect(by(world.emits, 'admins')[0].payload.quote.createdById).toBe('SECRET<quote.createdById>');
  });

  it('the artisan\'s live position: the back office always, the customer and the room only while the artisan is on the way', async () => {
    const heard = async (status: string) => {
      const world = makeWorld({ job: { id: 1, clientId: 10, artisanId: 20, status } });

      await world.service.emitArtisanLocationUpdate({ interventionId: 1, artisanId: 20, latitude: 36.8, longitude: 10.1 });

      return world.emits.map((emit) => emit.to);
    };

    expect(await heard('ARTISAN_ON_THE_WAY')).toEqual(['room', 'client', 'admins']);
    expect(await heard('ON_THE_WAY')).toEqual(['room', 'client', 'admins']);

    for (const status of ['ASSIGNED', 'ARTISAN_ACCEPTED', 'ARTISAN_ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'PAID', 'CANCELLED']) {
      expect(await heard(status)).toEqual(['admins']);
    }
  });
});
