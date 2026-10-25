import { MODERATION_REASON_MAX, REVIEW_PAGE_MAX, REVIEW_SKIP_MAX, REVIEW_SORTS, REVIEW_STATUSES, isReviewStatus, moderationReasonProblem, reviewBaseWhere, reviewPaging, reviewQueueOrder, reviewQueueWhere } from './review-queue';

/** GET /reviews/admin: the moderation queue's list, and the reason a moderator gives (P2-09). */

const NOTHING = { id: { in: [] } };
const where = (query: Record<string, any>) => reviewQueueWhere(query) as any;
const all = (built: any): any[] => built.AND ?? [];
const searchOf = (query: Record<string, any>): any => all(where(query)).find((condition) => condition.OR);

describe('reviewQueueWhere', () => {
  it('asks for every review when nothing is asked, and blank filters ask for nothing', () => {
    expect(where({})).toEqual({});
    expect(where({ status: '', search: '   ', maxRating: '', artisanId: '', clientId: ' ' })).toEqual({});
  });

  it('knows the four statuses of a review', () => {
    expect([...REVIEW_STATUSES]).toEqual(['PENDING', 'APPROVED', 'REJECTED', 'HIDDEN']);
    expect(REVIEW_STATUSES.every((status) => isReviewStatus(status))).toBe(true);
    expect(['', 'approved', 'DELETED', undefined, null].some((value) => isReviewStatus(value))).toBe(false);
  });

  it('a tab asks for its status, and a status that does not exist shows nothing', () => {
    expect(where({ status: 'PENDING' })).toEqual({ AND: [{ status: 'PENDING' }] });
    expect(where({ status: 'pending' })).toEqual({ AND: [NOTHING] });
  });

  it('asks for the reviews of an artisan, of a customer, of a job: a number, or nothing', () => {
    expect(where({ artisanId: '7', clientId: 3, interventionId: '12' })).toEqual({ AND: [{ artisanId: 7 }, { clientId: 3 }, { interventionId: 12 }] });
    expect(where({ artisanId: 'abc' })).toEqual({ AND: [NOTHING] });
    expect(where({ clientId: '-4' })).toEqual({ AND: [NOTHING] });
    expect(where({ interventionId: '99999999999' })).toEqual({ AND: [NOTHING] });
  });

  it('asks for the visible ones or for the others, and false is a real answer', () => {
    expect(where({ onlyVisible: true })).toEqual({ AND: [{ isVisible: true }] });
    expect(where({ onlyVisible: false })).toEqual({ AND: [{ isVisible: false }] });
  });

  it('asks for the reviews at most as good as a number of stars, from 1 to 5, and nothing for another number', () => {
    expect(where({ maxRating: '2' })).toEqual({ AND: [{ rating: { lte: 2 } }] });
    expect(where({ maxRating: 5 })).toEqual({ AND: [{ rating: { lte: 5 } }] });

    for (const bad of ['0', '6', '2.5', 'two', '-1']) expect(where({ maxRating: bad })).toEqual({ AND: [NOTHING] });
  });
});

describe('the search of the moderation queue', () => {
  it('looks in the words of the review and in the names of the people', () => {
    const contains = { contains: 'fuite', mode: 'insensitive' };

    expect(searchOf({ search: 'fuite' }).OR).toEqual([{ comment: contains }, { client: { name: contains } }, { client: { email: contains } }, { artisan: { name: contains } }]);
  });

  it('reads a number as the number of the review or of the job as well', () => {
    expect(searchOf({ search: '12' }).OR.slice(0, 2)).toEqual([{ id: 12 }, { interventionId: 12 }]);
    expect(searchOf({ search: '#12' }).OR.slice(0, 2)).toEqual([{ id: 12 }, { interventionId: 12 }]);
    expect(searchOf({ search: '1x2' }).OR.some((condition: any) => 'id' in condition)).toBe(false);
  });

  it('looks for "%" and "_" as themselves, not as the jokers of LIKE', () => {
    expect(searchOf({ search: '50%' }).OR).toEqual([{ comment: { contains: '50\\%', mode: 'insensitive' } }, { client: { name: { contains: '50\\%', mode: 'insensitive' } } }, { client: { email: { contains: '50\\%', mode: 'insensitive' } } }, { artisan: { name: { contains: '50\\%', mode: 'insensitive' } } }]);
    expect(searchOf({ search: 'a_b' }).OR[0]).toEqual({ comment: { contains: 'a\\_b', mode: 'insensitive' } });
    expect(JSON.stringify(searchOf({ search: '%' }))).not.toContain('"contains":"%"');
  });

  it('trims the text, and keeps a NUL byte out of the database', () => {
    expect(searchOf({ search: '  lent  ' }).OR[0]).toEqual({ comment: { contains: 'lent', mode: 'insensitive' } });
    expect(JSON.stringify(searchOf({ search: 'a\u0000b' }))).not.toContain('\\u0000');
  });
});

describe('the tabs and their counts', () => {
  it('the base leaves the status out, so that a tab can be counted under the filters of the others', () => {
    expect(reviewBaseWhere({ status: 'PENDING', maxRating: '2' })).toEqual([{ rating: { lte: 2 } }]);
    expect(reviewBaseWhere({ status: 'PENDING' })).toEqual([]);
  });
});

describe('reviewQueueOrder', () => {
  it('is the newest first, and the oldest first when asked; the number breaks the ties', () => {
    expect([...REVIEW_SORTS]).toEqual(['oldest', 'newest']);
    expect(reviewQueueOrder(undefined)).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(reviewQueueOrder('newest')).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(reviewQueueOrder('oldest')).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
    expect(reviewQueueOrder('sideways')).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });
});

describe('moderationReasonProblem', () => {
  it('asks for a reason to refuse or to hide a review', () => {
    for (const status of ['REJECTED', 'HIDDEN']) {
      for (const reason of [undefined, null, '', '   ', '\n\t', 12, {}]) {
        expect(moderationReasonProblem(status, reason)).toBe('Indiquez pourquoi cet avis est refusé ou masqué.');
      }

      expect(moderationReasonProblem(status, 'Propos injurieux')).toBeNull();
    }
  });

  it('asks for none to approve a review or to put it back to waiting', () => {
    for (const status of ['APPROVED', 'PENDING']) {
      expect(moderationReasonProblem(status, undefined)).toBeNull();
      expect(moderationReasonProblem(status, '')).toBeNull();
      expect(moderationReasonProblem(status, 'Vérifié avec le client')).toBeNull();
    }
  });

  it('does not take a NUL byte for a reason, nor count it in the length', () => {
    expect(moderationReasonProblem('HIDDEN', '\u0000')).toBe('Indiquez pourquoi cet avis est refusé ou masqué.');
    expect(moderationReasonProblem('REJECTED', ' \u0000 \u0000 ')).toBe('Indiquez pourquoi cet avis est refusé ou masqué.');
    expect(moderationReasonProblem('HIDDEN', `${'a'.repeat(500)}\u0000\u0000`)).toBeNull();
    expect(moderationReasonProblem('HIDDEN', `${'a'.repeat(250)}\u0000${'a'.repeat(251)}`)).toBe('La raison ne peut pas dépasser 500 caractères.');
  });

  it('takes a reason of 500 characters once trimmed, and no more', () => {
    expect(MODERATION_REASON_MAX).toBe(500);
    expect(moderationReasonProblem('HIDDEN', `  ${'a'.repeat(500)}  `)).toBeNull();
    expect(moderationReasonProblem('HIDDEN', 'a'.repeat(501))).toBe('La raison ne peut pas dépasser 500 caractères.');
    expect(moderationReasonProblem('REJECTED', 'é'.repeat(501))).toBe('La raison ne peut pas dépasser 500 caractères.');
  });
});

describe('the page of reviews asked for (P2-09)', () => {
  it('pages from the start, 50 at a time, and never more than 100 at once', () => {
    expect(reviewPaging({})).toEqual({ skip: 0, take: 50 });
    expect(reviewPaging({ skip: 20, take: 10 })).toEqual({ skip: 20, take: 10 });
    expect(reviewPaging({ skip: '20', take: '10' })).toEqual({ skip: 20, take: 10 });
    expect(reviewPaging({ take: 100 })).toEqual({ skip: 0, take: REVIEW_PAGE_MAX });
    expect(reviewPaging({ take: 101 })).toEqual({ skip: 0, take: 100 });
    expect(reviewPaging({ take: 100000 })).toEqual({ skip: 0, take: 100 });
    expect(reviewPaging({ take: 1 })).toEqual({ skip: 0, take: 1 });
  });

  it('turns a page that makes no sense into one that does, instead of letting the database fail', () => {
    // A negative take would read backwards, a negative skip is refused, a skip past 2 147 483 647 overflows.
    expect(reviewPaging({ take: -5, skip: -10 })).toEqual({ skip: 0, take: 1 });
    expect(reviewPaging({ take: 0 })).toEqual({ skip: 0, take: 50 });
    expect(reviewPaging({ skip: 3_000_000_000 })).toEqual({ skip: REVIEW_SKIP_MAX, take: 50 });
    expect(reviewPaging({ skip: Number.POSITIVE_INFINITY, take: Number.NaN })).toEqual({ skip: 0, take: 50 });
    expect(reviewPaging({ skip: 'abc', take: '' })).toEqual({ skip: 0, take: 50 });
    expect(reviewPaging({ skip: 2.9, take: 7.9 })).toEqual({ skip: 2, take: 7 });
    expect(reviewPaging({ skip: null, take: undefined })).toEqual({ skip: 0, take: 50 });
    expect(REVIEW_SKIP_MAX).toBe(1_000_000);
  });
});
