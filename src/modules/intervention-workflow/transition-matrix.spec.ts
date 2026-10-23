import {
  CANONICAL_STATUSES,
  CanonicalStatus,
  STATUSES_NEEDING_ARTISAN,
  TRANSITIONS,
  allowedNextStatuses,
  checkTransition,
} from './intervention-status';
import { transitionStatus } from './transition-status';

/**
 * The life of a job, written out a second time and compared with the table of the code (P1-17).
 *
 * `intervention-status.spec.ts` tests the table with the table's own words; this spec holds the rules as the
 * business states them, in one place, and every one of the 16 x 16 moves for each of the four actors is checked
 * against them: through `checkTransition`, and through `transitionStatus`, the function that is the only way
 * the code writes a status. A move that is not here is refused, so a line added to the table by mistake (a customer who
 * can mark a job paid, an artisan who can cancel) fails the build, and so does a line that is taken away.
 *
 * Letters: S staff (a back-office role that works tickets), A the artisan of the job, C its customer, Y a
 * domain service that has checked the caller itself (a payment that arrived, a quote that was answered).
 */
const RULES: Record<CanonicalStatus, string> = {
  CREATED: 'WAITING_ADMIN_REVIEW:SY QUOTE_SENT:SY ASSIGNED:SY ARTISAN_ACCEPTED:SA CANCELLED:SC',
  WAITING_ADMIN_REVIEW: 'QUOTE_SENT:SY ASSIGNED:SY ARTISAN_ACCEPTED:SA CANCELLED:SC DISPUTED:S',
  QUOTE_SENT: 'QUOTE_ACCEPTED:SCY WAITING_ADMIN_REVIEW:SY ASSIGNED:S ARTISAN_ACCEPTED:S CANCELLED:SC DISPUTED:S',
  QUOTE_ACCEPTED: 'ASSIGNED:SY ARTISAN_ACCEPTED:SA CANCELLED:SC DISPUTED:SC',
  ASSIGNED: 'ARTISAN_ACCEPTED:SA WAITING_ADMIN_REVIEW:SA IN_PROGRESS:SA CANCELLED:SC DISPUTED:SA',
  ARTISAN_ACCEPTED: 'ARTISAN_ON_THE_WAY:SA IN_PROGRESS:SA ASSIGNED:S WAITING_ADMIN_REVIEW:SA CANCELLED:SC DISPUTED:SCA',
  ARTISAN_ON_THE_WAY: 'ARTISAN_ARRIVED:SA IN_PROGRESS:SA ASSIGNED:S ARTISAN_ACCEPTED:S WAITING_ADMIN_REVIEW:SA CANCELLED:SC DISPUTED:SCA',
  ARTISAN_ARRIVED: 'IN_PROGRESS:SA ASSIGNED:S ARTISAN_ACCEPTED:S WAITING_ADMIN_REVIEW:SA CANCELLED:SC DISPUTED:SCA',
  IN_PROGRESS: 'WAITING_CLIENT_VALIDATION:SA COMPLETED:SA ASSIGNED:S ARTISAN_ACCEPTED:S CANCELLED:S DISPUTED:SCA',
  WAITING_CLIENT_VALIDATION: 'COMPLETED:SCY CANCELLED:S DISPUTED:SCA',
  COMPLETED: 'PAYMENT_PENDING:SCY PAID:SY INVOICE_SENT:SY DISPUTED:SCA',
  PAYMENT_PENDING: 'PAID:SY INVOICE_SENT:SY DISPUTED:SCA',
  PAID: 'INVOICE_SENT:SY DISPUTED:SCA',
  INVOICE_SENT: 'PAID:SY DISPUTED:SCA',
  CANCELLED: '',
  DISPUTED: 'WAITING_ADMIN_REVIEW:S CANCELLED:S',
};

const LETTERS = { S: 'staff', A: 'artisan', C: 'client', Y: 'system' } as const;
const ACTORS = Object.values(LETTERS);

type Actor = (typeof ACTORS)[number];

/** Who may move a job from `from` to `to` according to RULES (nobody when the move is not written). */
function whoMay(from: CanonicalStatus, to: CanonicalStatus): Actor[] {
  const edge = RULES[from]
    .split(' ')
    .filter(Boolean)
    .map((part) => part.split(':'))
    .find(([target]) => target === to);

  return edge ? [...edge[1]].map((letter) => LETTERS[letter as keyof typeof LETTERS]) : [];
}

/** The whole table in one pass, for the checks that need every move. */
const MOVES = CANONICAL_STATUSES.flatMap((from) => CANONICAL_STATUSES.filter((to) => to !== from).map((to) => ({ from, to, who: whoMay(from, to) })));

/** A tiny stand-in for the two Prisma calls the helper uses. */
function db(initial: { id: number; status: string; artisanId: number | null }) {
  const row: any = { ...initial };
  const updates: any[] = [];

  return {
    row,
    updates,
    db: {
      intervention: {
        findUnique: async () => ({ ...row }),
        update: async (args: any) => {
          updates.push(args);

          if (args.where?.status !== undefined && args.where.status !== row.status) throw Object.assign(new Error('Record not found'), { code: 'P2025' });

          Object.assign(row, args.data);

          return { ...row };
        },
      },
    },
  };
}

async function outcome(promise: Promise<unknown>): Promise<'moved' | 400 | 403 | 404 | 409 | 'other'> {
  try {
    await promise;

    return 'moved';
  } catch (error: any) {
    const status = typeof error?.getStatus === 'function' ? error.getStatus() : null;

    return [400, 403, 404, 409].includes(status) ? status : 'other';
  }
}

describe('the written rules and the code\'s table say the same thing (P1-17)', () => {
  it('the rules have a line for each of the 16 statuses and name only those', () => {
    expect(Object.keys(RULES).sort()).toEqual([...CANONICAL_STATUSES].sort());

    for (const line of Object.values(RULES)) {
      for (const part of line.split(' ').filter(Boolean)) {
        expect(CANONICAL_STATUSES as readonly string[]).toContain(part.split(':')[0]);
        expect(part.split(':')[1]).toMatch(/^[SACY]+$/);
      }
    }
  });

  it('the table has exactly the moves of the rules, each for exactly the same actors', () => {
    const differences: string[] = [];

    for (const { from, to, who } of MOVES) {
      const code = ((TRANSITIONS[from] as Record<string, readonly string[]>)[to] ?? []).slice().sort();

      if (JSON.stringify(code) !== JSON.stringify(who.slice().sort())) differences.push(`${from} -> ${to}: the rules say [${who}], the code says [${code}]`);
    }

    expect(differences).toEqual([]);
  });
});

describe('checkTransition: every move, for every actor (P1-17)', () => {
  it(`gives the verdict of the rules for all ${MOVES.length * ACTORS.length} combinations`, () => {
    const wrong: string[] = [];

    for (const { from, to, who } of MOVES) {
      for (const actor of ACTORS) {
        const verdict = checkTransition(from, to, actor);
        const expected = who.length === 0 ? 'not_allowed' : who.includes(actor) ? 'ok' : 'wrong_actor';
        const got = verdict.ok ? 'ok' : verdict.reason;

        if (got !== expected) wrong.push(`${actor}: ${from} -> ${to} is ${got}, expected ${expected}`);
      }
    }

    expect(wrong).toEqual([]);
  });

  it('staying where you are is not a move, for anybody', () => {
    for (const status of CANONICAL_STATUSES) {
      for (const actor of ACTORS) expect(checkTransition(status, status, actor)).toEqual({ ok: true, same: true });
    }
  });

  it('nobody leaves CANCELLED, and only staff leave DISPUTED', () => {
    for (const actor of ACTORS) {
      expect(allowedNextStatuses('CANCELLED', actor)).toEqual([]);

      if (actor !== 'staff') expect(allowedNextStatuses('DISPUTED', actor)).toEqual([]);
    }
  });

  it('a customer never takes a job forward, an artisan never cancels one, and only staff or the system settle it as paid or invoiced', () => {
    const forward = ['ARTISAN_ACCEPTED', 'ARTISAN_ON_THE_WAY', 'ARTISAN_ARRIVED', 'IN_PROGRESS', 'WAITING_CLIENT_VALIDATION', 'PAID', 'INVOICE_SENT'];
    const found: string[] = [];

    for (const { from, to, who } of MOVES) {
      if (who.includes('client') && forward.includes(to)) found.push(`a customer can move ${from} -> ${to}`);
      if (who.includes('artisan') && to === 'CANCELLED') found.push(`an artisan can move ${from} -> CANCELLED`);
      if ((to === 'PAID' || to === 'INVOICE_SENT') && who.some((actor) => actor !== 'staff' && actor !== 'system')) found.push(`${from} -> ${to} is open to ${who}`);
    }

    expect(found).toEqual([]);
  });
});

describe('transitionStatus: every move, for every actor, on the database (P1-17)', () => {
  it('writes the move when the rules allow it for the actor, and refuses it, with the right answer and no write, when they do not', async () => {
    const wrong: string[] = [];
    let moved = 0;
    let refused = 0;

    for (const { from, to, who } of MOVES) {
      for (const actor of ACTORS) {
        const job = db({ id: 5, status: from, artisanId: 20 });
        const answer = await outcome(transitionStatus(job.db, { id: 5, to, actor: { kind: actor, userId: 1 } }));
        const expected = who.includes(actor) ? 'moved' : who.length === 0 ? 409 : 403;

        if (answer !== expected) wrong.push(`${actor}: ${from} -> ${to} was ${answer}, expected ${expected}`);
        else if (answer === 'moved') {
          moved++;

          if (job.row.status !== to) wrong.push(`${actor}: ${from} -> ${to} is stored as ${job.row.status}`);
          if (job.updates.length !== 1 || job.updates[0].where.status !== from) wrong.push(`${actor}: ${from} -> ${to} was not written against the status it was read at`);
        } else {
          refused++;

          if (job.updates.length !== 0 || job.row.status !== from) wrong.push(`${actor}: ${from} -> ${to} was refused and still wrote`);
        }
      }
    }

    expect(wrong).toEqual([]);
    expect(moved).toBeGreaterThan(100);
    expect(refused).toBeGreaterThan(800);
  });

  it('a move to a status that needs an artisan is a 400 when the job has none, for every actor who may make it, and writes nothing', async () => {
    const wrong: string[] = [];
    let tried = 0;

    for (const { from, to, who } of MOVES) {
      if (!(STATUSES_NEEDING_ARTISAN as readonly string[]).includes(to)) continue;

      for (const actor of who) {
        const job = db({ id: 5, status: from, artisanId: null });
        const answer = await outcome(transitionStatus(job.db, { id: 5, to, actor: { kind: actor, userId: 1 } }));

        tried++;

        if (answer !== 400 || job.updates.length !== 0) wrong.push(`${actor}: ${from} -> ${to} was ${answer} on a job with no artisan (${job.updates.length} writes)`);
      }
    }

    expect(wrong).toEqual([]);
    expect(tried).toBeGreaterThan(30);
  });

  it('an unknown status, on either side, is a 400 and writes nothing', async () => {
    for (const actor of ACTORS) {
      const toUnknown = db({ id: 5, status: 'CREATED', artisanId: null });
      const fromUnknown = db({ id: 5, status: 'FLYING', artisanId: null });

      expect(await outcome(transitionStatus(toUnknown.db, { id: 5, to: 'FLYING', actor: { kind: actor, userId: 1 } }))).toBe(400);
      expect(await outcome(transitionStatus(fromUnknown.db, { id: 5, to: 'CANCELLED', actor: { kind: actor, userId: 1 } }))).toBe(400);
      expect(toUnknown.updates).toHaveLength(0);
      expect(fromUnknown.updates).toHaveLength(0);
    }
  });
});
