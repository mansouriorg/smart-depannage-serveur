import * as fs from 'fs';
import * as path from 'path';

import { AdminService } from './admin.service';
import {
  MAX_SEARCH_LENGTH,
  interventionListSelect,
  interventionQueueOrder,
  interventionQueueWhere,
} from './intervention-queue';
import { CANONICAL_STATUSES, DISPATCH_VIEWS, withAliases } from '../intervention-workflow/intervention-status';

/** GET /admin/interventions: the dispatcher's list (P1-13). */

const where = (query: Record<string, string | undefined>) => interventionQueueWhere(query) as any;
/** True when the list holds a condition equal to this one (compared as JSON: the order of keys is the code's own). */
const holds = (list: any[], condition: unknown) => list.some((item) => JSON.stringify(item) === JSON.stringify(condition));
const NOTHING = { id: { in: [] } };

describe('interventionQueueWhere: no filter', () => {
  it('asks for every job', () => {
    expect(where({})).toEqual({});
  });

  it('blank filters ask for nothing in particular', () => {
    expect(where({ status: '', view: '', serviceType: '', urgency: '', city: '', artisanId: '', search: '   ', dateFrom: '', dateTo: '' })).toEqual({});
  });
});

describe('interventionQueueWhere: status and tab', () => {
  it('a status finds the rows stored with either spelling', () => {
    expect(where({ status: 'CREATED' }).status.in.sort()).toEqual(['CREATED', 'PENDING']);
    expect(where({ status: 'PENDING' }).status.in.sort()).toEqual(['CREATED', 'PENDING']);
    expect(where({ status: 'ARTISAN_ACCEPTED' }).status.in.sort()).toEqual(['ACCEPTED', 'ARTISAN_ACCEPTED']);
    expect(where({ status: 'WAITING_ADMIN_REVIEW' }).status.in.sort()).toEqual(['ADMIN_REVIEW', 'WAITING_ADMIN_REVIEW']);
  });

  it('a status with one spelling finds that one', () => {
    expect(where({ status: 'CANCELLED' })).toEqual({ status: { in: ['CANCELLED'] } });
    expect(where({ status: 'DISPUTED' })).toEqual({ status: { in: ['DISPUTED'] } });
  });

  it('a tab finds the stored spellings of all its statuses', () => {
    const toAssign = where({ view: 'toAssign' }).status.in.sort();

    expect(toAssign).toEqual(['ADMIN_REVIEW', 'CREATED', 'PENDING', 'QUOTE_ACCEPTED', 'WAITING_ADMIN_REVIEW']);
    expect(where({ view: 'quote' }).status.in).toEqual(['QUOTE_SENT']);
    expect(where({ view: 'done' }).status.in.sort()).toEqual(['COMPLETED', 'INVOICE_READY', 'INVOICE_SENT', 'PAID', 'PAYMENT_PENDING']);
  });

  it('the tabs together are every status in every spelling, and each job is in one tab', () => {
    const all = DISPATCH_VIEWS.flatMap((view) => where({ view: view.id }).status.in as string[]);

    expect(all.length).toBe(new Set(all).size);
    expect([...new Set(all)].sort()).toEqual(withAliases(CANONICAL_STATUSES).sort());
  });

  it('a tab and a status ask for what is in both', () => {
    expect(where({ view: 'toAssign', status: 'CREATED' }).status.in.sort()).toEqual(['CREATED', 'PENDING']);
    expect(where({ view: 'active', status: 'IN_PROGRESS' }).status.in).toEqual(['IN_PROGRESS']);
  });

  it('a tab and a status that share nothing find nothing (not everything)', () => {
    expect(where({ view: 'toAssign', status: 'PAID' })).toEqual(NOTHING);
    expect(where({ view: 'cancelled', status: 'CREATED' })).toEqual(NOTHING);
  });

  it('a tab or a status that does not exist finds nothing (not everything)', () => {
    expect(where({ view: 'everything' })).toEqual(NOTHING);
    expect(where({ view: 'constructor' })).toEqual(NOTHING);
    expect(where({ status: 'NOPE' })).toEqual(NOTHING);
    expect(where({ view: 'toAssign', status: 'NOPE' })).toEqual(NOTHING);
  });
});

describe('interventionQueueWhere: the other filters', () => {
  it('the trade, the urgency and the place', () => {
    const w = where({ serviceType: 'PLOMBIER', urgency: 'EMERGENCY', city: 'Tunis' });

    expect(w.serviceType).toBe('PLOMBIER');
    expect(w.urgency).toBe('EMERGENCY');
    expect(w.address).toEqual({ contains: 'Tunis', mode: 'insensitive' });
  });

  it('the artisan, as a number', () => {
    expect(where({ artisanId: '41' }).artisanId).toBe(41);
  });

  it('an artisan that is no number finds nothing (not every job)', () => {
    for (const bad of ['abc', '1.5', '-3', '0', '99999999999', 'Infinity', '4e2x']) {
      const w = where({ artisanId: bad });

      expect(w.artisanId).toBeUndefined();
      expect(w.AND).toEqual([NOTHING]);
    }
  });

  it('the dates bound the day the request was made', () => {
    const w = where({ dateFrom: '2026-10-01T00:00:00.000Z', dateTo: '2026-10-31T23:59:59.000Z' });

    expect(w.createdAt.gte).toEqual(new Date('2026-10-01T00:00:00.000Z'));
    expect(w.createdAt.lte).toEqual(new Date('2026-10-31T23:59:59.000Z'));
    expect(where({ dateFrom: '2026-10-01' }).createdAt).toEqual({ gte: new Date('2026-10-01') });
    expect(where({ dateTo: '2026-10-01' }).createdAt).toEqual({ lte: new Date('2026-10-01') });
  });

  it('a date that is no date is left out (it cannot become an invalid Date in the query)', () => {
    expect(where({ dateFrom: 'yesterday' }).createdAt).toBeUndefined();
    expect(where({ dateFrom: 'yesterday', dateTo: '2026-10-01' }).createdAt).toEqual({ lte: new Date('2026-10-01') });
  });

  it('all the filters together keep each of their conditions', () => {
    const w = where({ view: 'active', urgency: 'URGENT', serviceType: 'ELECTRICIEN', artisanId: '7', search: 'Salma' });

    expect(w.status.in.length).toBeGreaterThan(5);
    expect(w.urgency).toBe('URGENT');
    expect(w.serviceType).toBe('ELECTRICIEN');
    expect(w.artisanId).toBe(7);
    expect(w.AND.length).toBe(1);
  });
});

describe('interventionQueueWhere: search', () => {
  const conditions = (search: string) => where({ search }).AND[0].OR as any[];
  const keys = (search: string) => conditions(search).map((condition) => JSON.stringify(Object.keys(condition)) + JSON.stringify(Object.values(condition)));

  it('looks in the name, the phone, the e-mail and the address, of the form and of the account', () => {
    const found = conditions('salma');

    expect(holds(found, { contactName: { contains: 'salma', mode: 'insensitive' } })).toBe(true);
    expect(holds(found, { contactPhone: { contains: 'salma', mode: 'insensitive' } })).toBe(true);
    expect(holds(found, { contactEmail: { contains: 'salma', mode: 'insensitive' } })).toBe(true);
    expect(holds(found, { address: { contains: 'salma', mode: 'insensitive' } })).toBe(true);
    expect(holds(found, { client: { name: { contains: 'salma', mode: 'insensitive' } } })).toBe(true);
    expect(holds(found, { client: { phone: { contains: 'salma', mode: 'insensitive' } } })).toBe(true);
    expect(holds(found, { client: { email: { contains: 'salma', mode: 'insensitive' } } })).toBe(true);
  });

  it('a job number finds the job, as "12" or "#12"', () => {
    expect(holds(conditions('12'), { id: 12 })).toBe(true);
    expect(holds(conditions('#12'), { id: 12 })).toBe(true);
    expect(holds(conditions('# 12'), { id: 12 })).toBe(true);
    expect(holds(conditions(' 12 '), { id: 12 })).toBe(true);
  });

  it('a number is also looked for in the phones (a piece of a phone number is digits)', () => {
    expect(holds(conditions('2012'), { contactPhone: { contains: '2012', mode: 'insensitive' } })).toBe(true);
    expect(holds(conditions('2012'), { id: 2012 })).toBe(true);
  });

  it('a phone number is found whichever way it was written: digits, groups, or with the country code', () => {
    const phones = (search: string) => conditions(search).filter((condition) => 'contactPhone' in condition).map((condition) => condition.contactPhone.contains);
    const accounts = (search: string) => conditions(search).filter((condition) => condition.client && 'phone' in condition.client).map((condition) => condition.client.phone.contains);
    const keysOf = (search: string) => conditions(search).filter((condition) => condition.client && 'phoneKey' in condition.client).map((condition) => condition.client.phoneKey.contains);

    // Typed as digits, stored as "22 123 456" (the form keeps what was typed).
    expect(phones('22123456')).toContain('22 123 456');
    expect(accounts('22123456')).toContain('22 123 456');
    expect(keysOf('22123456')).toEqual(['22123456']);

    // Typed with the country code and spaces, stored as plain digits or as a local number.
    expect(phones('+216 22 123 456').sort()).toEqual(['+216 22 123 456', '21622123456', '22 123 456', '22123456'].sort());
    expect(keysOf('+216 22 123 456')).toEqual(['21622123456']);

    // A piece of a number typed with a space is also looked for as digits.
    expect(phones('22 123')).toContain('22123');
    expect(phones('22 123')).toContain('22 123');
  });

  it('text that is not a phone number is not looked for as one', () => {
    for (const text of ['salma', '12', '123', '12 rue des Roses', '#12', '1e3', 'ab-1234']) {
      expect(conditions(text).some((condition) => condition.client && 'phoneKey' in condition.client)).toBe(false);
    }

    expect(conditions('12').filter((condition) => 'contactPhone' in condition).length).toBe(1);
  });

  it('text that is not a number does not look for a job number', () => {
    expect(conditions('12 rue').some((condition) => 'id' in condition)).toBe(false);
    expect(conditions('1e3').some((condition) => 'id' in condition)).toBe(false);
    expect(conditions('0x10').some((condition) => 'id' in condition)).toBe(false);
    expect(conditions('-5').some((condition) => 'id' in condition)).toBe(false);
    expect(conditions('1.5').some((condition) => 'id' in condition)).toBe(false);
    expect(keys('abc').length).toBe(7);
  });

  it('a number the database cannot hold, and zero, are no job number (the query would fail)', () => {
    for (const text of ['0', '00', '2147483648', '99999999999', '#2147483648']) {
      expect(conditions(text).some((condition) => 'id' in condition)).toBe(false);
    }

    expect(holds(conditions('2147483647'), { id: 2147483647 })).toBe(true);
    expect(holds(conditions('1'), { id: 1 })).toBe(true);
  });

  it('is trimmed, and cut at the limit rather than refused', () => {
    expect(holds(conditions('  Salma  '), { contactName: { contains: 'Salma', mode: 'insensitive' } })).toBe(true);

    const long = 'a'.repeat(MAX_SEARCH_LENGTH + 50);
    const found = conditions(long)[0] as any;

    expect(found.contactName.contains.length).toBe(MAX_SEARCH_LENGTH);
  });

  it('the limit is a hundred characters, counted after the spaces around the text are removed', () => {
    expect(MAX_SEARCH_LENGTH).toBe(100);
    expect((conditions('b'.repeat(500))[0] as any).contactName.contains).toBe('b'.repeat(100));

    // Sixty spaces in front (a pasted address) do not eat the budget.
    const padded = `${' '.repeat(60)}${'c'.repeat(100)}`;

    expect((conditions(padded)[0] as any).contactName.contains).toBe('c'.repeat(100));
  });

  it('a cut that ends on a space does not leave it at the end', () => {
    const text = `${'a'.repeat(MAX_SEARCH_LENGTH - 1)} b`;
    const found = conditions(text)[0] as any;

    expect(found.contactName.contains).toBe('a'.repeat(MAX_SEARCH_LENGTH - 1));
  });

  it('is kept next to the tab, not instead of it', () => {
    const w = where({ view: 'toAssign', search: 'salma' });

    expect(w.status.in.length).toBeGreaterThan(0);
    expect(w.AND.length).toBe(1);
  });

  it('a NUL byte is dropped from the text (PostgreSQL refuses it: it would be an error 500), and a text of nothing else is no search', () => {
    expect(where({ search: 'sal\u0000ma' }).AND[0].OR[0]).toEqual({ contactName: { contains: 'salma', mode: 'insensitive' } });
    expect(where({ search: '\u0000\u0000' })).toEqual({});
    expect(where({ search: '  \u0000 ' })).toEqual({});
  });

  it('the same for the city', () => {
    expect(where({ city: 'Tu\u0000nis' }).address).toEqual({ contains: 'Tunis', mode: 'insensitive' });
    expect(where({ city: '\u0000' })).toEqual({});
    expect(where({ city: '  Sfax  ' }).address).toEqual({ contains: 'Sfax', mode: 'insensitive' });
  });

  it('a search with percent signs and quotes reaches the query as the text it is (the builder writes no SQL: Prisma sends it as a parameter)', () => {
    const w = where({ search: "%'; DROP TABLE" });

    expect(w.AND[0].OR[0]).toEqual({ contactName: { contains: "%'; DROP TABLE", mode: 'insensitive' } });
  });
});

describe('interventionQueueOrder', () => {
  it('"queue": the most urgent first, then the one that has waited longest, then the number', () => {
    expect(interventionQueueOrder('queue')).toEqual([{ urgency: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }]);
  });

  it('"newest" and "oldest" are by date, with the number to break ties', () => {
    expect(interventionQueueOrder('newest')).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(interventionQueueOrder('oldest')).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
  });

  it('without an order, or with one that does not exist, it is the newest first (what the route always did)', () => {
    expect(interventionQueueOrder(undefined)).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(interventionQueueOrder('')).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(interventionQueueOrder('urgency')).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(interventionQueueOrder('QUEUE')).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });

  it('every order ends with the number, so a page turn never repeats or skips a job', () => {
    for (const sort of ['queue', 'newest', 'oldest', undefined]) {
      const order = interventionQueueOrder(sort);

      expect(Object.keys(order[order.length - 1])).toEqual(['id']);
    }
  });
});

describe('interventionListSelect: what a row of the list holds', () => {
  const columns = Object.keys(interventionListSelect);

  it('is exactly this list of columns: adding one is a decision, and this test is where it is taken', () => {
    expect([...columns].sort()).toEqual(
      [
        'id', 'serviceType', 'status', 'urgency', 'address', 'preferredDate', 'preferredStartTime', 'preferredEndTime',
        'contactName', 'contactPhone', 'artisanId', 'createdAt', 'client', 'artisan', 'subService', 'appointment',
      ].sort(),
    );
    expect(Object.keys(interventionListSelect.appointment.select).sort()).toEqual(['artisanId', 'endsAt', 'startsAt', 'status']);
  });

  it('has what the queue shows', () => {
    for (const column of ['id', 'serviceType', 'status', 'urgency', 'address', 'createdAt', 'artisanId', 'client', 'artisan', 'subService', 'appointment', 'contactName', 'contactPhone']) {
      expect(columns).toContain(column);
    }
  });

  it('does not carry what the screen never shows: coordinates, the e-mail of the form, the description (the case file has them)', () => {
    for (const column of ['latitude', 'longitude', 'contactEmail', 'description', 'problemReported', 'hasIssue', 'updatedAt']) {
      expect(columns).not.toContain(column);
    }
  });

  it('has nothing that is not for a list: no tracking link, no staff notes, no signatures, no payments, no messages', () => {
    for (const column of ['trackingToken', 'adminInternalNotes', 'clientSignatureUrl', 'messages', 'payments', 'quotes', 'invoice', 'events', 'complaints', 'review', 'photos', 'materialUsed', 'diagnosticNotes', 'financials']) {
      expect(columns).not.toContain(column);
    }
  });

  it('shows the people as a name and a phone, never a password, a token or an e-mail of the artisan', () => {
    expect(Object.keys(interventionListSelect.client.select).sort()).toEqual(['id', 'name', 'phone']);
    expect(Object.keys(interventionListSelect.artisan.select).sort()).toEqual(['id', 'name', 'phone']);
  });
});

describe('the order of urgency in the database', () => {
  it('UrgencyLevel is declared NORMAL, URGENT, EMERGENCY: "urgency desc" puts the emergencies first', () => {
    const schema = fs.readFileSync(path.join(__dirname, '../../../prisma/schema.prisma'), 'utf8');
    const block = /enum UrgencyLevel \{([^}]*)\}/.exec(schema);

    expect(block).not.toBeNull();
    expect(block![1].split('\n').map((line) => line.trim()).filter(Boolean)).toEqual(['NORMAL', 'URGENT', 'EMERGENCY']);
    expect(interventionQueueOrder('queue')[0]).toEqual({ urgency: 'desc' });
  });
});

describe('AdminService.findAllInterventions', () => {
  function makeService(rows: any[] = [], total = rows.length) {
    const calls: any[] = [];
    const counts: any[] = [];
    const prisma: any = {
      intervention: {
        findMany: async (args: any) => {
          calls.push(args);
          return rows;
        },
        count: async (args: any) => {
          counts.push(args);
          return total;
        },
      },
    };

    return { service: new AdminService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any), calls, counts };
  }

  it('asks the database for the page, in the order of work, with the lean columns', async () => {
    const w = makeService([{ id: 1 }], 41);

    const page: any = await w.service.findAllInterventions({ page: '2', limit: '10', view: 'toAssign', sort: 'queue', search: '12' } as any);

    expect(w.calls.length).toBe(1);
    expect(w.calls[0].skip).toBe(10);
    expect(w.calls[0].take).toBe(10);
    expect(w.calls[0].orderBy).toEqual([{ urgency: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }]);
    expect(w.calls[0].select).toBe(interventionListSelect);
    expect(w.calls[0].include).toBeUndefined();
    expect(w.calls[0].where.status.in).toContain('PENDING');
    expect(page.data).toEqual([{ id: 1 }]);
    expect(page.meta).toEqual({ page: 2, limit: 10, total: 41, totalPages: 5 });
  });

  it('counts the same rows it lists (the total is of the filter, not of the table)', async () => {
    const w = makeService([], 0);

    await w.service.findAllInterventions({ view: 'active', urgency: 'EMERGENCY', search: 'salma' } as any);

    expect(w.counts.length).toBe(1);
    expect(w.counts[0].where).toEqual(w.calls[0].where);
    expect(w.counts[0].where.urgency).toBe('EMERGENCY');
  });

  it('without a query it is the first twenty, newest first, as it was', async () => {
    const w = makeService();

    const page: any = await w.service.findAllInterventions({} as any);

    expect(w.calls[0].skip).toBe(0);
    expect(w.calls[0].take).toBe(20);
    expect(w.calls[0].orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(w.calls[0].where).toEqual({});
    expect(page.meta).toEqual({ page: 1, limit: 20, total: 0, totalPages: 0 });
  });

  it('a page size above a hundred is a hundred, and a page below one is the first', async () => {
    const w = makeService();

    await w.service.findAllInterventions({ page: '-4', limit: '5000' } as any);

    expect(w.calls[0].skip).toBe(0);
    expect(w.calls[0].take).toBe(100);
  });
});
