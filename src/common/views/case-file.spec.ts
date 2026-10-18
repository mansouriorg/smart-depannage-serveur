import * as fs from 'fs';
import * as path from 'path';

import { parsePrismaSchema } from '../api-contract/prisma-schema';
import { leaked, poisonedJob } from '../testing/poison';
import {
  CASE_FILE_COLUMNS,
  CASE_FILE_WITHHELD,
  CasePeople,
  INTERVENTION_NOTE_MAX,
  caseFileOf,
  caseMessageOf,
  caseNoteOf,
  peopleToLookUp,
  timelineEntryOf,
} from './case-file';
import { KNOWN_INTERVENTION_COLUMNS } from './views';

/**
 * The case file of a job (P1-14): an explicit list of what the back office page shows, a timeline
 * that marks the lines the people of the job do not read, every chat, the notes with their
 * authors. The leak tests plant a secret in every column and relation of a job and look for it in
 * the answer.
 */
const schema = parsePrismaSchema(fs.readFileSync(path.resolve(__dirname, '../../../prisma/schema.prisma'), 'utf8'));

const people: CasePeople = new Map([
  [5, { id: 5, name: 'Sonia', role: 'SUPPORT' }],
  [7, { id: 7, name: 'Hedi', role: 'DISPATCHER' }],
  [20, { id: 20, name: 'Ali', role: 'ARTISAN' }],
]);

function poisonedFile() {
  const job = poisonedJob();
  const { events, messages, ...rest } = job;

  return { file: caseFileOf({ job: rest, events, messages, notes: [], people }), job: rest, events, messages };
}

describe('the columns of the case file', () => {
  it('every column of a job is shown or withheld with a reason (a new column has to be decided)', () => {
    const columns = schema.models.Intervention.fields.filter((field) => field.kind !== 'model').map((field) => field.name).sort();

    expect([...CASE_FILE_COLUMNS, ...Object.keys(CASE_FILE_WITHHELD)].sort()).toEqual(columns);
  });

  it('no column is both shown and withheld, none is listed twice, and the views know all of them', () => {
    expect(new Set(CASE_FILE_COLUMNS).size).toBe(CASE_FILE_COLUMNS.length);

    for (const column of Object.keys(CASE_FILE_WITHHELD)) {
      expect(CASE_FILE_COLUMNS).not.toContain(column);
      expect(CASE_FILE_WITHHELD[column].length).toBeGreaterThan(20);
    }

    for (const column of [...CASE_FILE_COLUMNS, ...Object.keys(CASE_FILE_WITHHELD)]) {
      expect(KNOWN_INTERVENTION_COLUMNS).toContain(column);
    }
  });

  it('the tracking link, the old notes text, the signature and the materials are withheld', () => {
    for (const column of ['trackingToken', 'adminInternalNotes', 'cancelledById', 'clientSignatureUrl', 'materialUsed']) {
      expect(Object.keys(CASE_FILE_WITHHELD)).toContain(column);
    }
  });

  it('what the page needs is there: urgency, building, floor, apartment code, access instructions, contact, photos', () => {
    for (const column of ['urgency', 'buildingInfo', 'floor', 'apartmentCode', 'accessInstructions', 'contactName', 'contactPhone', 'photos', 'beforePhotoUrl', 'afterPhotoUrl', 'description', 'address']) {
      expect(CASE_FILE_COLUMNS).toContain(column);
    }
  });
});

describe('what the case file lets out', () => {
  it('no withheld column and no relation of the row: only the listed columns and the case file\'s own parts', () => {
    const { file } = poisonedFile();
    const allowed = new Set([...CASE_FILE_COLUMNS, 'client', 'artisan', 'subService', 'cancelledBy', 'timeline', 'messages', 'notes']);

    for (const key of Object.keys(file)) expect(allowed.has(key)).toBe(true);
    for (const column of Object.keys(CASE_FILE_WITHHELD)) expect(Object.keys(file)).not.toContain(column);
  });

  it('plants a secret everywhere and finds only what the back office is meant to read', () => {
    const { file } = poisonedFile();
    const shown = new Set(CASE_FILE_COLUMNS.map((column) => `job.${column}`));
    // Read by the team on purpose: the artisan's e-mail, the team chat, and the lines and the text of the internal timeline.
    const meant = new Set([
      'artisan.email',
      'message.internalAdmin.content',
      'event.internalNote.title',
      'event.internalNote.message',
      'event.legacyArtisanProblem.message',
      'event.flaggedInternal.message',
    ]);

    const strangers = leaked(file).filter((name) => !shown.has(name) && !meant.has(name));

    expect(strangers).toEqual([]);
  });

  it('never the tracking link, the old notes, who cancelled as a bare id, the metadata of an event, the readers of a message, a deleted message, the customer\'s address book, money, complaints, reviews', () => {
    const found = leaked(poisonedFile().file);

    for (const name of [
      'job.trackingToken',
      'job.adminInternalNotes',
      'job.cancelledById',
      'job.savedAddressId',
      'job.materialUsed',
      'job.clientSignatureUrl',
      'event.metadata',
      'event.createdById',
      'message.readByUserIds',
      'message.deleted.content',
      'sender.email',
      'client.address',
      'quote.createdById',
      'quote.draft.title',
      'payment.adminNote',
      'payment.providerPaymentId',
      'invoice.emailedTo',
      'review.moderationReason',
      'complaint.adminNotes',
      'complaint.internalNotes',
    ]) {
      expect(found).not.toContain(name);
    }
  });

  it('the people are a name and a phone and an address, never the rest of their account', () => {
    const { file } = poisonedFile();

    expect(Object.keys(file.client).sort()).toEqual(['email', 'id', 'name', 'phone']);
    expect(Object.keys(file.artisan).sort()).toEqual(['email', 'id', 'name', 'phone']);
    // The artisan's last position is not told: it is for the customer's screen, while the artisan is on the way.
    expect(JSON.stringify(file)).not.toContain('36.81');
    expect(Object.keys(file.subService).sort()).toEqual(['id', 'name']);
  });

  it('a job with no customer, no technician and no service is told as nulls, not as a crash', () => {
    const file = caseFileOf({ job: { id: 3, status: 'CREATED', urgency: 'NORMAL' }, events: null, messages: undefined, notes: null, people });

    expect(file.client).toBeNull();
    expect(file.artisan).toBeNull();
    expect(file.subService).toBeNull();
    expect(file.cancelledBy).toBeNull();
    expect(file.timeline).toEqual([]);
    expect(file.messages).toEqual([]);
    expect(file.notes).toEqual([]);
  });
});

describe('the timeline', () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 1, 10, minutes));

  it('has every line, oldest first, the ones that were written the same minute by their number', () => {
    const events = [
      { id: 9, type: 'WORK_STARTED', title: 'c', createdAt: at(30) },
      { id: 2, type: 'REQUEST_CREATED', title: 'a', createdAt: at(0) },
      { id: 4, type: 'QUOTE_SENT', title: 'b2', createdAt: at(10) },
      { id: 3, type: 'QUOTE_SENT', title: 'b1', createdAt: at(10) },
    ];
    const file = caseFileOf({ job: { id: 1 }, events, messages: [], notes: [], people });

    expect(file.timeline.map((line) => line.id)).toEqual([2, 3, 4, 9]);
    // The caller's list is not reordered behind its back.
    expect(events.map((event) => event.id)).toEqual([9, 2, 4, 3]);
  });

  it('marks the lines the people of the job do not read (a team note, a flagged line, the old problem report) and only those', () => {
    const { file } = poisonedFile();
    const byId = (id: number) => file.timeline.find((line) => line.id === id)!;

    expect(byId(1).internal).toBe(false);
    expect(byId(2).internal).toBe(true);
    expect(byId(3).internal).toBe(true);
    expect(byId(4).internal).toBe(true);
    expect(file.timeline.length).toBe(4);
  });

  it('names who wrote a line: the account behind the number, or the number alone when the account is gone, or nobody for a line the system wrote', () => {
    const written = (createdById: unknown) => timelineEntryOf({ id: 1, type: 'STATUS_CHANGED', title: 't', createdAt: at(0), createdById }, people).author;

    expect(written(5)).toEqual({ id: 5, name: 'Sonia', role: 'SUPPORT' });
    expect(written(99)).toEqual({ id: 99, name: null, role: null });
    expect(written(null)).toBeNull();
    expect(written(undefined)).toBeNull();
    expect(written('5')).toBeNull();
  });

  it('keeps the title and the text of a line, and nothing else of it (no metadata)', () => {
    const line = timelineEntryOf({ id: 1, type: 'STATUS_CHANGED', title: 't', message: 'm', createdAt: at(0), createdById: 7, metadata: { a: 1 }, interventionId: 1 }, people);

    expect(Object.keys(line).sort()).toEqual(['author', 'createdAt', 'id', 'internal', 'message', 'title', 'type']);
  });

  it('skips what is not a line instead of failing on it', () => {
    const file = caseFileOf({ job: { id: 1 }, events: [null, undefined, 3 as any, { id: 1, type: 'X', title: 't', createdAt: at(0) }], messages: [null], notes: [null], people });

    expect(file.timeline.length).toBe(1);
    expect(file.messages).toEqual([]);
    expect(file.notes).toEqual([]);
  });
});

describe('the messages', () => {
  it('are all the chats, the team\'s own included, oldest first', () => {
    const { file } = poisonedFile();

    expect(file.messages.map((message) => message.audience).sort()).toEqual(['ARTISAN_SUPPORT', 'CLIENT_ARTISAN', 'CLIENT_ARTISAN', 'CLIENT_SUPPORT', 'INTERNAL_ADMIN']);
    expect(file.messages.map((message) => message.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it('are in the order they were written, whatever order they arrive in (the same minute by their number)', () => {
    const message = (id: number, minutes: number) => ({ id, audience: 'CLIENT_ARTISAN', content: `m${id}`, attachments: [], createdAt: new Date(Date.UTC(2026, 9, 1, 10, minutes)) });
    const input = [message(9, 30), message(2, 0), message(4, 10), message(3, 10)];
    const file = caseFileOf({ job: { id: 1 }, events: [], messages: input, notes: [], people });

    expect(file.messages.map((entry) => entry.id)).toEqual([2, 3, 4, 9]);
    expect(input.map((entry) => entry.id)).toEqual([9, 2, 4, 3]);
  });

  it('a deleted message is told (when, in which chat, by whom) but not read, with its attachments', () => {
    const message = caseMessageOf({ id: 5, audience: 'CLIENT_ARTISAN', content: 'secret text', attachments: ['/api/files/3/download'], deletedAt: new Date(), createdAt: new Date(), sender: { id: 20, name: 'Ali', role: 'ARTISAN', email: 'a@b.tn' } });

    expect(message.deleted).toBe(true);
    expect(message.content).toBeNull();
    expect(message.attachments).toEqual([]);
    expect(message.sender).toEqual({ id: 20, name: 'Ali', role: 'ARTISAN' });
  });

  it('a message is read with its text and attachments, by a sender who has a name and a role and no e-mail', () => {
    const message = caseMessageOf({ id: 1, audience: 'CLIENT_SUPPORT', content: 'Bonjour', attachments: ['/api/files/3/download'], readByUserIds: [1, 2], isRead: true, createdAt: new Date(), sender: { id: 5, name: 'Sonia', role: 'SUPPORT', email: 'x@y.tn' } });

    expect(message.deleted).toBe(false);
    expect(message.content).toBe('Bonjour');
    expect(message.attachments).toEqual(['/api/files/3/download']);
    expect(Object.keys(message).sort()).toEqual(['attachments', 'audience', 'content', 'createdAt', 'deleted', 'id', 'sender']);
  });

  it('a message with no text (a photo alone) has null for text and keeps the photo; one with no sender row has null for the sender', () => {
    const message = caseMessageOf({ id: 1, audience: 'CLIENT_ARTISAN', content: null, attachments: ['/api/files/3/download'], createdAt: new Date() });

    expect(message.content).toBeNull();
    expect(message.attachments).toEqual(['/api/files/3/download']);
    expect(message.sender).toBeNull();
  });
});

describe('the notes of the team', () => {
  const note = (id: number, minutes: number, extra: Record<string, unknown> = {}) => ({ id, content: `n${id}`, authorId: 7, createdAt: new Date(Date.UTC(2026, 9, 1, 10, minutes)), ...extra });

  it('newest first, with who wrote them', () => {
    const file = caseFileOf({ job: { id: 1 }, events: [], messages: [], notes: [note(1, 0), note(3, 20), note(2, 10)], people });

    expect(file.notes.map((entry) => entry.id)).toEqual([3, 2, 1]);
    expect(file.notes[0].author).toEqual({ id: 7, name: 'Hedi', role: 'DISPATCHER' });
  });

  it('a note that was removed is not listed', () => {
    const file = caseFileOf({ job: { id: 1 }, events: [], messages: [], notes: [note(1, 0), note(2, 10, { deletedAt: new Date() })], people });

    expect(file.notes.map((entry) => entry.id)).toEqual([1]);
  });

  it('a note has its text, its date and its author, and not the type or number of what it is about', () => {
    const entry = caseNoteOf({ id: 1, content: 'Appeler avant', authorId: 7, targetType: 'INTERVENTION', targetId: 12, createdAt: new Date(), updatedAt: new Date(), deletedAt: null }, people);

    expect(Object.keys(entry).sort()).toEqual(['author', 'content', 'createdAt', 'id']);
  });

  it('a note written by an account that is gone keeps its number and has no name', () => {
    expect(caseNoteOf(note(1, 0, { authorId: 404 }), people).author).toEqual({ id: 404, name: null, role: null });
    expect(caseNoteOf(note(1, 0, { authorId: null }), people).author).toBeNull();
  });

  it('the longest note is two thousand characters (the form stops at the same number)', () => {
    expect(INTERVENTION_NOTE_MAX).toBe(2000);
  });
});

describe('who is looked up', () => {
  it('the people the lines, the notes and the cancellation name: each once, numbers only', () => {
    const ids = peopleToLookUp(
      { cancelledById: 7 },
      [{ createdById: 5 }, { createdById: 7 }, { createdById: null }, { createdById: 'x' }, null as any, {}],
      [{ authorId: 5 }, { authorId: 9 }, { authorId: null }, null as any],
    );

    expect(ids.sort()).toEqual([5, 7, 9]);
  });

  it('the person who cancelled the job is looked up even when nobody else is named', () => {
    expect(peopleToLookUp({ cancelledById: 7 }, [], [])).toEqual([7]);
    expect(peopleToLookUp({ cancelledById: null }, [{ createdById: 5 }], [])).toEqual([5]);
  });

  it('nobody to look up for a job nobody wrote on', () => {
    expect(peopleToLookUp({}, [], [])).toEqual([]);
    expect(peopleToLookUp(null, [], [])).toEqual([]);
  });

  it('who cancelled the job is told with a name and a role, not as a bare number', () => {
    const file = caseFileOf({ job: { id: 1, cancelledById: 7, cancelledReason: 'Doublon' }, events: [], messages: [], notes: [], people });

    expect(file.cancelledBy).toEqual({ id: 7, name: 'Hedi', role: 'DISPATCHER' });
    expect(file.cancelledReason).toBe('Doublon');
    expect(Object.keys(file)).not.toContain('cancelledById');
  });
});
