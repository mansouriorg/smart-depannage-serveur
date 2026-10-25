import { NOTHING, Where, idOf, likeContains, rowNumber, searchText, withoutNul } from '../../common/search/staff-search';

/**
 * The list of reviews of the back office (P2-09): which ones, in which order. `GET /reviews/admin` reads its query here and
 * nowhere else, so the same rules are tested without a database.
 *
 * A review is written by the customer and read by nobody before a moderator decides: PENDING until then, APPROVED (shown, and
 * counted in the artisan's rating), REJECTED or HIDDEN (shown to nobody; the reason is kept).
 */

export const REVIEW_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'HIDDEN'] as const;

export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const REVIEW_SORTS = ['oldest', 'newest'] as const;

/** The longest reason a moderator can give. */
export const MODERATION_REASON_MAX = 500;

/** What the route reads from the query string (text, or missing). */
export interface ReviewQueueQuery {
  status?: string;
  artisanId?: string | number;
  clientId?: string | number;
  interventionId?: string | number;
  onlyVisible?: boolean;
  /** The best rating that is shown: 2 asks for the 1- and 2-star reviews. */
  maxRating?: string | number;
  search?: string;
  sort?: string;
}

/** The most reviews a page holds, and how far a page can start: a count the database reads as a 32-bit number. */
export const REVIEW_PAGE_DEFAULT = 50;
export const REVIEW_PAGE_MAX = 100;
export const REVIEW_SKIP_MAX = 1_000_000;

/** The page asked for, made safe: a whole number of at least 1 and at most 100 reviews, starting at 0 or later. */
export function reviewPaging(query: { skip?: unknown; take?: unknown }): { skip: number; take: number } {
  const whole = (value: unknown): number => {
    const number = Number(value);

    return Number.isFinite(number) ? Math.trunc(number) : 0;
  };

  const asked = whole(query.take);

  return {
    skip: Math.min(Math.max(whole(query.skip), 0), REVIEW_SKIP_MAX),
    take: asked === 0 ? REVIEW_PAGE_DEFAULT : Math.min(Math.max(asked, 1), REVIEW_PAGE_MAX),
  };
}

export const isReviewStatus = (value: unknown): value is ReviewStatus => (REVIEW_STATUSES as readonly string[]).includes(String(value));

/** A text typed in the search box: the comment, the people, the number of the review or of the job. */
function searchFilter(raw: unknown): Where | null {
  const text = searchText(raw);

  if (!text) return null;

  const contains = likeContains(text);
  const id = rowNumber(text);

  return {
    OR: [
      ...(id !== null ? [{ id }, { interventionId: id }] : []),
      { comment: contains },
      { client: { name: contains } },
      { client: { email: contains } },
      { artisan: { name: contains } },
    ],
  };
}

/** The conditions every tab shares: what the counts of the tabs are taken under. */
export function reviewBaseWhere(query: ReviewQueueQuery): Where[] {
  const and: Where[] = [];
  const ids: Array<[string, unknown]> = [
    ['artisanId', query.artisanId],
    ['clientId', query.clientId],
    ['interventionId', query.interventionId],
  ];

  for (const [column, raw] of ids) {
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;

    const id = idOf(raw);

    // "abc" is no artisan: nothing, not every review.
    and.push(id === null ? NOTHING : { [column]: id });
  }

  if (query.onlyVisible !== undefined) and.push({ isVisible: query.onlyVisible });

  if (query.maxRating !== undefined && query.maxRating !== null && String(query.maxRating).trim() !== '') {
    const best = Number(query.maxRating);

    and.push(Number.isInteger(best) && best >= 1 && best <= 5 ? { rating: { lte: best } } : NOTHING);
  }

  const search = searchFilter(query.search);

  if (search) and.push(search);

  return and;
}

/** The `where` of the list: the base and the status of the tab. A status that does not exist matches nothing. */
export function reviewQueueWhere(query: ReviewQueueQuery): Where {
  const and = reviewBaseWhere(query);

  if (query.status !== undefined && query.status !== '') and.push(isReviewStatus(query.status) ? { status: query.status } : NOTHING);

  return and.length ? { AND: and } : {};
}

/** The order of the list. Ties are broken by the number, so that a review never shows on two pages or on none. */
export function reviewQueueOrder(sort: string | undefined): Array<Record<string, 'asc' | 'desc'>> {
  return sort === 'oldest' ? [{ createdAt: 'asc' }, { id: 'asc' }] : [{ createdAt: 'desc' }, { id: 'desc' }];
}

/** What a moderator must give to turn a review away: the reason, as text. Null when the decision needs none. */
export function moderationReasonProblem(status: string, reason: unknown): string | null {
  if (status !== 'REJECTED' && status !== 'HIDDEN') return null;

  const text = typeof reason === 'string' ? withoutNul(reason).trim() : '';

  if (text === '') return 'Indiquez pourquoi cet avis est refusé ou masqué.';

  return text.length > MODERATION_REASON_MAX ? `La raison ne peut pas dépasser ${MODERATION_REASON_MAX} caractères.` : null;
}
