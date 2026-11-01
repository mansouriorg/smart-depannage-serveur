import * as fs from 'fs';
import * as path from 'path';

import { atInstant } from '../testing/clock';
import { jobSecretsHiddenFrom, leaked, poisonedJob, secret, STAFF_SECRETS } from '../testing/poison';
import {
  INTERVENTION_COLUMNS,
  Viewer,
  interventionColumnsFor,
  staffOnlyInterventionColumns,
} from './intervention-columns';
import {
  artisanForClient,
  artisanForTracking,
  chatsOf,
  clientForArtisan,
  complaintForClient,
  eventsForParties,
  invoiceForArtisan,
  invoiceForClient,
  isInternalEvent,
  interventionForArtisan,
  interventionForBoard,
  interventionForClient,
  interventionForRoom,
  interventionForTracking,
  messageForParties,
  messagesFor,
  paymentForArtisan,
  paymentForClient,
  quoteForArtisan,
  quoteForClient,
  quoteForParties,
  quotesForParties,
  reviewForParties,
} from './views';
import { STAFF_ONLY_FIELDS } from '../../modules/interventions/intervention-redaction';

/** The scalar columns of a model, read from the schema (relations and the `@@` lines are not columns). */
function schemaColumns(model: string): string[] {
  const schema = fs.readFileSync(path.resolve(__dirname, '../../../prisma/schema.prisma'), 'utf8');
  const enums = new Set([...schema.matchAll(/^enum (\w+) \{/gm)].map((match) => match[1]));
  const models = new Set([...schema.matchAll(/^model (\w+) \{/gm)].map((match) => match[1]));
  const body = new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, 'm').exec(schema)![1];
  const scalars = new Set(['String', 'Int', 'Float', 'Boolean', 'DateTime', 'Json', 'BigInt', 'Decimal', 'Bytes']);
  const columns: string[] = [];

  for (const line of body.split('\n')) {
    const match = /^\s*(\w+)\s+(\w+)(\[\])?(\?)?/.exec(line);

    if (!match || line.trim().startsWith('//') || line.trim().startsWith('@@')) continue;

    const [, name, type] = match;

    if (models.has(type)) continue;

    if (scalars.has(type) || enums.has(type)) columns.push(name);
  }

  return columns.sort();
}

const hiddenFrom = (viewer: Viewer, extra: string[] = []) => [...STAFF_SECRETS, ...jobSecretsHiddenFrom(viewer), ...extra];

describe('who may read each column of a job (P1-08)', () => {
  it('has a line for every column of the Intervention model, and for nothing else', () => {
    expect(Object.keys(INTERVENTION_COLUMNS).sort()).toEqual(schemaColumns('Intervention'));
  });

  it('is pinned: moving a column from one reader to another is a decision, and changes this list on purpose', () => {
    expect(INTERVENTION_COLUMNS).toEqual({
    id: 'CTABR',
    description: 'CTAB',
    address: 'CTAB',
    serviceType: 'CTABR',
    status: 'CTABR',
    urgency: 'CTABR',
    subServiceId: 'CTABR',
    savedAddressId: 'C',
    latitude: 'CTAB',
    longitude: 'CTAB',
    preferredDate: 'CTAB',
    preferredStartTime: 'CTAB',
    preferredEndTime: 'CTAB',
    contactName: 'CTA',
    contactPhone: 'CTA',
    contactEmail: 'CTA',
    accessInstructions: 'CTA',
    apartmentCode: 'CTA',
    buildingInfo: 'CTAB',
    floor: 'CTAB',
    clientId: 'CA',
    artisanId: 'CA',
    photos: 'CTAB',
    beforePhotoUrl: 'CTA',
    beforePhotoLat: 'A',
    beforePhotoLng: 'A',
    beforePhotoAt: 'CTA',
    afterPhotoUrl: 'CTA',
    afterPhotoLat: 'A',
    afterPhotoLng: 'A',
    afterPhotoAt: 'CTA',
    trackingToken: '',
    rating: 'CTA',
    isOnTime: 'CTA',
    hasIssue: 'CTA',
    feedbackNotes: 'CTA',
    requestCreatedAt: 'CTAR',
    adminReviewStartedAt: '',
    quoteSentAt: 'CTAR',
    quoteAcceptedAt: 'CTAR',
    assignedAt: 'CTAR',
    waitingClientValidationAt: 'CTA',
    clientValidatedAt: 'CTA',
    paymentPendingAt: 'CTAR',
    paidAt: 'CTAR',
    invoiceSentAt: 'CTAR',
    artisanAcceptedAt: 'CTAR',
    artisanRejectedAt: 'A',
    artisanOnTheWayAt: 'CTAR',
    artisanArrivedAt: 'CTAR',
    workStartedAt: 'CTAR',
    workCompletedAt: 'CTAR',
    cancelledAt: 'CTAR',
    diagnosticNotes: 'CTA',
    materialUsed: 'CTA',
    extraQuoteRequested: 'CTA',
    extraQuoteReason: 'CTA',
    clientSignatureUrl: 'CTA',
    clientSignatureAt: 'CTA',
    problemReported: 'A',
    problemType: 'A',
    problemNotes: 'A',
    lastStatusChangedAt: 'CTAR',
    adminInternalNotes: '',
    cancelledReason: 'CTA',
    cancelledById: '',
    createdAt: 'CTABR',
    updatedAt: 'CTABR',
    });
  });

  it('keeps the columns of the back office to the back office', () => {
    expect(staffOnlyInterventionColumns().sort()).toEqual(
      ['adminInternalNotes', 'adminReviewStartedAt', 'cancelledById', 'trackingToken'].sort(),
    );
    expect([...STAFF_ONLY_FIELDS].sort()).toEqual(staffOnlyInterventionColumns().sort());

    for (const viewer of ['client', 'tracking', 'artisan', 'board', 'room'] as Viewer[]) {
      for (const column of staffOnlyInterventionColumns()) {
        expect(interventionColumnsFor(viewer)).not.toContain(column);
      }
    }
  });

  it('only the artisan who has the job may reach the customer or get in the door; the board and the room never', () => {
    for (const column of ['contactName', 'contactPhone', 'contactEmail', 'accessInstructions', 'apartmentCode']) {
      expect(INTERVENTION_COLUMNS[column]).toBe('CTA');
    }

    for (const viewer of ['board', 'room'] as Viewer[]) {
      for (const column of ['contactName', 'contactPhone', 'contactEmail', 'accessInstructions', 'apartmentCode', 'clientId', 'artisanId']) {
        expect(interventionColumnsFor(viewer)).not.toContain(column);
      }
    }
  });

  it('the customer is not told that an artisan gave the job back, nor what the artisan told the back office', () => {
    for (const column of ['artisanRejectedAt', 'problemReported', 'problemType', 'problemNotes', 'beforePhotoLat', 'beforePhotoLng', 'afterPhotoLat', 'afterPhotoLng']) {
      expect(INTERVENTION_COLUMNS[column]).toBe('A');
    }
  });

  it('the tracking visitor has no id of anybody', () => {
    expect(interventionColumnsFor('tracking')).not.toContain('clientId');
    expect(interventionColumnsFor('tracking')).not.toContain('artisanId');
    expect(interventionColumnsFor('tracking')).not.toContain('savedAddressId');
  });
});

describe('the customer\'s copy of a job', () => {
  const out: any = interventionForClient(poisonedJob());

  it('has no secret of the back office, and none of the columns that are not the customer\'s', () => {
    expect(leaked(out).filter((name) => hiddenFrom('client', ['artisan.email', 'client.address']).includes(name))).toEqual([]);
  });

  it('keeps the job, the artisan\'s name and number, the quotes that were sent, what was paid and the timeline', () => {
    expect(out.id).toBe(1);
    expect(out.address).toBe(secret('job.address'));
    expect(out.artisan).toEqual({ id: 20, name: 'Ali', phone: '+21621111111' });
    expect(out.client).toEqual({ id: 10, name: 'Salah', email: 'salah@example.tn', phone: '+21620000000' });
    expect(out.quotes.map((quote: any) => quote.id)).toEqual([1]);
    expect(out.quotes[0].items).toEqual([{ id: 1, label: 'Joint', quantity: 1, unitPrice: 100, total: 100 }]);
    expect(out.payments[0]).toMatchObject({ id: 1, method: 'CASH', status: 'CONFIRMED', amount: 120, reference: 'REF-1' });
    expect(out.invoice.invoiceNumber).toBe('F-2026-1');
    expect(out.review).toMatchObject({ id: 1, rating: 5, comment: 'super' });
    expect(out.events.map((event: any) => event.id)).toEqual([1]);
  });

  it('the conversation is the customer\'s two chats: not the support\'s with the artisan, not the internal one, not a deleted message', () => {
    expect(out.messages.map((message: any) => message.id)).toEqual([1, 2]);
    expect(out.messages[0].sender).toEqual({ id: 20, name: 'Ali', role: 'ARTISAN' });
    expect(out.messages[0]).not.toHaveProperty('readByUserIds');
    expect(out.messages[0].read).toBe(false);
  });

  it('a column nobody listed does not leave', () => {
    const copy: any = interventionForClient({ ...poisonedJob(), brandNewColumn: 'x', someRelation: { a: 1 } });

    expect(copy).not.toHaveProperty('brandNewColumn');
    expect(copy).not.toHaveProperty('someRelation');
  });

  it('does not change what it was given', () => {
    const job = poisonedJob();
    const before = JSON.stringify(job);

    interventionForClient(job);
    interventionForTracking(job);
    interventionForBoard(job);
    interventionForRoom(job);
    interventionForArtisan(job);

    expect(JSON.stringify(job)).toBe(before);
  });

  it('a relation that was not asked for is not made up', () => {
    const { messages: _m, events: _e, quotes: _q, payments: _p, invoice: _i, review: _r, complaints: _c, ...bare } = poisonedJob();
    const copy: any = interventionForClient(bare);

    for (const relation of ['messages', 'events', 'quotes', 'payments', 'invoice', 'review', 'complaints']) {
      expect(copy).not.toHaveProperty(relation);
    }
  });
});

describe('where the artisan is', () => {
  const near = (status: string) => (interventionForClient(poisonedJob({ status })) as any).artisan;

  it('is told to the customer while the artisan is on the way, in either spelling of the status', () => {
    for (const status of ['ARTISAN_ON_THE_WAY', 'ON_THE_WAY']) {
      expect(near(status)).toEqual({ id: 20, name: 'Ali', phone: '+21621111111', latitude: 36.81, longitude: 10.19 });
    }
  });

  it('at no other time', () => {
    for (const status of ['CREATED', 'ASSIGNED', 'ARTISAN_ACCEPTED', 'ARTISAN_ARRIVED', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'PAID', 'CANCELLED', 'DISPUTED']) {
      expect(near(status)).toEqual({ id: 20, name: 'Ali', phone: '+21621111111' });
    }
  });

  it('the visitor with the link is told the same, without the id', () => {
    expect((interventionForTracking(poisonedJob({ status: 'ON_THE_WAY' })) as any).artisan).toEqual({
      name: 'Ali',
      phone: '+21621111111',
      latitude: 36.81,
      longitude: 10.19,
    });
    expect((interventionForTracking(poisonedJob({ status: 'IN_PROGRESS' })) as any).artisan).toEqual({ name: 'Ali', phone: '+21621111111' });
  });

  it('only while the position is fresh: an old one, or one nobody knows the time of, is not served', () => {
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    const artisanSent = (positionAt: Date | null) => ({ ...poisonedJob().artisan, positionAt });

    for (const [name, positionAt, served] of [
      ['a minute ago', minutesAgo(1), true],
      ['nine minutes ago', minutesAgo(9), true],
      ['ten minutes ago, the limit', minutesAgo(10), false],
      ['two hours ago', minutesAgo(120), false],
      ['no time', null, false],
    ] as const) {
      const client: any = (interventionForClient(poisonedJob({ artisan: artisanSent(positionAt), status: 'ON_THE_WAY' })) as any).artisan;
      const visitor: any = (interventionForTracking(poisonedJob({ artisan: artisanSent(positionAt), status: 'ON_THE_WAY' })) as any).artisan;

      expect(`${name} (client): ${'latitude' in client}`).toBe(`${name} (client): ${served}`);
      expect(`${name} (tracking): ${'longitude' in visitor}`).toBe(`${name} (tracking): ${served}`);
      // the technician is still named and can still be called: only the place is withheld
      expect(client.name).toBe('Ali');
      expect(visitor.phone).toBe('+21621111111');
    }
  });

  it('the limit is exact: ten minutes to the millisecond is old, a millisecond less is not', () => {
    const NOW = new Date('2026-11-01T12:00:00Z');
    const artisanSent = (positionAt: Date) => ({ ...poisonedJob().artisan, positionAt });
    const served = (positionAt: Date) =>
      atInstant(NOW, () => 'latitude' in ((interventionForClient(poisonedJob({ artisan: artisanSent(positionAt), status: 'ON_THE_WAY' })) as any).artisan));

    expect(served(new Date(NOW.getTime() - 10 * 60_000 + 1))).toBe(true);
    expect(served(new Date(NOW.getTime() - 10 * 60_000))).toBe(false);
    expect(served(new Date(NOW.getTime() - 10 * 60_000 - 1))).toBe(false);
  });

  it('a job with no artisan, or an artisan row without a position, makes no position up', () => {
    expect((interventionForClient(poisonedJob({ artisan: null, status: 'ON_THE_WAY' })) as any).artisan).toBeNull();
    expect((interventionForClient(poisonedJob({ artisan: { id: 20, name: 'Ali' }, status: 'ON_THE_WAY' })) as any).artisan).toEqual({ id: 20, name: 'Ali' });
  });
});

describe('the copy for the visitor with the tracking link', () => {
  const out: any = interventionForTracking(poisonedJob());

  it('has no secret of the back office and no account', () => {
    expect(leaked(out).filter((name) => hiddenFrom('tracking', ['artisan.email', 'client.address']).includes(name))).toEqual([]);
    expect(out).not.toHaveProperty('client');
    expect(out).not.toHaveProperty('clientId');
    expect(out).not.toHaveProperty('artisanId');
    expect(out).not.toHaveProperty('messages');
    expect(out).not.toHaveProperty('complaints');
  });

  it('keeps what the tracking page shows: the status, the artisan, the timeline, the quotes, the rating', () => {
    expect(out.status).toBe('ARTISAN_ASSIGNED');
    expect(out.artisan).toEqual({ name: 'Ali', phone: '+21621111111' });
    expect(out.events.map((event: any) => event.id)).toEqual([1]);
    expect(out.quotes.map((quote: any) => quote.id)).toEqual([1]);
    expect(out.contactPhone).toBe(secret('job.contactPhone'));
    expect(out).toHaveProperty('rating');
  });
});

describe('a job on the board of open jobs', () => {
  const out: any = interventionForBoard(poisonedJob({ artisanId: null, status: 'CREATED' }));

  it('has no secret, no way to reach the customer, no door code, nobody who held the job before', () => {
    expect(leaked(out).filter((name) => hiddenFrom('board', ['artisan.email', 'client.address']).includes(name))).toEqual([]);

    for (const column of ['contactName', 'contactPhone', 'contactEmail', 'accessInstructions', 'apartmentCode', 'clientId', 'artisanId', 'artisan']) {
      expect(out).not.toHaveProperty(column);
    }

    expect(JSON.stringify(out)).not.toContain('salah@example.tn');
    expect(JSON.stringify(out)).not.toContain('+21620000000');

    for (const column of ['contactName', 'contactPhone', 'contactEmail', 'accessInstructions', 'apartmentCode']) {
      expect(JSON.stringify(out)).not.toContain(secret(`job.${column}`));
    }
  });

  it('keeps what the job is and where, and the first name of the customer', () => {
    expect(out.address).toBe(secret('job.address'));
    expect(out.latitude).toBe(36.8);
    expect(out.description).toBe(secret('job.description'));
    expect(out.client).toEqual({ name: 'Salah' });
    expect(out.quotes.map((quote: any) => quote.id)).toEqual([1]);
  });

  it('shows nobody on the board the timeline, the conversation, the payments or the invoice (empty lists, as the details screen reads them)', () => {
    expect(out.events).toEqual([]);
    expect(out.messages).toEqual([]);
    expect(out.payments).toEqual([]);
    expect(out.invoice).toBeNull();
  });
});

describe('the copy for everybody in the live room of a job', () => {
  const out: any = interventionForRoom(poisonedJob());

  it('has the status and the dates, and no person, no contact, no address', () => {
    expect(leaked(out).filter((name) => hiddenFrom('room', ['artisan.email', 'client.address']).includes(name))).toEqual([]);
    expect(out.id).toBe(1);
    expect(out.status).toBe('ARTISAN_ASSIGNED');

    for (const column of ['client', 'artisan', 'clientId', 'artisanId', 'contactPhone', 'contactEmail', 'address', 'description', 'messages', 'payments']) {
      expect(out).not.toHaveProperty(column);
    }
  });
});

describe('the artisan\'s copy of a job', () => {
  const out: any = interventionForArtisan(poisonedJob());

  it('has no secret of the back office', () => {
    expect(leaked(out).filter((name) => hiddenFrom('artisan', ['client.address']).includes(name))).toEqual([]);
  });

  it('keeps the customer to call, the door code and the artisan\'s own report', () => {
    expect(out.client).toEqual({ id: 10, name: 'Salah', phone: '+21620000000', email: 'salah@example.tn' });
    expect(out.apartmentCode).toBe(secret('job.apartmentCode'));
    expect(out.problemNotes).toBe('SECRET<job.problemNotes>'); // the artisan's own words
  });

  it('the conversation is the artisan\'s two chats; the timeline has no internal line; what was paid has no way of paying', () => {
    expect(out.messages.map((message: any) => message.id)).toEqual([1, 3]);
    expect(out.events.map((event: any) => event.id)).toEqual([1]);
    expect(Object.keys(out.payments[0]).sort()).toEqual(['amount', 'amountRefunded', 'confirmedAt', 'currency', 'id', 'interventionId', 'status']);
    expect(out.invoice).not.toHaveProperty('clientEmail');
    expect(out.invoice).not.toHaveProperty('clientPhone');
    expect(out.invoice).not.toHaveProperty('clientAddress');
  });

  it('is not shown the complaints of the customer', () => {
    expect(out).not.toHaveProperty('complaints');
  });

  it('keeps the extra keys a route adds (distance, link)', () => {
    expect((interventionForArtisan({ id: 1, distanceKm: 3, navigationUrl: 'u', adminInternalNotes: 'x' }) as any)).toEqual({ id: 1, distanceKm: 3, navigationUrl: 'u' });
  });

  it('is what the older names give: withoutStaffFields and forMarketplace', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const redaction = require('../../modules/interventions/intervention-redaction');

    const row = poisonedJob();

    expect(redaction.withoutStaffFields(row)).toEqual(interventionForArtisan(row));
    expect(redaction.forMarketplace(row)).toEqual(interventionForBoard(row));
  });
});

describe('the timeline', () => {
  it('has no note of the back office, no line flagged internal, no line the artisan wrote for the back office before the flag existed', () => {
    const events = poisonedJob().events;

    expect(eventsForParties(events).map((event) => event.id)).toEqual([1]);
    expect(isInternalEvent({ type: 'INTERNAL_NOTE_ADDED' })).toBe(true);
    expect(isInternalEvent({ type: 'ISSUE_REPORTED', title: 'Décision remboursement' })).toBe(false);
    expect(isInternalEvent({ type: 'STATUS_CHANGED', metadata: { internal: true } })).toBe(true);
    expect(isInternalEvent({ type: 'STATUS_CHANGED', metadata: { previousStatus: 'A' } })).toBe(false);
    expect(isInternalEvent({ type: 'STATUS_CHANGED', metadata: 'text' })).toBe(false);
    expect(isInternalEvent(null)).toBe(true);
  });

  it('is a title, a message and a date: no author, no metadata', () => {
    expect(Object.keys(eventsForParties(poisonedJob().events)[0]).sort()).toEqual(['createdAt', 'id', 'interventionId', 'message', 'title', 'type']);
  });

  it('is an empty list for what is not a list', () => {
    expect(eventsForParties(null)).toEqual([]);
    expect(eventsForParties(undefined)).toEqual([]);
  });
});

describe('quotes, payments, invoices, reviews and complaints', () => {
  it('a draft quote is not the customer\'s, and nobody sees who wrote a quote', () => {
    const quotes = quotesForParties(poisonedJob().quotes);

    expect(quotes.map((quote) => quote.id)).toEqual([1]);
    expect(quotes[0]).not.toHaveProperty('createdById');
    expect(quotes[0]).not.toHaveProperty('createdBy');
    expect(quoteForParties(poisonedJob().quotes[0])).toEqual(quotes[0]);
    expect(quoteForParties(poisonedJob().quotes[1])).toBeNull();
    expect(quoteForParties(null)).toBeNull();
  });

  it('a quote in the customer\'s copy is never a draft; in the artisan\'s it is, with their own words', () => {
    const [sent, draft] = poisonedJob().quotes;

    expect(quoteForClient(draft)).toBeNull();
    expect(quoteForClient(sent)?.id).toBe(1);
    expect(quoteForClient(null)).toBeNull();
    expect(quoteForArtisan({ ...draft, title: 'Mon brouillon' })?.title).toBe('Mon brouillon');
    expect(quoteForArtisan(sent)).not.toHaveProperty('createdBy');
    expect(quoteForArtisan(null)).toBeNull();
  });

  it('a payment has no note of the back office, no id of the provider, no staff member, no reason typed by the staff', () => {
    expect(leaked(paymentForClient(poisonedJob().payments[0]))).toEqual([]);
    expect(paymentForClient(poisonedJob().payments[0])).not.toHaveProperty('adminNote');
  });

  it('the artisan knows that it was paid and for how much, not how the customer paid', () => {
    const payment = paymentForArtisan(poisonedJob().payments[0]);

    expect(payment).not.toHaveProperty('reference');
    expect(payment).not.toHaveProperty('method');
    expect(payment).not.toHaveProperty('clientNote');
    expect(payment.amount).toBe(120);
  });

  it('a draft invoice is not there; a sent one has no staff note, and for the artisan no copy of the customer\'s details', () => {
    expect(invoiceForClient({ ...poisonedJob().invoice, status: 'DRAFT' })).toBeNull();
    expect(invoiceForArtisan({ ...poisonedJob().invoice, status: 'DRAFT' })).toBeNull();
    expect(leaked(invoiceForClient(poisonedJob().invoice))).toEqual([]);
    expect(invoiceForClient(poisonedJob().invoice)).toHaveProperty('clientEmail');
    expect(invoiceForArtisan(poisonedJob().invoice)).not.toHaveProperty('clientEmail');
    expect(invoiceForClient(null)).toBeNull();
  });

  it('a review has no moderation, a complaint no notes and nobody at the back office', () => {
    expect(leaked(reviewForParties(poisonedJob().review))).toEqual([]);
    expect(leaked(complaintForClient(poisonedJob().complaints[0]))).toEqual([]);
    expect(complaintForClient(poisonedJob().complaints[0])).toMatchObject({ id: 1, title: 'Retard', status: 'IN_REVIEW' });
  });

  it('the people are views too: the artisan to the customer, the customer to the artisan', () => {
    expect(artisanForClient({ id: 1, name: 'A', phone: 'p', email: 'e', latitude: 1 })).toEqual({ id: 1, name: 'A', phone: 'p' });
    expect(artisanForTracking({ id: 1, name: 'A', phone: 'p', email: 'e' })).toEqual({ name: 'A', phone: 'p' });
    expect(clientForArtisan({ id: 2, name: 'C', phone: 'p', email: 'e', address: 'a' })).toEqual({ id: 2, name: 'C', phone: 'p', email: 'e' });
    expect(artisanForClient(null)).toBeNull();
    expect(clientForArtisan(undefined)).toBeUndefined();
  });
});

describe('messages', () => {
  const all = poisonedJob().messages;

  it('each reader has their chats: never the internal one, never somebody else\'s, never a deleted message', () => {
    expect(messagesFor('client', all).map((message) => message.id)).toEqual([1, 2]);
    expect(messagesFor('artisan', all).map((message) => message.id)).toEqual([1, 3]);
    expect(chatsOf('client')).toEqual(['CLIENT_ARTISAN', 'CLIENT_SUPPORT']);
    expect(chatsOf('artisan')).toEqual(['CLIENT_ARTISAN', 'ARTISAN_SUPPORT']);
    expect(chatsOf('client')).not.toContain('INTERNAL_ADMIN');
    expect(chatsOf('artisan')).not.toContain('INTERNAL_ADMIN');
  });

  it('carries the writer\'s name and role, not the address, and not who else has read it', () => {
    for (const role of ['client', 'artisan'] as const) {
      expect(leaked(messagesFor(role, all))).toEqual([]);
    }

    expect(messageForParties(all[0]).sender).toEqual({ id: 20, name: 'Ali', role: 'ARTISAN' });
  });

  it('says whether the reader has read it (the writer has)', () => {
    const message = { ...all[1], readByUserIds: [10] };

    expect(messageForParties(message, 10).read).toBe(true);
    expect(messageForParties(message, 5).read).toBe(true);
    expect(messageForParties(message, 99).read).toBe(false);
    expect(messageForParties(message)).not.toHaveProperty('read');
    expect(messageForParties(null)).toBeNull();
  });

  it('a list that is not a list is empty', () => {
    expect(messagesFor('client', null)).toEqual([]);
    expect(messagesFor('artisan', undefined)).toEqual([]);
  });
});
