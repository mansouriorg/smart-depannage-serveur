import {
  CLOSED_COMPLAINT_STATUSES,
  COMPLAINT_VIEWS,
  OPEN_COMPLAINT_STATUSES,
  complaintBaseWhere,
  complaintListSelect,
  complaintQueueOrder,
  complaintQueueWhere,
  complaintViewWhere,
  isComplaintSort,
  isComplaintView,
} from './complaint-queue';
import { MAX_SEARCH_LENGTH } from '../../common/search/staff-search';

/** GET /admin/complaints: the complaints screen's list (P2-09). */

const where = (query: Record<string, any>, actor: number | null = null) => complaintQueueWhere(query, actor) as any;
const NOTHING = { id: { in: [] } };
const all = (built: any): any[] => built.AND ?? [];
const searchOf = (query: Record<string, any>): any => all(where(query)).find((condition) => condition.OR);

describe('complaintQueueWhere: no filter', () => {
  it('asks for every complaint', () => {
    expect(where({})).toEqual({});
  });

  it('blank filters ask for nothing in particular', () => {
    expect(where({ view: '', status: '', assignedToId: '', search: '   ', mine: '' })).toEqual({});
  });
});

describe('the views', () => {
  it('are the six the screen has, and each is known as a view', () => {
    expect([...COMPLAINT_VIEWS]).toEqual(['todo', 'decide', 'pay', 'unassigned', 'closed', 'all']);
    expect(COMPLAINT_VIEWS.every((view) => isComplaintView(view))).toBe(true);
    expect(['', 'open', 'TODO', undefined, null, 3].some((value) => isComplaintView(value))).toBe(false);
  });

  it('todo is the complaints being worked on: new, looked at, waiting for the customer or for the artisan', () => {
    expect(complaintViewWhere('todo')).toEqual({ status: { in: ['OPEN', 'IN_REVIEW', 'WAITING_CLIENT', 'WAITING_ARTISAN'] } });
    expect([...OPEN_COMPLAINT_STATUSES]).toEqual(['OPEN', 'IN_REVIEW', 'WAITING_CLIENT', 'WAITING_ARTISAN']);
  });

  it('decide is the open complaints where the customer asked for a refund that nobody decided', () => {
    expect(complaintViewWhere('decide')).toEqual({ status: { in: ['OPEN', 'IN_REVIEW', 'WAITING_CLIENT', 'WAITING_ARTISAN'] }, refundRequested: true, refundDecision: 'PENDING' });
  });

  it('pay is the refunds that were accepted whatever the status says (the status already reads "refunded" on acceptance)', () => {
    expect(complaintViewWhere('pay')).toEqual({ refundDecision: 'APPROVED' });
  });

  it('unassigned is the open complaints that nobody handles', () => {
    expect(complaintViewWhere('unassigned')).toEqual({ status: { in: ['OPEN', 'IN_REVIEW', 'WAITING_CLIENT', 'WAITING_ARTISAN'] }, assignedToId: null });
  });

  it('closed is resolved, rejected or refunded, and leaves out a refund that still has to be paid', () => {
    expect(complaintViewWhere('closed')).toEqual({ status: { in: ['RESOLVED', 'REJECTED', 'REFUNDED'] }, refundDecision: { not: 'APPROVED' } });
    expect([...CLOSED_COMPLAINT_STATUSES]).toEqual(['RESOLVED', 'REJECTED', 'REFUNDED']);
  });

  it('all asks for nothing', () => {
    expect(complaintViewWhere('all')).toEqual({});
  });

  it('together, the open statuses and the closed ones are every status a complaint has, once', () => {
    expect([...OPEN_COMPLAINT_STATUSES, ...CLOSED_COMPLAINT_STATUSES].sort()).toEqual(['IN_REVIEW', 'OPEN', 'REFUNDED', 'REJECTED', 'RESOLVED', 'WAITING_ARTISAN', 'WAITING_CLIENT']);
  });
});

describe('complaintQueueWhere: view and status', () => {
  it('a view asks for its own condition', () => {
    expect(where({ view: 'pay' })).toEqual({ AND: [{ refundDecision: 'APPROVED' }] });
    expect(where({ view: 'all' })).toEqual({ AND: [{}] });
  });

  it('a view that does not exist is a mistake of the caller: nothing is shown, not everything', () => {
    expect(where({ view: 'open' })).toEqual({ AND: [NOTHING] });
    expect(where({ view: 'TODO' })).toEqual({ AND: [NOTHING] });
  });

  it('a status asks for that status, and a view with a status asks for what is in both', () => {
    expect(where({ status: 'RESOLVED' })).toEqual({ AND: [{ status: 'RESOLVED' }] });
    expect(where({ view: 'todo', status: 'OPEN' })).toEqual({ AND: [complaintViewWhere('todo'), { status: 'OPEN' }] });
  });
});

describe('complaintQueueWhere: who handles it', () => {
  it('an id asks for the complaints that person handles', () => {
    expect(where({ assignedToId: '7' })).toEqual({ AND: [{ assignedToId: 7 }] });
  });

  it('"mine" is the signed-in person, whichever way it is written', () => {
    for (const mine of ['true', '1', true]) expect(where({ mine }, 9)).toEqual({ AND: [{ assignedToId: 9 }] });

    for (const mine of ['false', '0', false, undefined]) expect(where({ mine }, 9)).toEqual({});
  });

  it('"mine" with nobody signed in matches nothing, and wins over an id', () => {
    expect(where({ mine: 'true' }, null)).toEqual({ AND: [NOTHING] });
    expect(where({ mine: 'true', assignedToId: '3' }, 9)).toEqual({ AND: [{ assignedToId: 9 }] });
  });

  it('an id that is no person is nobody: nothing, not every complaint', () => {
    for (const bad of ['abc', '0', '-2', '1.5', '2147483648', 'NaN']) expect(where({ assignedToId: bad })).toEqual({ AND: [NOTHING] });
  });
});

describe('complaintQueueWhere: the search box', () => {
  it('a number is the complaint or the job of that number', () => {
    const search = searchOf({ search: '12' });

    expect(search.OR.slice(0, 2)).toEqual([{ id: 12 }, { interventionId: 12 }]);
    expect(searchOf({ search: '#12' }).OR.slice(0, 2)).toEqual([{ id: 12 }, { interventionId: 12 }]);
    expect(searchOf({ search: ' # 12 ' }).OR.slice(0, 2)).toEqual([{ id: 12 }, { interventionId: 12 }]);
  });

  it('a number past the largest id is no row, and zero is none', () => {
    for (const text of ['2147483648', '99999999999999999999', '0', '#0']) {
      const holds = (searchOf({ search: text }).OR as any[]).some((condition) => 'interventionId' in condition);

      expect(holds).toBe(false);
    }

    expect((searchOf({ search: '2147483647' }).OR as any[]).some((condition) => condition.id === 2147483647)).toBe(true);
  });

  it('words are looked for in the title, the text, the people and the job', () => {
    const contains = { contains: 'fuite', mode: 'insensitive' };
    const found = searchOf({ search: 'fuite' }).OR;

    const holds = (condition: unknown) => found.some((item: unknown) => JSON.stringify(item) === JSON.stringify(condition));

    for (const condition of [
      { title: contains },
      { description: contains },
      { user: { name: contains } },
      { user: { email: contains } },
      { intervention: { contactName: contains } },
      { intervention: { client: { name: contains } } },
      { intervention: { artisan: { name: contains } } },
    ]) {
      expect(holds(condition)).toBe(true);
    }

    expect(found.some((condition: any) => 'id' in condition)).toBe(false);
  });

  it('a phone number is looked for as typed, in digits, in groups, and as the account key, in every place a number is kept', () => {
    const found = JSON.stringify(searchOf({ search: '22 123 456' }).OR);

    for (const variant of ['22 123 456', '22123456']) {
      expect(found).toContain(`"user":{"phone":{"contains":"${variant}"`);
      expect(found).toContain(`"intervention":{"contactPhone":{"contains":"${variant}"`);
      expect(found).toContain(`"intervention":{"client":{"phone":{"contains":"${variant}"`);
    }

    expect(found).toContain('"user":{"phoneKey":{"contains":"22123456"}}');
  });

  it('a +216 number also finds the local one', () => {
    expect(JSON.stringify(searchOf({ search: '+216 22 123 456' }).OR)).toContain('"contains":"22123456"');
  });

  it('a text that is not a phone number is looked for as it is in the three numbers, with no account key', () => {
    const found = JSON.stringify(searchOf({ search: 'ab12' }).OR);

    expect(found).toContain('"user":{"phone":{"contains":"ab12","mode":"insensitive"}}');
    expect(found).not.toContain('phoneKey');
  });

  it('words are also looked for in the e-mail of the customer of the job', () => {
    const contains = { contains: 'salma', mode: 'insensitive' };

    expect(searchOf({ search: 'salma' }).OR.some((condition: unknown) => JSON.stringify(condition) === JSON.stringify({ intervention: { client: { email: contains } } }))).toBe(true);
  });

  it('a phone number is also looked for in the account key of the customer of the job', () => {
    const found = searchOf({ search: '22 123 456' }).OR;

    expect(found.some((condition: unknown) => JSON.stringify(condition) === JSON.stringify({ intervention: { client: { phoneKey: { contains: '22123456' } } } }))).toBe(true);
    expect(found.some((condition: unknown) => JSON.stringify(condition) === JSON.stringify({ user: { phoneKey: { contains: '22123456' } } }))).toBe(true);
  });

  it('"%" and "_" are looked for as themselves, not as the jokers of LIKE, in the words and in the e-mails', () => {
    const percent = JSON.stringify(searchOf({ search: '50%' }).OR);

    expect(percent).toContain('"title":{"contains":"50\\\\%","mode":"insensitive"}');
    expect(percent).toContain('"user":{"email":{"contains":"50\\\\%","mode":"insensitive"}}');
    expect(percent).toContain('"client":{"email":{"contains":"50\\\\%","mode":"insensitive"}}');
    expect(percent).not.toContain('"contains":"50%"');

    const underscore = JSON.stringify(searchOf({ search: 'a_b' }).OR);

    expect(underscore).toContain('"description":{"contains":"a\\\\_b","mode":"insensitive"}');
    expect(underscore).toContain('"user":{"phone":{"contains":"a\\\\_b","mode":"insensitive"}}');
    expect(underscore).not.toContain('"contains":"a_b"');
  });

  it('a NUL byte is dropped (PostgreSQL refuses it) and a long text is cut', () => {
    expect(JSON.stringify(searchOf({ search: 'fu\u0000ite' }))).toContain('"contains":"fuite"');
    expect(where({ search: '\u0000\u0000' })).toEqual({});

    const long = searchOf({ search: 'a'.repeat(MAX_SEARCH_LENGTH + 50) });

    expect(JSON.stringify(long)).toContain(`"contains":"${'a'.repeat(MAX_SEARCH_LENGTH)}"`);
    expect(JSON.stringify(long)).not.toContain('a'.repeat(MAX_SEARCH_LENGTH + 1));
  });

  it('is applied together with the view and the person', () => {
    const built = where({ view: 'todo', search: 'fuite', mine: 'true' }, 4);

    expect(all(built)).toHaveLength(3);
    expect(all(built)[0]).toEqual({ assignedToId: 4 });
    expect(all(built)[1].OR).toBeDefined();
    expect(all(built)[2]).toEqual(complaintViewWhere('todo'));
  });
});

describe('complaintBaseWhere: what the counts of the views are taken under', () => {
  it('holds the person and the search, and neither the view nor the status', () => {
    expect(complaintBaseWhere({ view: 'todo', status: 'OPEN' })).toEqual([]);
    expect(complaintBaseWhere({ search: 'fuite', mine: 'true' }, 4)).toHaveLength(2);
    expect(complaintBaseWhere({ assignedToId: '5' })).toEqual([{ assignedToId: 5 }]);
  });
});

describe('complaintQueueOrder', () => {
  it('puts the oldest first for the work queue, the newest first otherwise, and breaks ties by the number', () => {
    expect(complaintQueueOrder('oldest')).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
    expect(complaintQueueOrder('newest')).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(complaintQueueOrder(undefined)).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(complaintQueueOrder('sideways')).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });

  it('knows its sorts', () => {
    expect(isComplaintSort('oldest') && isComplaintSort('newest')).toBe(true);
    expect(isComplaintSort('queue') || isComplaintSort('')).toBe(false);
  });
});

describe('complaintListSelect: what a row of the list holds', () => {
  it('is chosen column by column: no long text, no thread, no notes, no contact detail of the people', () => {
    const select = complaintListSelect as Record<string, any>;

    for (const heavy of ['description', 'clientMessage', 'artisanResponse', 'adminNotes', 'internalNotes', 'resolutionNotes', 'photos', 'attachments', 'messages', 'adminDecisionNote']) {
      expect(heavy in select).toBe(false);
    }

    for (const person of [select.user, select.assignedTo, select.intervention.select.client, select.intervention.select.artisan]) {
      expect(Object.keys(person.select).sort()).toEqual(Object.keys(person.select).includes('role') ? ['id', 'name', 'role'] : ['id', 'name']);
    }

    expect(Object.keys(select.intervention.select).sort()).toEqual(['artisan', 'client', 'contactName', 'id', 'serviceType', 'status']);
  });

  it('holds what the list shows of the refund: the request, the decision and the amount', () => {
    for (const column of ['refundRequested', 'refundDecision', 'refundApproved', 'refundAmount', 'status', 'assignedToId', 'createdAt', 'closedAt']) {
      expect((complaintListSelect as Record<string, unknown>)[column]).toBe(true);
    }
  });
});
