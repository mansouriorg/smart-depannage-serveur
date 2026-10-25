import {
  DispatchSort,
  canonicalStatus,
  dispatchViewOf,
  isDispatchSort,
  withAliases,
} from '../intervention-workflow/intervention-status';

/**
 * The dispatcher's list of jobs (P1-13): what to look for, in which order.
 *
 * `GET /admin/interventions` reads its query here and nowhere else, so the same rules are tested
 * without a database. It builds a Prisma `where` and `orderBy`; it does not touch the database.
 */

/** What the route reads from the query string (every field is text, or missing). */
export interface InterventionQueueQuery {
  status?: string;
  view?: string;
  serviceType?: string;
  urgency?: string;
  city?: string;
  artisanId?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  sort?: string;
}

/** The longest text looked for: a longer one is cut, not refused (a pasted address). */
export const MAX_SEARCH_LENGTH = 100;

/** The largest id the database holds (a 32-bit integer): a bigger one is no job. */
const MAX_ROW_ID = 2_147_483_647;

type Where = Record<string, unknown>;
type OrderBy = Array<Record<string, 'asc' | 'desc'>>;

/** A `where` that matches nothing: a filter that cannot be satisfied must not silently match everything. */
const NOTHING: Where = { id: { in: [] } };

/** Every stored spelling of the statuses of the tab and of the one status asked for, both when both are asked. */
function statusFilter(status: string | undefined, view: string | undefined): Where | null {
  let allowed: string[] | null = null;

  if (view) {
    const tab = dispatchViewOf(view);

    // A tab that does not exist is a mistake of the caller: nothing is shown, not everything.
    if (!tab) return NOTHING;

    allowed = withAliases(tab.statuses);
  }

  if (status) {
    const canonical = canonicalStatus(status);

    if (!canonical) return NOTHING;

    const spellings = withAliases([canonical]);

    // Both a tab and a status: only the statuses that are in both.
    allowed = allowed ? spellings.filter((spelling) => allowed!.includes(spelling)) : spellings;
  }

  if (allowed === null) return null;

  return allowed.length ? { status: { in: allowed } } : NOTHING;
}

/** The job number, when the text is one: "12" or "#12" (a number past the largest id is no job, however many digits it has). */
function jobNumber(text: string): number | null {
  const match = /^#?\s*(\d+)$/.exec(text);

  if (!match) return null;

  const id = Number(match[1]);

  return id >= 1 && id <= MAX_ROW_ID ? id : null;
}

/**
 * The ways a phone number may have been written in the database, for a search text that looks like
 * one: as typed, digits only, and a Tunisian local number in groups ("22 123 456"). The phone of a
 * request form is stored as the person typed it, so "22123456" would not find "22 123 456" without
 * this. Null for text that is not a phone number (fewer than four digits, or letters).
 */
export function phoneSearch(text: string): { variants: string[]; digits: string } | null {
  if (!/^[+\d\s().-]+$/.test(text)) return null;

  const digits = text.replace(/\D/g, '');

  if (digits.length < 4) return null;

  const local = digits.length === 11 && digits.startsWith('216') ? digits.slice(3) : digits;
  const grouped = local.length === 8 ? `${local.slice(0, 2)} ${local.slice(2, 5)} ${local.slice(5)}` : null;

  return { variants: [...new Set([text, digits, local, ...(grouped ? [grouped] : [])])], digits };
}

/** The conditions for a text typed in the search box: the job number, the person who asked, the address. */
function searchFilter(raw: string | undefined): Where | null {
  const text = withoutNul(String(raw ?? ''))
    .trim()
    .slice(0, MAX_SEARCH_LENGTH)
    .trim();

  if (!text) return null;

  const contains = { contains: text, mode: 'insensitive' };
  const id = jobNumber(text);
  const phone = phoneSearch(text);

  const phoneConditions: Where[] = phone
    ? [
        ...phone.variants.flatMap((variant) => [
          { contactPhone: { contains: variant, mode: 'insensitive' } },
          { client: { phone: { contains: variant, mode: 'insensitive' } } },
        ]),
        // The account's number also has one spelling for every way of writing it: "+21622123456".
        { client: { phoneKey: { contains: phone.digits } } },
      ]
    : [{ contactPhone: contains }, { client: { phone: contains } }];

  return {
    OR: [
      ...(id !== null ? [{ id }] : []),
      { contactName: contains },
      { contactEmail: contains },
      { address: contains },
      { client: { name: contains } },
      { client: { email: contains } },
      ...phoneConditions,
    ],
  };
}

/** Text for a database column: a NUL byte is refused by PostgreSQL (an error 500), so it is dropped. */
function withoutNul(text: string): string {
  return text.replace(/\u0000/g, '');
}

/** A date from the query, or null for text that is not one (the filter is then left out, as it always was). */
function dateOf(value: string | undefined): Date | null {
  if (!value) return null;

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

export function interventionQueueWhere(query: InterventionQueueQuery): Where {
  const where: Where = {};
  const and: Where[] = [];

  const status = statusFilter(query.status, query.view);

  if (status) Object.assign(where, status);

  if (query.serviceType) where.serviceType = query.serviceType;

  if (query.urgency) where.urgency = query.urgency;

  const city = withoutNul(String(query.city ?? '')).trim();

  if (city) where.address = { contains: city, mode: 'insensitive' };

  if (query.artisanId) {
    const artisanId = Number(query.artisanId);

    // "abc" is no artisan: nothing, not every job (Number('abc') is NaN, which Prisma refuses).
    if (!Number.isInteger(artisanId) || artisanId < 1 || artisanId > MAX_ROW_ID) and.push(NOTHING);
    else where.artisanId = artisanId;
  }

  const from = dateOf(query.dateFrom);
  const to = dateOf(query.dateTo);

  if (from || to) {
    where.createdAt = {
      ...(from ? { gte: from } : {}),
      ...(to ? { lte: to } : {}),
    };
  }

  const search = searchFilter(query.search);

  if (search) and.push(search);

  if (and.length) where.AND = and;

  return where;
}

/**
 * The order of the list. Ties are broken by the job number, so that a job never appears on two pages
 * or on none while the person turns them: the same request date is common (jobs made together).
 * `urgency` is an enum declared NORMAL, URGENT, EMERGENCY: descending puts the emergencies first.
 */
export function interventionQueueOrder(sort: string | undefined): OrderBy {
  const asked: DispatchSort = isDispatchSort(sort) ? sort : 'newest';

  if (asked === 'queue') return [{ urgency: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }];

  if (asked === 'oldest') return [{ createdAt: 'asc' }, { id: 'asc' }];

  return [{ createdAt: 'desc' }, { id: 'desc' }];
}

/**
 * What a row of the list holds. Chosen column by column: the list is read by the dispatcher's
 * screen, not by a file of everything (no tracking token, no staff notes, no signatures, no payment
 * details), and it is a page of twenty, not a page of twenty jobs with all their messages.
 */
export const interventionListSelect = {
  id: true,
  serviceType: true,
  status: true,
  urgency: true,
  address: true,
  preferredDate: true,
  preferredStartTime: true,
  preferredEndTime: true,
  contactName: true,
  contactPhone: true,
  artisanId: true,
  createdAt: true,
  client: { select: { id: true, name: true, phone: true } },
  artisan: { select: { id: true, name: true, phone: true } },
  subService: { select: { id: true, name: true } },
  appointment: { select: { startsAt: true, endsAt: true, status: true, artisanId: true } },
} as const;
