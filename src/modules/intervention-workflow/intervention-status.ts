/**
 * Intervention status rules (P1-01).
 *
 * This file is the single answer to two questions:
 *   1. which status may follow which one, and
 *   2. who (staff, the assigned artisan, the client, an automatic process)
 *      may make that move.
 *
 * Nothing here touches the database or imports the Prisma client, so the
 * rules can be unit tested on their own and reused by the apps later (P1-09).
 *
 * The database enum holds two vocabularies for historical reasons. The old
 * names (PENDING, ADMIN_REVIEW, ACCEPTED, ON_THE_WAY, ARRIVED, INVOICE_READY)
 * are what the admin dashboard, the mobile app and the website still send and
 * show. The new names are what the quote, payment, invoice and scheduling
 * modules write. Both mean the same thing: `canonicalStatus()` maps every
 * spelling to one meaning and the table below is written in that meaning only.
 *
 * Which spelling gets STORED is decided by `storageStatus()`. It keeps the
 * spelling that the caller used until `STATUS_STORAGE=canonical` is set, which
 * must wait until the three apps are migrated (P1-12, P1-15, P1-16).
 */

export const CANONICAL_STATUSES = [
  'CREATED',
  'WAITING_ADMIN_REVIEW',
  'QUOTE_SENT',
  'QUOTE_ACCEPTED',
  'ASSIGNED',
  'ARTISAN_ACCEPTED',
  'ARTISAN_ON_THE_WAY',
  'ARTISAN_ARRIVED',
  'IN_PROGRESS',
  'WAITING_CLIENT_VALIDATION',
  'COMPLETED',
  'PAYMENT_PENDING',
  'PAID',
  'INVOICE_SENT',
  'CANCELLED',
  'DISPUTED',
] as const;

export type CanonicalStatus = (typeof CANONICAL_STATUSES)[number];

/** Old spelling -> the status it means. */
export const LEGACY_STATUS_ALIASES: Record<string, CanonicalStatus> = {
  PENDING: 'CREATED',
  ADMIN_REVIEW: 'WAITING_ADMIN_REVIEW',
  ACCEPTED: 'ARTISAN_ACCEPTED',
  ON_THE_WAY: 'ARTISAN_ON_THE_WAY',
  ARRIVED: 'ARTISAN_ARRIVED',
  INVOICE_READY: 'INVOICE_SENT',
};

/** Who is making the change. `system` is a domain service that already checked the caller. */
export type ActorKind = 'staff' | 'artisan' | 'client' | 'system';

export type StatusActor = {
  kind: ActorKind;
  userId?: number;
};

/** Roles that work on tickets from the back office (same list as TICKET_STAFF_ROLES). */
const STAFF_ROLE_NAMES = ['ADMIN', 'SUPER_ADMIN', 'SUPPORT', 'DISPATCHER'];

// ----------------------------------------------------------
// Spellings
// ----------------------------------------------------------

export function canonicalStatus(status: string | null | undefined): CanonicalStatus | null {
  if (!status) return null;

  const mapped = LEGACY_STATUS_ALIASES[status];
  if (mapped) return mapped;

  return (CANONICAL_STATUSES as readonly string[]).includes(status)
    ? (status as CanonicalStatus)
    : null;
}

/** Every spelling stored in the database for one status, the canonical one first. */
export function spellingsOf(status: CanonicalStatus): string[] {
  const legacy = Object.keys(LEGACY_STATUS_ALIASES).filter(
    (name) => LEGACY_STATUS_ALIASES[name] === status,
  );

  return [status, ...legacy];
}

/**
 * Use in WHERE filters: every stored spelling of the given statuses, whichever
 * vocabulary they are written in. `where: { status: { in: withAliases([...]) } }`
 * keeps working before and after the storage vocabulary changes.
 */
export function withAliases(statuses: readonly string[]): string[] {
  const out = new Set<string>();

  for (const status of statuses) {
    const canonical = canonicalStatus(status);

    if (!canonical) {
      out.add(status);
      continue;
    }

    spellingsOf(canonical).forEach((spelling) => out.add(spelling));
  }

  return [...out];
}

/**
 * The STATUS_STORAGE setting. Read through `globalThis`, not through a bare `process`, so this
 * file also compiles where it is copied (the apps, P1-09): where there is no `process`, the
 * answer is "not set".
 */
function configuredStorageMode(): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.STATUS_STORAGE;
}

/** Which spelling to write. Identity until STATUS_STORAGE=canonical. */
export function storageStatus(
  status: string,
  mode: string | undefined = configuredStorageMode(),
): string {
  if (String(mode ?? '').toLowerCase() !== 'canonical') {
    return status;
  }

  return canonicalStatus(status) ?? status;
}

/**
 * Status of a brand new request, for `prisma.intervention.create`.
 * PENDING (the spelling the apps know) until STATUS_STORAGE=canonical, then CREATED.
 */
export function initialStatus(mode: string | undefined = configuredStorageMode()): string {
  return storageStatus('PENDING', mode);
}

// ----------------------------------------------------------
// Groups used by dashboards and lists
// ----------------------------------------------------------

export const STATUS_GROUPS = {
  /** Waiting for the back office or the client before work can be planned. */
  waiting: ['CREATED', 'WAITING_ADMIN_REVIEW', 'QUOTE_SENT', 'QUOTE_ACCEPTED'],
  /** An artisan is on it, from assignment to payment. */
  active: [
    'ASSIGNED',
    'ARTISAN_ACCEPTED',
    'ARTISAN_ON_THE_WAY',
    'ARTISAN_ARRIVED',
    'IN_PROGRESS',
    'WAITING_CLIENT_VALIDATION',
    'PAYMENT_PENDING',
  ],
  /** The job is done. */
  completed: ['COMPLETED', 'PAID', 'INVOICE_SENT'],
  cancelled: ['CANCELLED'],
  disputed: ['DISPUTED'],
} as const satisfies Record<string, readonly CanonicalStatus[]>;

export type StatusGroup = keyof typeof STATUS_GROUPS;

/**
 * The statuses in which the visitor with the tracking link may report a delay or a problem: the
 * artisan is on the job. The server refuses the report in any other status, and the website shows
 * the buttons only in these (it reads this list from its copy of this file).
 */
export const VISITOR_MAY_REPORT_ISSUE_IN = [
  'ARTISAN_ACCEPTED',
  'ARTISAN_ON_THE_WAY',
  'ARTISAN_ARRIVED',
  'IN_PROGRESS',
] as const satisfies readonly CanonicalStatus[];

export function visitorMayReportIssue(status: string | null | undefined): boolean {
  const canonical = canonicalStatus(status);

  return canonical !== null && (VISITOR_MAY_REPORT_ISSUE_IN as readonly string[]).includes(canonical);
}

/** Stored spellings of a group, for `where: { status: { in: statusesInGroup('active') } }`. */
export function statusesInGroup(group: StatusGroup): string[] {
  return withAliases(STATUS_GROUPS[group]);
}

// ----------------------------------------------------------
// The dispatcher's queue (P1-13)
// ----------------------------------------------------------

export interface DispatchView {
  id: string;
  label: string;
  statuses: readonly CanonicalStatus[];
}

/**
 * The tabs of the dispatcher's list. Every status is in exactly one of them (the spec fails
 * when a status is added to the table and not placed here), so a job never falls out of the
 * queue; "all" is the absence of a tab.
 *
 *  - toAssign: nobody has the job and it is ready to be given to somebody (a request that came in,
 *    one the back office has looked at, one whose quote the customer accepted);
 *  - quote: waiting for the customer's answer, nothing to dispatch yet.
 */
export const DISPATCH_VIEWS = [
  { id: 'toAssign', label: 'À assigner', statuses: ['CREATED', 'WAITING_ADMIN_REVIEW', 'QUOTE_ACCEPTED'] },
  { id: 'quote', label: 'Devis envoyés', statuses: ['QUOTE_SENT'] },
  {
    id: 'active',
    label: 'En cours',
    statuses: ['ASSIGNED', 'ARTISAN_ACCEPTED', 'ARTISAN_ON_THE_WAY', 'ARTISAN_ARRIVED', 'IN_PROGRESS', 'WAITING_CLIENT_VALIDATION'],
  },
  { id: 'done', label: 'Terminées', statuses: ['COMPLETED', 'PAYMENT_PENDING', 'PAID', 'INVOICE_SENT'] },
  { id: 'cancelled', label: 'Annulées', statuses: ['CANCELLED'] },
  { id: 'disputed', label: 'Litiges', statuses: ['DISPUTED'] },
] as const satisfies readonly DispatchView[];

export type DispatchViewId = (typeof DISPATCH_VIEWS)[number]['id'];

export const DISPATCH_VIEW_IDS: readonly DispatchViewId[] = DISPATCH_VIEWS.map((view) => view.id);

/** The tab with this id; undefined for anything else (a made-up id is not "everything"). */
export function dispatchViewOf(id: unknown): (typeof DISPATCH_VIEWS)[number] | undefined {
  return DISPATCH_VIEWS.find((view) => view.id === id);
}

/**
 * How the list is ordered. `queue` is the order of work: the most urgent first, and among equals
 * the one that has waited longest. `newest` and `oldest` are by date of the request alone.
 */
export const DISPATCH_SORTS = ['queue', 'newest', 'oldest'] as const;

export type DispatchSort = (typeof DISPATCH_SORTS)[number];

export function isDispatchSort(value: unknown): value is DispatchSort {
  return (DISPATCH_SORTS as readonly unknown[]).includes(value);
}

// ----------------------------------------------------------
// Who may move a job from one status to the next
// ----------------------------------------------------------

type Edges = Partial<Record<CanonicalStatus, readonly ActorKind[]>>;

const S: ActorKind = 'staff';
const A: ActorKind = 'artisan';
const C: ActorKind = 'client';
const Y: ActorKind = 'system';

/**
 * TRANSITIONS[from][to] = who may do it.
 *
 * Moves marked "shortcut" exist only because the deployed mobile app still
 * jumps straight to IN_PROGRESS. They go away with P1-15.
 */
export const TRANSITIONS: Record<CanonicalStatus, Edges> = {
  CREATED: {
    WAITING_ADMIN_REVIEW: [S, Y],
    QUOTE_SENT: [S, Y],
    ASSIGNED: [S, Y],
    // staff assigns an artisan (admin dropdown) or an artisan takes an open job
    ARTISAN_ACCEPTED: [S, A],
    CANCELLED: [S, C],
  },

  WAITING_ADMIN_REVIEW: {
    QUOTE_SENT: [S, Y],
    ASSIGNED: [S, Y],
    ARTISAN_ACCEPTED: [S, A],
    CANCELLED: [S, C],
    DISPUTED: [S],
  },

  QUOTE_SENT: {
    QUOTE_ACCEPTED: [S, C, Y],
    WAITING_ADMIN_REVIEW: [S, Y],
    ASSIGNED: [S],
    ARTISAN_ACCEPTED: [S],
    CANCELLED: [S, C],
    DISPUTED: [S],
  },

  QUOTE_ACCEPTED: {
    ASSIGNED: [S, Y],
    ARTISAN_ACCEPTED: [S, A],
    CANCELLED: [S, C],
    DISPUTED: [S, C],
  },

  ASSIGNED: {
    ARTISAN_ACCEPTED: [S, A],
    // the artisan declines, or staff takes the job back: it returns to the dispatcher queue
    WAITING_ADMIN_REVIEW: [S, A],
    IN_PROGRESS: [S, A], // shortcut
    CANCELLED: [S, C],
    DISPUTED: [S, A],
  },

  ARTISAN_ACCEPTED: {
    ARTISAN_ON_THE_WAY: [S, A],
    IN_PROGRESS: [S, A], // shortcut
    ASSIGNED: [S], // staff gives the job to another artisan
    WAITING_ADMIN_REVIEW: [S, A],
    CANCELLED: [S, C],
    DISPUTED: [S, C, A],
  },

  ARTISAN_ON_THE_WAY: {
    ARTISAN_ARRIVED: [S, A],
    IN_PROGRESS: [S, A], // shortcut
    ASSIGNED: [S],
    ARTISAN_ACCEPTED: [S], // staff hands the job to another artisan (legacy PATCH)
    WAITING_ADMIN_REVIEW: [S, A],
    CANCELLED: [S, C],
    DISPUTED: [S, C, A],
  },

  ARTISAN_ARRIVED: {
    IN_PROGRESS: [S, A],
    ASSIGNED: [S],
    ARTISAN_ACCEPTED: [S], // staff hands the job to another artisan (legacy PATCH)
    WAITING_ADMIN_REVIEW: [S, A],
    CANCELLED: [S, C],
    DISPUTED: [S, C, A],
  },

  IN_PROGRESS: {
    WAITING_CLIENT_VALIDATION: [S, A],
    COMPLETED: [S, A],
    ASSIGNED: [S], // the artisan cannot finish: staff gives the job to somebody else
    ARTISAN_ACCEPTED: [S], // same, through the legacy PATCH
    CANCELLED: [S],
    DISPUTED: [S, C, A],
  },

  // From here on the artisan can still report a problem (a client who will not
  // pay, say): the report and the dispute status go together.
  WAITING_CLIENT_VALIDATION: {
    COMPLETED: [S, C, Y],
    CANCELLED: [S],
    DISPUTED: [S, C, A],
  },

  COMPLETED: {
    PAYMENT_PENDING: [S, C, Y],
    PAID: [S, Y],
    INVOICE_SENT: [S, Y],
    DISPUTED: [S, C, A],
  },

  PAYMENT_PENDING: {
    PAID: [S, Y],
    INVOICE_SENT: [S, Y],
    DISPUTED: [S, C, A],
  },

  PAID: {
    INVOICE_SENT: [S, Y],
    DISPUTED: [S, C, A],
  },

  // An invoice can go out before the money comes in, so it can still be paid.
  INVOICE_SENT: {
    PAID: [S, Y],
    DISPUTED: [S, C, A],
  },

  CANCELLED: {},

  DISPUTED: {
    WAITING_ADMIN_REVIEW: [S],
    CANCELLED: [S],
  },
};

/** A job cannot be in one of these statuses without an artisan. */
export const STATUSES_NEEDING_ARTISAN: readonly CanonicalStatus[] = [
  'ASSIGNED',
  'ARTISAN_ACCEPTED',
  'ARTISAN_ON_THE_WAY',
  'ARTISAN_ARRIVED',
  'IN_PROGRESS',
  'WAITING_CLIENT_VALIDATION',
  'COMPLETED',
];

// ----------------------------------------------------------
// Questions the rest of the code asks
// ----------------------------------------------------------

export type TransitionVerdict =
  | { ok: true; same: boolean }
  | { ok: false; reason: 'unknown_status'; message: string }
  | { ok: false; reason: 'not_allowed'; message: string }
  | { ok: false; reason: 'wrong_actor'; message: string };

/** The one place that decides whether `from -> to` is legal for this kind of actor. */
export function checkTransition(
  from: string,
  to: string,
  actor: ActorKind,
): TransitionVerdict {
  const fromStatus = canonicalStatus(from);
  const toStatus = canonicalStatus(to);

  if (!fromStatus || !toStatus) {
    return {
      ok: false,
      reason: 'unknown_status',
      message: `Statut inconnu: ${!fromStatus ? from : to}.`,
    };
  }

  // Same status: nothing moves. Callers use this to change other columns
  // (reassigning an artisan, re-sending a quote) without a new status.
  if (fromStatus === toStatus) {
    return { ok: true, same: true };
  }

  const who = TRANSITIONS[fromStatus][toStatus];

  if (!who) {
    return {
      ok: false,
      reason: 'not_allowed',
      message: `Transition non autorisée: ${fromStatus} -> ${toStatus}.`,
    };
  }

  if (!who.includes(actor)) {
    return {
      ok: false,
      reason: 'wrong_actor',
      message: `Vous ne pouvez pas faire passer cette demande de ${fromStatus} à ${toStatus}.`,
    };
  }

  return { ok: true, same: false };
}

/**
 * Statuses `actor` may move a job to from `current`. Without `actor`: everything
 * legal for anybody. With `hasArtisan: false`, the statuses that need an artisan
 * are left out (the move would be refused: nobody is assigned yet).
 */
export function allowedNextStatuses(
  current: string,
  actor?: ActorKind,
  options: { hasArtisan?: boolean } = {},
): CanonicalStatus[] {
  const from = canonicalStatus(current);

  if (!from) return [];

  const edges = TRANSITIONS[from];

  return (Object.keys(edges) as CanonicalStatus[]).filter(
    (to) =>
      (!actor || (edges[to] as readonly ActorKind[]).includes(actor)) &&
      (options.hasArtisan !== false || !STATUSES_NEEDING_ARTISAN.includes(to)),
  );
}

/**
 * Statuses the dashboard's status menu never sets, although the table lets staff do it: another
 * screen owns them.
 *  - ASSIGNED: a person is chosen, in the assignment screen (the status follows);
 *  - QUOTE_SENT, QUOTE_ACCEPTED: the quote screen writes them with the quote itself (items, amounts,
 *    the customer's answer); a status alone would leave the quote saying the opposite;
 *  - PAYMENT_PENDING, PAID, INVOICE_SENT: the payments and the invoices write them.
 */
export const STATUSES_SET_ELSEWHERE: readonly CanonicalStatus[] = [
  'ASSIGNED',
  'QUOTE_SENT',
  'QUOTE_ACCEPTED',
  'PAYMENT_PENDING',
  'PAID',
  'INVOICE_SENT',
];

/**
 * The statuses the back office's status menu offers for a job: what the table lets staff do, minus
 * what another screen owns, and minus two moves that the table allows but that leave the job and the
 * technician disagreeing:
 *  - "back to the back office's review" while a technician holds the job (the move would leave that
 *    technician attached to a job nobody has given them: to take a job from a technician, it is given
 *    to another one). A disputed job is the exception: the technician did the work, and reopening the
 *    dispute for review is how it is settled;
 *  - "technician accepted" from anywhere but ASSIGNED: from a later status it is a step backwards
 *    (the technician is already on the way), and from an earlier one it is a manual acceptance that
 *    skips the assignment (its checks and its notification).
 * Nothing is offered for a status the table does not know.
 */
export function staffStatusMoves(current: string, options: { hasArtisan: boolean }): CanonicalStatus[] {
  const from = canonicalStatus(current);

  return allowedNextStatuses(current, 'staff', { hasArtisan: options.hasArtisan }).filter(
    (to) =>
      !STATUSES_SET_ELSEWHERE.includes(to) &&
      !(options.hasArtisan && to === 'WAITING_ADMIN_REVIEW' && from !== 'DISPUTED') &&
      !(to === 'ARTISAN_ACCEPTED' && from !== 'ASSIGNED'),
  );
}

/**
 * True when staff may give a job in this status to an artisan (or to another one). Not while a quote
 * is out: nothing is to be dispatched until the customer answers (put it back to review first, or
 * wait for the answer).
 */
export function staffMayAssign(current: string): boolean {
  return canonicalStatus(current) !== 'QUOTE_SENT' && checkTransition(current, 'ASSIGNED', 'staff').ok;
}

/**
 * The spelling the apps read for a status a staff member sets by hand: the old name where there is one
 * (ACCEPTED, ON_THE_WAY, ADMIN_REVIEW...) until STATUS_STORAGE=canonical, like the jobs the apps
 * write themselves. Every reader of the database already understands both (`withAliases`).
 */
export function appFacingStatus(status: string, mode: string | undefined = configuredStorageMode()): string {
  const canonical = canonicalStatus(status);

  if (!canonical) return status;

  if (String(mode ?? '').toLowerCase() === 'canonical') return canonical;

  return spellingsOf(canonical)[1] ?? canonical;
}

/**
 * Which kind of actor is this user for this job? A user is "staff" for every
 * job, "client" only for their own, "artisan" only for the one assigned to
 * them. Anybody else gets null and may do nothing.
 */
export function actorKindFor(
  user: { id: number; role: string },
  job: { clientId?: number | null; artisanId?: number | null },
): ActorKind | null {
  if (STAFF_ROLE_NAMES.includes(user.role)) return 'staff';
  if (user.role === 'ARTISAN' && job.artisanId === user.id) return 'artisan';
  if (user.role === 'CLIENT' && job.clientId === user.id) return 'client';

  return null;
}
