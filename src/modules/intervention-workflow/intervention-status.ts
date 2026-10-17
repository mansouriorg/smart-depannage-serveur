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

/** Which spelling to write. Identity until STATUS_STORAGE=canonical. */
export function storageStatus(
  status: string,
  mode: string | undefined = process.env.STATUS_STORAGE,
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
export function initialStatus(mode: string | undefined = process.env.STATUS_STORAGE): string {
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

/** Stored spellings of a group, for `where: { status: { in: statusesInGroup('active') } }`. */
export function statusesInGroup(group: StatusGroup): string[] {
  return withAliases(STATUS_GROUPS[group]);
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
