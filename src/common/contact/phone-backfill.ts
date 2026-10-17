import { phoneKeyOf } from './phone';

export type PhoneRow = {
  id: number;
  phone: string | null;
  phoneKey: string | null;
  isGuest: boolean;
  isActive: boolean;
  deletedAt: Date | null;
  /** Set when the owner proved the number with a code: such an account always keeps it. */
  phoneVerifiedAt?: Date | null;
};

export type PhonePlan = {
  /** Rows that get their canonical key. */
  assign: Array<{ id: number; phoneKey: string }>;
  /** Several accounts wrote the same number: `keep` gets the key, `others` keep the text and stay without a key. */
  conflicts: Array<{ phoneKey: string; keep: number; others: number[] }>;
  /** Numbers that cannot be a phone number: left as they are. */
  invalid: Array<{ id: number; phone: string }>;
  /** Deleted accounts that hold a key: a deleted account gives its number up, so the key is cleared. */
  release: number[];
};

/**
 * Who keeps a number two accounts share: the one whose owner proved it, then real
 * accounts before guests, active before disabled, then the oldest. (Deleted
 * accounts never take part: they give their number up.)
 */
function rank(row: PhoneRow): [number, number, number, number] {
  return [
    row.phoneVerifiedAt ? 0 : 1,
    row.isGuest ? 1 : 0,
    row.isActive ? 0 : 1,
    row.id,
  ];
}

function byRank(a: PhoneRow, b: PhoneRow): number {
  const left = rank(a);
  const right = rank(b);

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }

  return 0;
}

/**
 * Decides which phoneKey each existing account gets (scripts/backfill-phone-keys.ts).
 * Pure, so the rule can be tested without a database.
 */
export function planPhoneKeys(rows: PhoneRow[]): PhonePlan {
  const plan: PhonePlan = { assign: [], conflicts: [], invalid: [], release: [] };
  const holders = new Map<string, number>();
  const waiting = new Map<string, PhoneRow[]>();

  for (const row of rows) {
    // A deleted account gives its number up: it takes no key, and one it holds is cleared.
    if (row.deletedAt) {
      if (row.phoneKey) plan.release.push(row.id);
      continue;
    }

    if (row.phoneKey) {
      holders.set(row.phoneKey, row.id);
      continue;
    }

    if (!row.phone || !row.phone.trim()) continue;

    const key = phoneKeyOf(row.phone);

    if (!key) {
      plan.invalid.push({ id: row.id, phone: row.phone });
      continue;
    }

    waiting.set(key, [...(waiting.get(key) ?? []), row]);
  }

  for (const [key, candidates] of [...waiting.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...candidates].sort(byRank);
    const taken = holders.get(key);

    if (taken !== undefined) {
      plan.conflicts.push({ phoneKey: key, keep: taken, others: sorted.map((row) => row.id) });
      continue;
    }

    const [winner, ...others] = sorted;

    plan.assign.push({ id: winner.id, phoneKey: key });

    if (others.length) {
      plan.conflicts.push({ phoneKey: key, keep: winner.id, others: others.map((row) => row.id) });
    }
  }

  return plan;
}
