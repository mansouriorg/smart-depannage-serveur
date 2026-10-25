import { resetLocale } from '../../common/locale/locale';
import { World, emptyWorld } from '../../common/testing/world';

/** The complaints screen's reads, on the real service and the in-memory database (P2-09). */

const at = (iso: string) => new Date(iso);

interface Desk {
  world: World;
  admin: any;
  support: any;
  accountant: any;
  clients: { salma: any; ali: any };
  artisan: any;
  jobs: { one: any; two: any };
  c: Record<string, any>;
}

function desk(): Desk {
  const world = emptyWorld();
  const m = world.memory;
  const user = (role: string, name: string, phone: string | null = null, email: string | null = null) => m.plant('user', { role, name, phone, email: email ?? `${name.toLowerCase().replace(/\W+/g, '.')}@example.test` });
  const admin = user('ADMIN', 'Admin Chef');
  const support = user('SUPPORT', 'Nour Support');
  const accountant = user('ACCOUNTANT', 'Comptable Sami');
  const salma = user('CLIENT', 'Salma Ben Ali', '22 123 456');
  const ali = user('CLIENT', 'Ali Trabelsi', '55 333 444');
  const artisan = user('ARTISAN', 'Karim Plombier', '98 000 111');
  const one = m.plant('intervention', { clientId: salma.id, artisanId: artisan.id, status: 'PAID', serviceType: 'PLOMBIER', address: '12 rue de Carthage', description: 'Fuite sous évier', contactName: 'Salma', contactPhone: '22 123 456' });
  const two = m.plant('intervention', { clientId: ali.id, artisanId: null, status: 'CANCELLED', serviceType: 'ELECTRICIEN', address: 'Sfax', description: 'Prise', contactName: 'Ali', contactPhone: '55 333 444' });

  const complaint = (data: Record<string, any>) => m.plant('complaint', { interventionId: one.id, userId: salma.id, description: 'Le problème est revenu.', status: 'OPEN', refundDecision: 'NOT_REQUESTED', refundRequested: false, refundApproved: false, ...data });

  const c: Record<string, any> = {
    open: complaint({ title: 'Fuite persistante', createdAt: at('2026-10-20T08:00:00Z') }),
    decide: complaint({ title: 'Tache au plafond', status: 'IN_REVIEW', assignedToId: support.id, refundRequested: true, refundDecision: 'PENDING', createdAt: at('2026-10-21T08:00:00Z') }),
    waiting: complaint({ title: 'Prise cassée', interventionId: two.id, userId: ali.id, status: 'WAITING_CLIENT', createdAt: at('2026-10-22T08:00:00Z') }),
    pay: complaint({ title: 'Joint raté', status: 'REFUNDED', assignedToId: admin.id, refundRequested: true, refundDecision: 'APPROVED', refundApproved: true, refundAmount: 50, refundDecidedAt: at('2026-10-24T08:00:00Z'), createdAt: at('2026-10-23T08:00:00Z') }),
    resolved: complaint({ title: 'Retard', status: 'RESOLVED', assignedToId: support.id, createdAt: at('2026-10-19T08:00:00Z'), closedAt: at('2026-10-20T08:00:00Z') }),
    rejected: complaint({ title: 'Pas de réparation', status: 'REJECTED', refundRequested: true, refundDecision: 'REJECTED', createdAt: at('2026-10-18T08:00:00Z'), closedAt: at('2026-10-19T08:00:00Z') }),
    paid: complaint({ title: 'Geste commercial', status: 'REFUNDED', refundRequested: true, refundDecision: 'PARTIAL_REFUND', refundApproved: true, refundAmount: 20, createdAt: at('2026-10-17T08:00:00Z'), closedAt: at('2026-10-18T08:00:00Z') }),
  };

  return { world, admin, support, accountant, clients: { salma, ali }, artisan, jobs: { one, two }, c };
}

const ids = (page: { data: Array<{ id: number }> }) => page.data.map((row) => row.id);

async function refusal(work: () => Promise<unknown>): Promise<{ status: number; message: string } | null> {
  try {
    await work();
  } catch (error) {
    const known = error as { getStatus?: () => number; message?: string };

    return { status: typeof known.getStatus === 'function' ? known.getStatus() : 500, message: String(known.message) };
  }

  return null;
}

describe('the list of complaints (P2-09)', () => {
  beforeEach(() => resetLocale());

  it('holds every complaint, the newest first, with the size of each view', async () => {
    const { world, admin, c } = desk();
    const page = await world.svc.admin.findAllComplaints({}, admin.id);

    expect(ids(page)).toEqual([c.pay.id, c.waiting.id, c.decide.id, c.open.id, c.resolved.id, c.rejected.id, c.paid.id]);
    expect(page.meta).toEqual({ page: 1, limit: 20, total: 7, totalPages: 1 });
    expect(page.counts).toEqual({ todo: 3, decide: 1, pay: 1, unassigned: 2, closed: 3, all: 7 });
  });

  it('puts the work queue in order: the oldest first when asked', async () => {
    const { world, admin, c } = desk();
    const page = await world.svc.admin.findAllComplaints({ view: 'todo', sort: 'oldest' }, admin.id);

    expect(ids(page)).toEqual([c.open.id, c.decide.id, c.waiting.id]);
  });

  it('breaks ties by the number, so that a page boundary never loses a complaint', async () => {
    const { world, admin, c } = desk();

    world.set('complaint', { createdAt: at('2026-10-20T08:00:00Z') }, () => true);

    const sorted = await world.svc.admin.findAllComplaints({ sort: 'oldest' }, admin.id);
    const numbers = ids(sorted);

    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(numbers).toHaveLength(Object.keys(c).length);

    const first = await world.svc.admin.findAllComplaints({ sort: 'oldest', limit: '3', page: '1' }, admin.id);
    const second = await world.svc.admin.findAllComplaints({ sort: 'oldest', limit: '3', page: '2' }, admin.id);
    const third = await world.svc.admin.findAllComplaints({ sort: 'oldest', limit: '3', page: '3' }, admin.id);

    expect([...ids(first), ...ids(second), ...ids(third)]).toEqual(numbers);
  });

  it('shows the complaints to work on, to decide, to pay, nobody\'s, and the closed ones', async () => {
    const { world, admin, c } = desk();
    const view = async (name: string) => ids(await world.svc.admin.findAllComplaints({ view: name, sort: 'oldest' }, admin.id));

    expect(await view('todo')).toEqual([c.open.id, c.decide.id, c.waiting.id]);
    expect(await view('decide')).toEqual([c.decide.id]);
    expect(await view('pay')).toEqual([c.pay.id]);
    expect(await view('unassigned')).toEqual([c.open.id, c.waiting.id]);
    expect(await view('closed')).toEqual([c.paid.id, c.rejected.id, c.resolved.id]);
    expect((await view('all')).length).toBe(7);
  });

  it('does not call closed a refund that has to be paid, though its status says "refunded"', async () => {
    const { world, admin, c } = desk();
    const closed = ids(await world.svc.admin.findAllComplaints({ view: 'closed' }, admin.id));

    expect(closed).not.toContain(c.pay.id);
    expect(closed).toContain(c.paid.id);
  });

  it('a complaint that was closed leaves the list of those where a refund has to be decided', async () => {
    const { world, admin, c } = desk();

    world.set('complaint', { status: 'RESOLVED' }, c.decide.id);

    expect(ids(await world.svc.admin.findAllComplaints({ view: 'decide' }, admin.id))).toEqual([]);
  });

  it('a view that does not exist shows nothing, and a status asked with a view narrows it', async () => {
    const { world, admin, c } = desk();

    expect(ids(await world.svc.admin.findAllComplaints({ view: 'sideways' } as any, admin.id))).toEqual([]);
    expect(ids(await world.svc.admin.findAllComplaints({ view: 'todo', status: 'IN_REVIEW' }, admin.id))).toEqual([c.decide.id]);
    expect(ids(await world.svc.admin.findAllComplaints({ status: 'RESOLVED' }, admin.id))).toEqual([c.resolved.id]);
  });

  it('shows the complaints a person handles, by number or as "mine"', async () => {
    const { world, admin, support, c } = desk();

    expect(ids(await world.svc.admin.findAllComplaints({ assignedToId: String(support.id), sort: 'oldest' }, admin.id))).toEqual([c.resolved.id, c.decide.id]);
    expect(ids(await world.svc.admin.findAllComplaints({ mine: 'true', sort: 'oldest' }, support.id))).toEqual([c.resolved.id, c.decide.id]);
    expect(ids(await world.svc.admin.findAllComplaints({ mine: 'true' }, admin.id))).toEqual([c.pay.id]);
    expect(ids(await world.svc.admin.findAllComplaints({ assignedToId: 'abc' }, admin.id))).toEqual([]);
  });

  it('counts each view under the same person and the same search, and not under the view or the status', async () => {
    const { world, admin, support } = desk();
    const mine = await world.svc.admin.findAllComplaints({ mine: 'true', view: 'closed', status: 'RESOLVED' }, support.id);

    expect(mine.counts).toEqual({ todo: 1, decide: 1, pay: 0, unassigned: 0, closed: 1, all: 2 });
    expect(mine.meta.total).toBe(1);

    const searched = await world.svc.admin.findAllComplaints({ search: 'fuite' }, admin.id);

    expect(searched.counts).toEqual({ todo: 1, decide: 0, pay: 0, unassigned: 1, closed: 0, all: 1 });
  });

  it('finds a complaint by its number, the number of its job, its words, its people and their phone', async () => {
    const { world, admin, jobs, c } = desk();
    const find = async (search: string) => ids(await world.svc.admin.findAllComplaints({ search, sort: 'oldest' }, admin.id));

    expect(await find(`#${c.pay.id}`)).toContain(c.pay.id);
    expect(await find(String(jobs.two.id))).toContain(c.waiting.id);
    expect(await find('persistante')).toEqual([c.open.id]);
    expect(await find('PLAFOND')).toEqual([c.decide.id]);
    expect(await find('revenu')).toHaveLength(7);
    expect(await find('Trabelsi')).toEqual([c.waiting.id]);
    expect(await find('Karim')).not.toContain(c.waiting.id);
    expect(await find('Karim')).toContain(c.open.id);
    expect(await find('22123456')).toContain(c.open.id);
    expect(await find('+216 55 333 444')).toEqual([c.waiting.id]);
    expect(await find('nobody-at-all')).toEqual([]);
  });

  it('holds on each row what the list shows, and no long text, thread or note', async () => {
    const { world, admin, support, c } = desk();
    const page = await world.svc.admin.findAllComplaints({ view: 'decide' }, admin.id);
    const row = page.data[0];

    expect(row).toMatchObject({
      id: c.decide.id,
      title: 'Tache au plafond',
      status: 'IN_REVIEW',
      refundRequested: true,
      refundDecision: 'PENDING',
      assignedTo: { id: support.id, name: 'Nour Support', role: 'SUPPORT' },
      user: { name: 'Salma Ben Ali', role: 'CLIENT' },
      intervention: { serviceType: 'PLOMBIER', status: 'PAID', artisan: { name: 'Karim Plombier' }, client: { name: 'Salma Ben Ali' } },
    });

    for (const heavy of ['description', 'messages', 'adminNotes', 'internalNotes', 'photos']) expect(heavy in row).toBe(false);

    expect(JSON.stringify(row)).not.toContain('@example.test');
    expect(JSON.stringify(row)).not.toContain('22 123 456');
  });

  it('pages like the other lists, and a page that does not exist is empty with the right total', async () => {
    const { world, admin } = desk();
    const page = await world.svc.admin.findAllComplaints({ limit: '3', page: '3' }, admin.id);

    expect(page.data).toHaveLength(1);
    expect(page.meta).toEqual({ page: 3, limit: 3, total: 7, totalPages: 3 });
    expect((await world.svc.admin.findAllComplaints({ limit: '3', page: '9' }, admin.id)).data).toEqual([]);
    expect((await world.svc.admin.findAllComplaints({ limit: '500' }, admin.id)).meta.limit).toBe(100);
  });

  it('is empty, with every count at zero, when there is no complaint', async () => {
    const world = emptyWorld();
    const page = await world.svc.admin.findAllComplaints({}, 1);

    expect(page.data).toEqual([]);
    expect(page.counts).toEqual({ todo: 0, decide: 0, pay: 0, unassigned: 0, closed: 0, all: 0 });
  });
});

describe('the routes of the complaints screen (P2-09)', () => {
  beforeEach(() => resetLocale());

  it('tells the list who is asking, so that "mine" is the complaints of the person signed in', async () => {
    const { world, admin, support, c } = desk();
    const list = async (user: any) => ((await world.router.call('GET /admin/complaints', { user: { id: user.id, role: user.role }, query: { mine: 'true' } })).value as any).data.map((row: any) => row.id);

    expect(await list(support)).toEqual([c.decide.id, c.resolved.id]);
    expect(await list(admin)).toEqual([c.pay.id]);
  });

  it('reads one complaint as the case of the screen: the thread and the journal with their authors, and the money of the job', async () => {
    const { world, admin, support, clients, c } = desk();

    world.memory.plant('complaintMessage', { complaintId: c.open.id, senderId: clients.salma.id, senderRole: 'CLIENT', content: 'Bonjour', isInternal: false, createdAt: at('2026-10-20T09:00:00Z') });
    world.memory.plant('adminInternalNote', { targetType: 'COMPLAINT', targetId: c.open.id, authorId: admin.id, content: 'Assignée', createdAt: at('2026-10-20T12:00:00Z') });

    const read: any = (await world.router.call('GET /admin/complaints/:', { user: { id: support.id, role: 'SUPPORT' }, params: { complaintId: c.open.id } })).value;

    expect(read.id).toBe(c.open.id);
    expect(read.messages.map((message: any) => [message.content, message.sender.name])).toEqual([['Bonjour', 'Salma Ben Ali']]);
    expect(read.internalNotes.map((note: any) => [note.content, note.author.name])).toEqual([['Assignée', 'Admin Chef']]);
    expect(read.money).toBeDefined();
  });
});

describe('one complaint, as the back office reads it (P2-09)', () => {
  beforeEach(() => resetLocale());

  it('holds the people, the job, the thread in order and the journal, newest first, with who wrote each line', async () => {
    const { world, support, admin, clients, artisan, jobs, c } = desk();
    const m = world.memory;

    m.plant('complaintMessage', { complaintId: c.open.id, senderId: clients.salma.id, senderRole: 'CLIENT', content: 'Bonjour', isInternal: false, createdAt: at('2026-10-20T09:00:00Z') });
    m.plant('complaintMessage', { complaintId: c.open.id, senderId: support.id, senderRole: 'SUPPORT', content: 'À suivre', isInternal: true, createdAt: at('2026-10-20T10:00:00Z') });
    m.plant('complaintMessage', { complaintId: c.open.id, senderId: support.id, senderRole: 'SUPPORT', content: 'Je regarde', isInternal: false, createdAt: at('2026-10-20T09:30:00Z') });
    m.plant('complaintMessage', { complaintId: c.open.id, senderId: support.id, senderRole: 'SUPPORT', content: 'Effacé', isInternal: false, deletedAt: at('2026-10-20T11:00:00Z'), createdAt: at('2026-10-20T09:45:00Z') });
    m.plant('adminInternalNote', { targetType: 'COMPLAINT', targetId: c.open.id, authorId: admin.id, content: 'Assignée', createdAt: at('2026-10-20T12:00:00Z') });
    m.plant('adminInternalNote', { targetType: 'COMPLAINT', targetId: c.open.id, authorId: null, content: 'Système', createdAt: at('2026-10-20T13:00:00Z') });
    m.plant('adminInternalNote', { targetType: 'COMPLAINT', targetId: c.open.id, authorId: admin.id, content: 'Supprimée', deletedAt: at('2026-10-20T14:00:00Z'), createdAt: at('2026-10-20T14:00:00Z') });
    m.plant('adminInternalNote', { targetType: 'INTERVENTION', targetId: c.open.id, authorId: admin.id, content: 'D’un autre objet', createdAt: at('2026-10-20T15:00:00Z') });
    m.plant('adminInternalNote', { targetType: 'COMPLAINT', targetId: c.decide.id, authorId: admin.id, content: 'D’une autre réclamation', createdAt: at('2026-10-20T16:00:00Z') });

    const detail = await world.svc.admin.getComplaintCase(c.open.id);

    expect(detail.title).toBe('Fuite persistante');
    expect(detail.user).toMatchObject({ id: clients.salma.id, name: 'Salma Ben Ali', phone: '22 123 456', role: 'CLIENT' });
    expect(detail.assignedTo).toBeNull();
    expect(detail.intervention).toMatchObject({ id: jobs.one.id, serviceType: 'PLOMBIER', address: '12 rue de Carthage', contactName: 'Salma', client: { id: clients.salma.id }, artisan: { id: artisan.id, name: 'Karim Plombier' } });
    expect(detail.messages.map((message: any) => [message.content, message.isInternal, message.sender.name])).toEqual([
      ['Bonjour', false, 'Salma Ben Ali'],
      ['Je regarde', false, 'Nour Support'],
      ['À suivre', true, 'Nour Support'],
    ]);
    expect(detail.internalNotes.map((note: any) => [note.content, note.author?.name ?? null])).toEqual([
      ['Système', null],
      ['Assignée', 'Admin Chef'],
    ]);
  });

  it('tells the money of the job: what was received, what went back, what holds, and the payments a refund can go on', async () => {
    const { world, c, jobs } = desk();
    const m = world.memory;
    const first = m.plant('payment', { interventionId: jobs.one.id, method: 'BANK_TRANSFER', provider: 'MANUAL', status: 'PAID', amount: 120, amountRefunded: 0, currency: 'TND', confirmedAt: at('2026-10-11T08:00:00Z') });
    const second = m.plant('payment', { interventionId: jobs.one.id, method: 'CASH', provider: 'CASH', status: 'PARTIALLY_REFUNDED', amount: 40, amountRefunded: 10, currency: 'TND', confirmedAt: at('2026-10-12T08:00:00Z') });

    m.plant('payment', { interventionId: jobs.one.id, method: 'ONLINE', provider: 'MANUAL', status: 'PENDING', amount: 999, amountRefunded: 0, currency: 'TND' });
    m.plant('payment', { interventionId: jobs.one.id, method: 'ONLINE', provider: 'MANUAL', status: 'PAID', amount: 500, amountRefunded: 0, currency: 'EUR', confirmedAt: at('2026-10-12T08:00:00Z') });
    m.plant('payment', { interventionId: jobs.one.id, method: 'CASH', provider: 'CASH', status: 'REFUNDED', amount: 30, amountRefunded: 30, currency: 'TND', confirmedAt: at('2026-10-12T08:00:00Z') });
    m.plant('payment', { interventionId: jobs.two.id, method: 'CASH', provider: 'CASH', status: 'PAID', amount: 77, amountRefunded: 0, currency: 'TND', confirmedAt: at('2026-10-12T08:00:00Z') });
    m.plant('invoice', { interventionId: jobs.one.id, invoiceNumber: 'F-2026-0007', status: 'ISSUED', currency: 'TND', amountHT: 0, taxAmount: 0, amountTTC: 140, stampDuty: 1, creditedAmount: 0 });

    const { money } = await world.svc.admin.getComplaintCase(c.pay.id);

    expect(money).toMatchObject({ currency: 'TND', received: 190, refunded: 40, kept: 150, accepted: 50, remaining: 10, invoice: { number: 'F-2026-0007', status: 'ISSUED', toPay: 141 } });
    expect(money.payments.map((payment: any) => [payment.id, payment.refundable])).toEqual([[first.id, 120], [second.id, 30]]);
  });

  it('says what was accepted only while the money has not all gone back, and nothing for an acceptance with no amount', async () => {
    const { world, c, jobs } = desk();

    world.memory.plant('payment', { interventionId: jobs.one.id, method: 'CASH', provider: 'CASH', status: 'PARTIALLY_REFUNDED', amount: 100, amountRefunded: 60, currency: 'TND', confirmedAt: at('2026-10-12T08:00:00Z') });

    expect((await world.svc.admin.getComplaintCase(c.pay.id)).money).toMatchObject({ accepted: 50, remaining: 0 });

    world.set('complaint', { refundAmount: null }, c.pay.id);
    expect((await world.svc.admin.getComplaintCase(c.pay.id)).money).toMatchObject({ accepted: null, remaining: null });

    expect((await world.svc.admin.getComplaintCase(c.decide.id)).money).toMatchObject({ accepted: null, remaining: null });
    expect((await world.svc.admin.getComplaintCase(c.paid.id)).money).toMatchObject({ accepted: null, remaining: null });
  });

  it('never says more is due than the job still holds, whatever was accepted', async () => {
    const { world, c, jobs } = desk();
    const payment = world.memory.plant('payment', { interventionId: jobs.one.id, method: 'CASH', provider: 'CASH', status: 'PAID', amount: 30, amountRefunded: 0, currency: 'TND', confirmedAt: at('2026-10-12T08:00:00Z') });

    // 50 accepted, but the job only ever received 30: 30 is all that can go back.
    expect((await world.svc.admin.getComplaintCase(c.pay.id)).money).toMatchObject({ received: 30, refunded: 0, kept: 30, accepted: 50, remaining: 30 });

    // 10 went back: 20 is held, and 40 of the 50 is lacking, so 20 is due.
    world.set('payment', { status: 'PARTIALLY_REFUNDED', amountRefunded: 10 }, payment.id);
    expect((await world.svc.admin.getComplaintCase(c.pay.id)).money).toMatchObject({ received: 30, refunded: 10, kept: 20, accepted: 50, remaining: 20 });

    // Money received on top: what is lacking (40) is now under what is held (70), and is what is due.
    world.memory.plant('payment', { interventionId: jobs.one.id, method: 'CASH', provider: 'CASH', status: 'PAID', amount: 50, amountRefunded: 0, currency: 'TND', confirmedAt: at('2026-10-13T08:00:00Z') });
    expect((await world.svc.admin.getComplaintCase(c.pay.id)).money).toMatchObject({ received: 80, refunded: 10, kept: 70, accepted: 50, remaining: 40 });
  });

  it('refuses a number that is no row, however big, as a complaint that does not exist, not as a database error', async () => {
    const { world } = desk();

    for (const id of [99999999999999, 2147483648, 0, -3, Number.NaN, 1.5]) {
      const failure = await refusal(() => world.svc.admin.getComplaintCase(id));

      expect([id, failure?.status, failure?.message]).toEqual([id, 404, 'Réclamation introuvable.']);
    }
  });

  it('has no money and no invoice when the job was paid nothing and billed nothing', async () => {
    const { world, c } = desk();
    const { money } = await world.svc.admin.getComplaintCase(c.open.id);

    expect(money).toMatchObject({ received: 0, refunded: 0, kept: 0, accepted: null, remaining: null, payments: [], invoice: null });
  });

  it('refuses a complaint that does not exist', async () => {
    const { world } = desk();
    const failure = await refusal(() => world.svc.admin.getComplaintCase(9999));

    expect(failure?.status).toBe(404);
    expect(failure?.message).toBe('Réclamation introuvable.');
  });
});
