import { NOTHING, Where, idOf, likeContains, phoneConditions, rowNumber, searchText } from '../../common/search/staff-search';

/**
 * The list of complaints of the back office (P2-09): which ones, in which order, and what a row holds.
 *
 * `GET /admin/complaints` reads its query here and nowhere else, so the same rules are tested without a database. It builds a
 * Prisma `where` and `orderBy`; it does not touch the database.
 *
 * The views are what a person does with the list:
 *  - `todo`: the complaints that are open (new, being looked at, waiting for the customer or the artisan);
 *  - `decide`: open, and the customer asked for a refund that nobody has decided yet;
 *  - `pay`: a refund was accepted and the money has not all gone back (the status already says "refunded": see `complaintState`);
 *  - `unassigned`: open and handled by nobody;
 *  - `closed`: resolved, rejected or refunded (a refund still to pay is not closed);
 *  - `all`.
 */

export const COMPLAINT_VIEWS = ['todo', 'decide', 'pay', 'unassigned', 'closed', 'all'] as const;

export type ComplaintView = (typeof COMPLAINT_VIEWS)[number];

export const COMPLAINT_SORTS = ['oldest', 'newest'] as const;

export type ComplaintSort = (typeof COMPLAINT_SORTS)[number];

/** The statuses of a complaint that is still being worked on. */
export const OPEN_COMPLAINT_STATUSES = ['OPEN', 'IN_REVIEW', 'WAITING_CLIENT', 'WAITING_ARTISAN'] as const;

/** The statuses of a complaint that is over. */
export const CLOSED_COMPLAINT_STATUSES = ['RESOLVED', 'REJECTED', 'REFUNDED'] as const;

/** What the route reads from the query string (every field is text, or missing). */
export interface ComplaintQueueQuery {
  view?: string;
  status?: string;
  assignedToId?: string;
  mine?: string | boolean;
  search?: string;
  sort?: string;
}

export const isComplaintView = (value: unknown): value is ComplaintView => (COMPLAINT_VIEWS as readonly string[]).includes(String(value));

export const isComplaintSort = (value: unknown): value is ComplaintSort => (COMPLAINT_SORTS as readonly string[]).includes(String(value));

/** The condition of one view. */
export function complaintViewWhere(view: ComplaintView): Where {
  switch (view) {
    case 'todo':
      return { status: { in: [...OPEN_COMPLAINT_STATUSES] } };
    case 'decide':
      return { status: { in: [...OPEN_COMPLAINT_STATUSES] }, refundRequested: true, refundDecision: 'PENDING' };
    case 'pay':
      return { refundDecision: 'APPROVED' };
    case 'unassigned':
      return { status: { in: [...OPEN_COMPLAINT_STATUSES] }, assignedToId: null };
    case 'closed':
      return { status: { in: [...CLOSED_COMPLAINT_STATUSES] }, refundDecision: { not: 'APPROVED' } };
    default:
      return {};
  }
}

/** The conditions for a text typed in the search box: the number of the complaint or of the job, the words, the people, a phone. */
function searchFilter(raw: unknown): Where | null {
  const text = searchText(raw);

  if (!text) return null;

  const contains = likeContains(text);
  const id = rowNumber(text);

  return {
    OR: [
      ...(id !== null ? [{ id }, { interventionId: id }] : []),
      { title: contains },
      { description: contains },
      { user: { name: contains } },
      { user: { email: contains } },
      { intervention: { contactName: contains } },
      { intervention: { client: { name: contains } } },
      { intervention: { client: { email: contains } } },
      { intervention: { artisan: { name: contains } } },
      ...phoneConditions(
        text,
        [(value) => ({ user: { phone: value } }), (value) => ({ intervention: { contactPhone: value } }), (value) => ({ intervention: { client: { phone: value } } })],
        [(digits) => ({ user: { phoneKey: { contains: digits } } }), (digits) => ({ intervention: { client: { phoneKey: { contains: digits } } } })],
      ),
    ],
  };
}

/** Who handles it: an id, or the signed-in person (`mine`). A bad id is nobody: nothing, not everything. */
function assigneeFilter(query: ComplaintQueueQuery, actorId: number | null): Where | null {
  if (query.mine === true || query.mine === 'true' || query.mine === '1') return actorId === null ? NOTHING : { assignedToId: actorId };

  const raw = query.assignedToId;

  if (raw === undefined || raw === null || String(raw).trim() === '') return null;

  const id = idOf(raw);

  return id === null ? NOTHING : { assignedToId: id };
}

/** The conditions every tab shares (the search, the person who handles it): what the counts of the tabs are taken under. */
export function complaintBaseWhere(query: ComplaintQueueQuery, actorId: number | null = null): Where[] {
  const and: Where[] = [];
  const assignee = assigneeFilter(query, actorId);
  const search = searchFilter(query.search);

  if (assignee) and.push(assignee);

  if (search) and.push(search);

  return and;
}

/** The `where` of the list: the base, the view and the one status asked for (all three together). */
export function complaintQueueWhere(query: ComplaintQueueQuery, actorId: number | null = null): Where {
  const and = complaintBaseWhere(query, actorId);

  const view = query.view === undefined || query.view === '' ? null : query.view;

  // A view that does not exist is a mistake of the caller: nothing is shown, not everything.
  if (view !== null) and.push(isComplaintView(view) ? complaintViewWhere(view) : NOTHING);

  const status = query.status === undefined || query.status === '' ? null : query.status;

  if (status !== null) and.push({ status });

  return and.length ? { AND: and } : {};
}

/**
 * The order of the list. Ties are broken by the number, so that a complaint never appears on two pages or on none while the person
 * turns them: complaints made together share a date.
 */
export function complaintQueueOrder(sort: string | undefined): Array<Record<string, 'asc' | 'desc'>> {
  return sort === 'oldest' ? [{ createdAt: 'asc' }, { id: 'asc' }] : [{ createdAt: 'desc' }, { id: 'desc' }];
}

/**
 * What a row of the list holds, chosen column by column: the page of twenty is read by the list, and the long texts, the thread
 * and the money are read on the page of the complaint.
 */
export const complaintListSelect = {
  id: true,
  interventionId: true,
  title: true,
  status: true,
  assignedToId: true,
  refundRequested: true,
  refundDecision: true,
  refundApproved: true,
  refundAmount: true,
  adminDecision: true,
  createdAt: true,
  updatedAt: true,
  closedAt: true,
  user: { select: { id: true, name: true, role: true } },
  assignedTo: { select: { id: true, name: true, role: true } },
  intervention: {
    select: {
      id: true,
      serviceType: true,
      status: true,
      contactName: true,
      client: { select: { id: true, name: true } },
      artisan: { select: { id: true, name: true } },
    },
  },
} as const;
