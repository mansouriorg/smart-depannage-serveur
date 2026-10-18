/**
 * The shape of a list that is answered a page at a time, and of the error body (P1-09).
 *
 * This file imports nothing, on purpose: it is copied as it is into the shared package
 * (smart-depannage-shared) and from there into the admin dashboard, the mobile app and the
 * website, so the server and the three apps read the same two types. Change it here, run
 * `npm run contract:generate`, and an app that reads the old shape stops compiling.
 */

/** Where a page stands in the whole list. */
export interface PageMeta {
  /** The page that was asked for, counted from 1. */
  page: number;
  /** How many rows a page holds at most. */
  limit: number;
  /** How many rows the whole list has. */
  total: number;
  /** How many pages the whole list makes (0 for an empty list). */
  totalPages: number;
}

/** A page of a list: the rows, and where the page stands. */
export interface Paginated<T> {
  data: T[];
  meta: PageMeta;
}

/** A list that is paged by "skip this many, take this many" (the proofs) also says so. */
export interface OffsetPageMeta extends PageMeta {
  take: number;
  skip: number;
}

export interface OffsetPaginated<T> {
  data: T[];
  meta: OffsetPageMeta;
}

/** The meta of a page: `totalPages` is worked out here, so no list works it out its own way. */
export function pageMeta(page: number, limit: number, total: number): PageMeta {
  return {
    page,
    limit,
    total,
    totalPages: limit > 0 ? Math.ceil(total / limit) : 0,
  };
}

export function paginated<T>(data: T[], page: number, limit: number, total: number): Paginated<T> {
  return { data, meta: pageMeta(page, limit, total) };
}

/** The same for a list paged by `take` and `skip`; `page` is the page the first row falls on. */
export function offsetPaginated<T>(data: T[], take: number, skip: number, total: number): OffsetPaginated<T> {
  const page = take > 0 ? Math.floor(skip / take) + 1 : 1;

  return { data, meta: { ...pageMeta(page, take, total), take, skip } };
}

/**
 * The rows of an answer that is either a page or (an older route) a bare list.
 * Typed on purpose: a payload that is neither does not compile, instead of becoming an empty list.
 */
export function pageItems<T>(payload: Paginated<T> | readonly T[] | null | undefined): T[] {
  if (Array.isArray(payload)) return [...(payload as readonly T[])];

  const rows = (payload as Paginated<T> | null | undefined)?.data;

  return Array.isArray(rows) ? [...rows] : [];
}

/** The body of a refused request: `message` is a sentence, or one per rule that was broken. */
export interface ApiErrorBody {
  statusCode?: number;
  message?: string | string[];
  error?: string;
  /** Why an artisan is not free ("Artisan déjà réservé sur ce créneau."). */
  issues?: string[];
}
