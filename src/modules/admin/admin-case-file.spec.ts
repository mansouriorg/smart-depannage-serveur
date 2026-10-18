import * as fs from 'fs';
import * as path from 'path';

import { AdminService } from './admin.service';
import { ScannedRoute, scanController } from '../../common/testing/route-roles';
import { TICKET_STAFF_ROLES } from '../../common/auth/role-policy';
import { INTERVENTION_NOTE_MAX } from '../../common/views/case-file';
import { leaked, secret } from '../../common/testing/poison';

/** The case file of a job and the notes written on it, as the server answers them (P1-14). */

type Calls = Array<{ table: string; op: string; args: any }>;

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 1, 10, minutes));

function makeService(options: { jobs?: number[]; withTrackingToken?: boolean } = {}) {
  const calls: Calls = [];
  const jobIds = options.jobs ?? [12];
  const created: any[] = [];

  const users: Record<number, any> = {
    5: { id: 5, name: 'Sonia', role: 'SUPPORT', email: secret('user.email') },
    7: { id: 7, name: 'Hedi', role: 'DISPATCHER', email: secret('user.email') },
    20: { id: 20, name: 'Ali', role: 'ARTISAN', email: secret('user.email') },
  };

  const events = [
    { id: 2, interventionId: 12, type: 'STATUS_CHANGED', title: 'Statut modifié par admin', message: 'Nouveau statut: ARTISAN_ASSIGNED', createdAt: at(10), createdById: 7, metadata: secret('event.metadata') },
    { id: 1, interventionId: 12, type: 'REQUEST_CREATED', title: 'Demande créée', message: null, createdAt: at(0), createdById: null },
    { id: 3, interventionId: 12, type: 'INTERNAL_NOTE_ADDED', title: 'Note du changement de statut', message: 'Client à rappeler', createdAt: at(11), createdById: 7 },
    { id: 4, interventionId: 13, type: 'REQUEST_CREATED', title: 'Autre demande', message: secret('other.job.event'), createdAt: at(0), createdById: null },
  ];

  const messages = [
    { id: 1, interventionId: 12, senderId: 20, audience: 'CLIENT_ARTISAN', content: 'J’arrive', attachments: [], readByUserIds: [secret('message.readBy')], deletedAt: null, createdAt: at(20), sender: { id: 20, name: 'Ali', role: 'ARTISAN' } },
    { id: 2, interventionId: 13, senderId: 20, audience: 'CLIENT_ARTISAN', content: secret('other.job.message'), attachments: [], readByUserIds: [], deletedAt: null, createdAt: at(21), sender: { id: 20, name: 'Ali', role: 'ARTISAN' } },
  ];

  const notes = [
    { id: 1, targetType: 'INTERVENTION', targetId: 12, authorId: 5, content: 'Porte au fond de la cour', createdAt: at(30), deletedAt: null },
    { id: 2, targetType: 'INTERVENTION', targetId: 12, authorId: 7, content: 'Retiré', createdAt: at(31), deletedAt: new Date() },
    { id: 3, targetType: 'COMPLAINT', targetId: 12, authorId: 7, content: secret('other.target.note'), createdAt: at(32), deletedAt: null },
    { id: 4, targetType: 'INTERVENTION', targetId: 13, authorId: 7, content: secret('other.job.note'), createdAt: at(33), deletedAt: null },
  ];

  const jobRow = (id: number) => ({
    id,
    status: 'ARTISAN_ASSIGNED',
    urgency: 'URGENT',
    description: 'Fuite sous l’évier',
    buildingInfo: 'Résidence Les Jasmins, bloc B',
    floor: '3',
    apartmentCode: 'B3',
    accessInstructions: 'Sonner deux fois',
    photos: ['/api/files/1/download'],
    clientId: 10,
    artisanId: 20,
    cancelledById: null,
    ...(options.withTrackingToken === false ? {} : { trackingToken: secret('job.trackingToken'), adminInternalNotes: secret('job.adminInternalNotes') }),
    client: { id: 10, name: 'Salma', phone: '+21622123456', email: 'salma@example.tn' },
    artisan: { id: 20, name: 'Ali', phone: '+21655000111', email: 'ali@example.tn' },
    subService: { id: 3, name: 'Fuite' },
  });

  const prisma: any = {
    intervention: {
      findUnique: async (args: any) => {
        calls.push({ table: 'intervention', op: 'findUnique', args });
        return jobIds.includes(args.where.id) ? jobRow(args.where.id) : null;
      },
    },
    interventionEvent: {
      findMany: async (args: any) => {
        calls.push({ table: 'interventionEvent', op: 'findMany', args });
        return events.filter((event) => event.interventionId === args.where.interventionId);
      },
    },
    message: {
      findMany: async (args: any) => {
        calls.push({ table: 'message', op: 'findMany', args });
        return messages.filter((message) => message.interventionId === args.where.interventionId);
      },
    },
    adminInternalNote: {
      findMany: async (args: any) => {
        calls.push({ table: 'adminInternalNote', op: 'findMany', args });
        return notes.filter(
          (note) =>
            note.targetType === args.where.targetType &&
            note.targetId === args.where.targetId &&
            (args.where.deletedAt === null ? note.deletedAt === null : true),
        );
      },
      create: async (args: any) => {
        calls.push({ table: 'adminInternalNote', op: 'create', args });
        const row = { id: 50 + created.length, createdAt: at(40), updatedAt: at(40), deletedAt: null, ...args.data };
        created.push(row);
        return row;
      },
    },
    user: {
      findMany: async (args: any) => {
        calls.push({ table: 'user', op: 'findMany', args });
        return args.where.id.in.filter((id: number) => users[id]).map((id: number) => ({ id, name: users[id].name, role: users[id].role }));
      },
    },
  };

  const eventsService: any = { create: async () => calls.push({ table: 'events', op: 'create', args: {} }) };

  return {
    service: new AdminService(prisma, {} as any, eventsService, {} as any, {} as any, {} as any),
    calls,
    created,
    writes: () => calls.filter((call) => call.op === 'create' || call.op === 'update' || call.op === 'delete'),
    queries: (table: string) => calls.filter((call) => call.table === table),
  };
}

/** The error a call ends with (the stand-in test runner cannot match a class in toThrow). */
async function failure(call: Promise<unknown>): Promise<any> {
  try {
    await call;
  } catch (error) {
    return error;
  }

  return null;
}

describe('AdminService.getInterventionDetail: the case file', () => {
  it('is the job with its customer, its technician and its service, and the access details', async () => {
    const w = makeService();
    const file: any = await w.service.getInterventionDetail(12);

    expect(file.id).toBe(12);
    expect(file.urgency).toBe('URGENT');
    expect(file.buildingInfo).toBe('Résidence Les Jasmins, bloc B');
    expect(file.floor).toBe('3');
    expect(file.apartmentCode).toBe('B3');
    expect(file.accessInstructions).toBe('Sonner deux fois');
    expect(file.photos).toEqual(['/api/files/1/download']);
    expect(file.client).toEqual({ id: 10, name: 'Salma', phone: '+21622123456', email: 'salma@example.tn' });
    expect(file.artisan.name).toBe('Ali');
    expect(file.subService).toEqual({ id: 3, name: 'Fuite' });
  });

  it('has the whole timeline oldest first with the team\'s lines marked, the chats, and the notes newest first with their authors', async () => {
    const file: any = await makeService().service.getInterventionDetail(12);

    expect(file.timeline.map((line: any) => [line.id, line.internal])).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);
    expect(file.timeline[1].author).toEqual({ id: 7, name: 'Hedi', role: 'DISPATCHER' });
    expect(file.timeline[0].author).toBeNull();
    expect(file.messages.map((message: any) => message.id)).toEqual([1]);
    expect(file.notes.map((note: any) => [note.id, note.content, note.author.name])).toEqual([[1, 'Porte au fond de la cour', 'Sonia']]);
  });

  it('asks for this job\'s lines, messages and notes only (not another job\'s, not another kind of note, not a removed note), in one go', async () => {
    const w = makeService({ jobs: [12, 13] });
    const file: any = await w.service.getInterventionDetail(12);

    expect(w.queries('interventionEvent')[0].args.where).toEqual({ interventionId: 12 });
    expect(w.queries('message')[0].args.where).toEqual({ interventionId: 12 });
    expect(w.queries('adminInternalNote')[0].args.where).toEqual({ targetType: 'INTERVENTION', targetId: 12, deletedAt: null });
    expect(leaked(file)).not.toContain('other.job.event');
    expect(leaked(file)).not.toContain('other.job.message');
    expect(leaked(file)).not.toContain('other.target.note');
    expect(leaked(file)).not.toContain('other.job.note');
  });

  it('lets nothing out that the page does not show: not the tracking link, not the old notes, not the metadata, not who has read a message, not an e-mail of the team', async () => {
    const file: any = await makeService().service.getInterventionDetail(12);

    expect(leaked(file)).toEqual([]);
    expect(Object.keys(file)).not.toContain('trackingToken');
    expect(Object.keys(file)).not.toContain('adminInternalNotes');
    expect(Object.keys(file)).not.toContain('cancelledById');
  });

  it('asks the database for the customer\'s and the technician\'s name, phone and e-mail, not their whole account or their position', async () => {
    const w = makeService();

    await w.service.getInterventionDetail(12);

    const include = w.queries('intervention')[0].args.include;

    expect(Object.keys(include.client.select).sort()).toEqual(['email', 'id', 'name', 'phone']);
    expect(Object.keys(include.artisan.select).sort()).toEqual(['email', 'id', 'name', 'phone']);
    expect(Object.keys(include.subService.select).sort()).toEqual(['id', 'name']);
    expect(Object.keys(w.queries('message')[0].args.include.sender.select).sort()).toEqual(['id', 'name', 'role']);
  });

  it('asks the database for the lines and messages oldest first and for the notes newest first, the same minute by number', async () => {
    const w = makeService();

    await w.service.getInterventionDetail(12);

    expect(w.queries('interventionEvent')[0].args.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
    expect(w.queries('message')[0].args.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
    expect(w.queries('adminInternalNote')[0].args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });

  it('looks the writers up once, for the numbers it met, and asks for their name and role only', async () => {
    const w = makeService();

    await w.service.getInterventionDetail(12);

    expect(w.queries('user').length).toBe(1);
    expect(w.queries('user')[0].args.where.id.in.sort()).toEqual([5, 7]);
    expect(w.queries('user')[0].args.select).toEqual({ id: true, name: true, role: true });
  });

  it('asks nobody when nobody wrote anything', async () => {
    const w = makeService();

    // A job whose lines were all written by the system and which has no note.
    (w as any).service['prisma'].interventionEvent.findMany = async () => [];
    (w as any).service['prisma'].adminInternalNote.findMany = async () => [];

    const file: any = await w.service.getInterventionDetail(12);

    expect(file.timeline).toEqual([]);
    expect(w.queries('user').length).toBe(0);
  });

  it('writes nothing', async () => {
    const w = makeService();

    await w.service.getInterventionDetail(12);

    expect(w.writes()).toEqual([]);
  });

  it('is a 404 for a job that does not exist, and no line, message or note is asked for', async () => {
    const w = makeService();
    const error = await failure(w.service.getInterventionDetail(99));

    expect(error.getStatus()).toBe(404);
    expect(w.queries('interventionEvent').length).toBe(0);
    expect(w.queries('message').length).toBe(0);
    expect(w.queries('adminInternalNote').length).toBe(0);
  });

  it('is a 404, without a query, for a number that cannot be a job (zero, negative, fractional, past what the database stores, not a number)', async () => {
    for (const id of [0, -1, 1.5, 2_147_483_648, Number.NaN, Number.POSITIVE_INFINITY, 1e21]) {
      const w = makeService();
      const error = await failure(w.service.getInterventionDetail(id));

      expect(`${id}: ${error?.getStatus?.()}`).toBe(`${id}: 404`);
      expect(w.calls.length).toBe(0);
    }
  });

  it('the largest number the database stores is a job number like any other (404 when there is no such job)', async () => {
    const w = makeService();
    const error = await failure(w.service.getInterventionDetail(2_147_483_647));

    expect(error.getStatus()).toBe(404);
    expect(w.queries('intervention').length).toBe(1);
  });
});

describe('AdminService.addInterventionInternalNote', () => {
  it('writes the note on this job, by this person, and answers with the note as the case file lists it', async () => {
    const w = makeService();
    const note: any = await w.service.addInterventionInternalNote(7, 12, { content: 'Rappeler avant 17h' });

    expect(w.created.length).toBe(1);
    expect(w.created[0]).toMatchObject({ authorId: 7, targetType: 'INTERVENTION', targetId: 12, content: 'Rappeler avant 17h' });
    expect(note.content).toBe('Rappeler avant 17h');
    expect(note.author).toEqual({ id: 7, name: 'Hedi', role: 'DISPATCHER' });
    expect(Object.keys(note).sort()).toEqual(['author', 'content', 'createdAt', 'id']);
  });

  it('keeps the text without the spaces around it, and the line breaks inside it', async () => {
    const w = makeService();

    await w.service.addInterventionInternalNote(7, 12, { content: '  Ligne 1\nLigne 2 \n ' });

    expect(w.created[0].content).toBe('Ligne 1\nLigne 2');
  });

  it('refuses a note that is empty, blank, missing or not a text (400), and writes nothing', async () => {
    for (const content of ['', '   ', '\n\t ', undefined, null, 42, {}, ['a']]) {
      const w = makeService();
      const error = await failure(w.service.addInterventionInternalNote(7, 12, { content } as any));

      expect(`${JSON.stringify(content)}: ${error?.getStatus?.()}`).toBe(`${JSON.stringify(content)}: 400`);
      expect(w.writes()).toEqual([]);
    }

    const w = makeService();
    const error = await failure(w.service.addInterventionInternalNote(7, 12, undefined as any));

    expect(error.getStatus()).toBe(400);
    expect(w.writes()).toEqual([]);
  });

  it('refuses a note over the limit (400) and takes one at the limit, spaces around it not counted', async () => {
    const tooLong = makeService();
    const error = await failure(tooLong.service.addInterventionInternalNote(7, 12, { content: 'x'.repeat(INTERVENTION_NOTE_MAX + 1) }));

    expect(error.getStatus()).toBe(400);
    expect(tooLong.writes()).toEqual([]);

    const exact = makeService();
    await exact.service.addInterventionInternalNote(7, 12, { content: `  ${'x'.repeat(INTERVENTION_NOTE_MAX)}  ` });

    expect(exact.created[0].content.length).toBe(INTERVENTION_NOTE_MAX);
  });

  it('is a 404 for a job that does not exist, and nothing is written', async () => {
    const w = makeService();
    const error = await failure(w.service.addInterventionInternalNote(7, 99, { content: 'Bonjour' }));

    expect(error.getStatus()).toBe(404);
    expect(w.writes()).toEqual([]);
  });

  it('is a 404, without a query, for a number that cannot be a job', async () => {
    for (const id of [0, -5, 2_147_483_648, 2.5]) {
      const w = makeService();
      const error = await failure(w.service.addInterventionInternalNote(7, id, { content: 'Bonjour' }));

      expect(`${id}: ${error?.getStatus?.()}`).toBe(`${id}: 404`);
      expect(w.calls.length).toBe(0);
    }
  });

  it('does not read the whole case file to find out that the job exists', async () => {
    const w = makeService();

    await w.service.addInterventionInternalNote(7, 12, { content: 'Bonjour' });

    expect(w.queries('interventionEvent').length).toBe(0);
    expect(w.queries('message').length).toBe(0);
    expect(w.queries('intervention')[0].args.select).toEqual({ id: true });
  });

  it('adds no line to the timeline: the note is in the notes, the people of the job are not told', async () => {
    const w = makeService();

    await w.service.addInterventionInternalNote(7, 12, { content: 'Bonjour' });

    expect(w.queries('events').length).toBe(0);
  });

  it('the note is in the case file of the job afterwards, and not in another job\'s', async () => {
    const w = makeService({ jobs: [12, 13] });
    const prisma = (w.service as any).prisma;
    const base = prisma.adminInternalNote.findMany;

    await w.service.addInterventionInternalNote(7, 12, { content: 'Nouvelle note' });

    prisma.adminInternalNote.findMany = async (args: any) => [...(await base(args)), ...w.created.filter((row) => row.targetId === args.where.targetId)];

    const mine: any = await w.service.getInterventionDetail(12);
    const other: any = await w.service.getInterventionDetail(13);

    expect(mine.notes.map((note: any) => note.content)).toContain('Nouvelle note');
    expect(other.notes.map((note: any) => note.content)).not.toContain('Nouvelle note');
  });
});

describe('the note route, as Nest receives it', () => {
  const dto = fs.readFileSync(path.join(__dirname, 'dto/admin.dto.ts'), 'utf8');
  const controller = fs.readFileSync(path.join(__dirname, 'admin.controller.ts'), 'utf8');
  const routes: ScannedRoute[] = scanController(controller, TICKET_STAFF_ROLES);
  const noteRoute = routes.find((route) => route.method === 'POST' && route.path === '/admin/interventions/:id/internal-notes');
  const detailRoute = routes.find((route) => route.method === 'GET' && route.path === '/admin/interventions/:id');

  it('the body is checked as text, not blank, at most as long as the service allows (class-validator reads these decorators)', () => {
    const body = /export class InterventionNoteDto \{([\s\S]*?)\n\}/.exec(dto)?.[1] ?? '';

    expect(body).toContain('@IsString()');
    expect(body).toContain('@IsNotEmpty()');
    expect(body).toContain('@MaxLength(INTERVENTION_NOTE_MAX)');
    expect(body).toContain('content: string;');
  });

  it('the route takes that body and the job number as a whole number', () => {
    expect(noteRoute).toBeDefined();
    expect(noteRoute?.source).toContain('@Body() dto: InterventionNoteDto');
    expect(noteRoute?.source).toContain("@Param('id', ParseIntPipe) id: number");
    expect(detailRoute?.source).toContain("@Param('id', ParseIntPipe) id: number");
  });

  it('both routes are for the four roles that work on jobs, with the guard that enforces them', () => {
    for (const route of [noteRoute, detailRoute]) {
      expect([...(route?.roles ?? [])].sort()).toEqual(['ADMIN', 'DISPATCHER', 'SUPER_ADMIN', 'SUPPORT']);
      expect(route?.rolesEnforced).toBe(true);
    }
  });

  it('the older note body (any text, no limit) is still what the other routes take: only this one was tightened', () => {
    const others = routes.filter((route) => route.source.includes('dto: AdminInternalNoteDto'));

    expect(others.length).toBeGreaterThan(0);
    expect(others.some((route) => route === noteRoute)).toBe(false);
  });
});
