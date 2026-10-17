/**
 * An in-memory stand-in for the few Prisma calls the account specs make, with
 * the behaviours that matter for them: UNIQUE columns that raise P2002, `where`
 * with in / gt / lt / not / OR / AND / NOT, and a $transaction that rolls back.
 * Test support only: nothing in the application imports it.
 */

export type Row = any;

export function matchesWhere(row: Row, where: any): boolean {
  if (!where) return true;

  for (const [key, cond] of Object.entries<any>(where)) {
    if (cond === undefined) continue;

    if (key === 'OR') {
      if (!cond.some((w: any) => matchesWhere(row, w))) return false;
      continue;
    }

    if (key === 'AND') {
      if (!(Array.isArray(cond) ? cond : [cond]).every((w: any) => matchesWhere(row, w))) return false;
      continue;
    }

    if (key === 'NOT') {
      if ((Array.isArray(cond) ? cond : [cond]).some((w: any) => matchesWhere(row, w))) return false;
      continue;
    }

    const value = row[key] === undefined ? null : row[key];

    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond && !cond.in.includes(value)) return false;
      if ('not' in cond && value === cond.not) return false;
      if ('gt' in cond && !(value !== null && value > cond.gt)) return false;
      if ('lt' in cond && !(value !== null && value < cond.lt)) return false;
      if ('equals' in cond && value !== cond.equals) return false;
      continue;
    }

    if (cond instanceof Date) {
      if (!(value instanceof Date) || value.getTime() !== cond.getTime()) return false;
      continue;
    }

    if (value !== cond) return false;
  }

  return true;
}

export class FakeTable {
  rows: Row[] = [];
  private nextId = 1;

  constructor(
    private readonly options: {
      /** Columns with a UNIQUE constraint (null never collides, like SQL). */
      unique?: string[];
      /** Columns that default to a value, like `@default(...)`. */
      defaults?: () => Row;
      /** `include: { user: true }` support. */
      include?: Record<string, (row: Row) => Row | undefined>;
    } = {},
  ) {}

  private copy(row: Row | undefined, args?: any): Row | null {
    if (!row) return null;

    const out: Row = { ...row };

    for (const [name, load] of Object.entries(this.options.include ?? {})) {
      if (args?.include?.[name]) out[name] = load(row);
    }

    return out;
  }

  private assertUnique(candidate: Row, ignoreId?: number) {
    for (const column of this.options.unique ?? []) {
      const value = candidate[column];

      if (value === null || value === undefined) continue;

      if (this.rows.some((row) => row.id !== ignoreId && row[column] === value)) {
        throw Object.assign(new Error(`Unique constraint failed on the fields: (\`${column}\`)`), {
          code: 'P2002',
          meta: { target: [column] },
        });
      }
    }
  }

  insert(data: Row): Row {
    const row = { id: this.nextId++, createdAt: new Date(), ...(this.options.defaults?.() ?? {}), ...data };

    this.assertUnique(row);
    this.rows.push(row);

    return row;
  }

  create = async ({ data }: any) => ({ ...this.insert(data) });

  findUnique = async ({ where, ...args }: any) => this.copy(this.rows.find((row) => matchesWhere(row, where)), args);

  findFirst = async ({ where, orderBy, ...args }: any = {}) => {
    const found = this.sorted(this.rows.filter((row) => matchesWhere(row, where)), orderBy)[0];

    return this.copy(found, args);
  };

  findMany = async ({ where, orderBy, take }: any = {}) =>
    this.sorted(this.rows.filter((row) => matchesWhere(row, where)), orderBy)
      .slice(0, take ?? 1000)
      .map((row) => ({ ...row }));

  count = async ({ where }: any = {}) => this.rows.filter((row) => matchesWhere(row, where)).length;

  update = async ({ where, data }: any) => {
    const row = this.rows.find((candidate) => matchesWhere(candidate, where));

    if (!row) throw Object.assign(new Error('Record to update not found.'), { code: 'P2025' });

    this.assertUnique({ ...row, ...data }, row.id);
    Object.assign(row, data);

    return { ...row };
  };

  updateMany = async ({ where, data }: any) => {
    const hit = this.rows.filter((row) => matchesWhere(row, where));

    for (const row of hit) {
      this.assertUnique({ ...row, ...data }, row.id);
      Object.assign(row, data);
    }

    return { count: hit.length };
  };

  private sorted(rows: Row[], orderBy: any): Row[] {
    if (!orderBy) return rows;

    const [[key, direction]] = Object.entries<any>(Array.isArray(orderBy) ? orderBy[0] : orderBy);

    return [...rows].sort((a, b) => (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * (direction === 'desc' ? -1 : 1));
  }
}

/** A $transaction that undoes every table when the callback throws (like the database does). */
export function withTransactions<T extends Record<string, any>>(client: T, tables: FakeTable[]): T & {
  $transaction: (work: any) => Promise<any>;
} {
  const target: any = client;

  target.$transaction = async (work: any) => {
    const snapshot = tables.map((table) => table.rows.map((row) => ({ ...row })));

    try {
      return typeof work === 'function' ? await work(target) : await Promise.all(work);
    } catch (error) {
      tables.forEach((table, index) => {
        table.rows = snapshot[index];
      });

      throw error;
    }
  };

  return target;
}
