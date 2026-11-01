/**
 * An in-memory stand-in for the few Prisma calls the account specs make, with
 * the behaviours that matter for them: UNIQUE columns that raise P2002, `where`
 * with in / notIn / gt / gte / lt / lte / not / OR / AND / NOT, and a $transaction that rolls back.
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
      if ('notIn' in cond && cond.notIn.includes(value)) return false;
      if ('not' in cond && value === cond.not) return false;
      if ('gt' in cond && !(value !== null && value > cond.gt)) return false;
      if ('lt' in cond && !(value !== null && value < cond.lt)) return false;
      if ('gte' in cond && !(value !== null && value >= cond.gte)) return false;
      if ('lte' in cond && !(value !== null && value <= cond.lte)) return false;
      if ('equals' in cond) {
        const same =
          cond.mode === 'insensitive' && typeof value === 'string' && typeof cond.equals === 'string'
            ? value.toLowerCase() === cond.equals.toLowerCase()
            : value === cond.equals;

        if (!same) return false;
      }
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

/** Prisma leaves a column alone when its value in `data` is undefined; so do the fakes. */
function withoutUndefined(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data ?? {}).filter(([, value]) => value !== undefined));
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
      /**
       * Give back only the columns that `select` names, as the database does. A service that forgets a column in its `select` then
       * reads `undefined` here as it would with the real database; by default the whole row comes back, which hides that mistake.
       */
      honourSelect?: boolean;
    } = {},
  ) {}

  /** The row as the database gives it for this `select` (the whole row when none is given or the table does not honour it). */
  private picked(row: Row, select?: any): Row {
    if (!this.options.honourSelect || !select) return { ...row };

    const out: Row = {};

    for (const [name, wanted] of Object.entries<any>(select)) {
      if (!wanted) continue;

      const load = this.options.include?.[name];

      out[name] = load && typeof wanted === 'object' ? load(row) : row[name];
    }

    return out;
  }

  private copy(row: Row | undefined, args?: any): Row | null {
    if (!row) return null;

    const out: Row = this.picked(row, args?.select);

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

  create = async ({ data, select }: any) => this.picked(this.insert(data), select);

  findUnique = async ({ where, ...args }: any) => this.copy(this.rows.find((row) => matchesWhere(row, where)), args);

  findFirst = async ({ where, orderBy, ...args }: any = {}) => {
    const found = this.sorted(this.rows.filter((row) => matchesWhere(row, where)), orderBy)[0];

    return this.copy(found, args);
  };

  findMany = async ({ where, orderBy, take, skip, select }: any = {}) =>
    this.sorted(this.rows.filter((row) => matchesWhere(row, where)), orderBy)
      .slice(skip ?? 0, (skip ?? 0) + (take ?? 1000))
      .map((row) => this.picked(row, select));

  count = async ({ where }: any = {}) => this.rows.filter((row) => matchesWhere(row, where)).length;

  update = async ({ where, data, select }: any) => {
    const row = this.rows.find((candidate) => matchesWhere(candidate, where));

    if (!row) throw Object.assign(new Error('Record to update not found.'), { code: 'P2025' });

    const changes = withoutUndefined(data);

    this.assertUnique({ ...row, ...changes }, row.id);
    Object.assign(row, changes);

    return this.picked(row, select);
  };

  upsert = async ({ where, update, create }: any) => {
    const row = this.rows.find((candidate) => matchesWhere(candidate, where));

    if (row) {
      const changes = withoutUndefined(update);

      this.assertUnique({ ...row, ...changes }, row.id);
      Object.assign(row, changes);

      return { ...row };
    }

    return { ...this.insert(withoutUndefined(create) as Row) };
  };

  createMany = async ({ data }: any) => {
    for (const item of data) this.insert(item);

    return { count: data.length };
  };

  delete = async ({ where }: any) => {
    const row = this.rows.find((candidate) => matchesWhere(candidate, where));

    if (!row) throw Object.assign(new Error('Record to delete does not exist.'), { code: 'P2025' });

    this.rows = this.rows.filter((candidate) => candidate !== row);

    return { ...row };
  };

  deleteMany = async ({ where }: any = {}) => {
    const before = this.rows.length;

    this.rows = this.rows.filter((row) => !matchesWhere(row, where));

    return { count: before - this.rows.length };
  };

  updateMany = async ({ where, data }: any) => {
    const hit = this.rows.filter((row) => matchesWhere(row, where));

    const changes = withoutUndefined(data);

    for (const row of hit) {
      this.assertUnique({ ...row, ...changes }, row.id);
      Object.assign(row, changes);
    }

    return { count: hit.length };
  };

  /** `groupBy({ by, where, _count, _min, _max })`: one row per distinct value of the columns in `by`, with the counts, smallest and largest values asked for. */
  groupBy = async ({ by, where, _count, _min, _max }: any) => {
    const groups = new Map<string, Row[]>();

    for (const row of this.rows.filter((candidate) => matchesWhere(candidate, where))) {
      const key = JSON.stringify(by.map((name: string) => row[name] ?? null));

      groups.set(key, [...(groups.get(key) ?? []), row]);
    }

    const extreme = (rows: Row[], column: string, pick: (a: any, b: any) => any) =>
      rows.map((row) => row[column]).filter((value) => value !== null && value !== undefined).reduce((best, value) => (best === undefined ? value : pick(best, value)), undefined);

    return [...groups.values()].map((rows) => {
      const out: Row = Object.fromEntries(by.map((name: string) => [name, rows[0][name] ?? null]));

      if (_count) {
        out._count = Object.fromEntries(
          Object.keys(_count).map((column) => [column, column === '_all' ? rows.length : rows.filter((row) => row[column] !== null && row[column] !== undefined).length]),
        );
      }

      if (_min) out._min = Object.fromEntries(Object.keys(_min).map((column) => [column, extreme(rows, column, (a, b) => (b < a ? b : a)) ?? null]));
      if (_max) out._max = Object.fromEntries(Object.keys(_max).map((column) => [column, extreme(rows, column, (a, b) => (b > a ? b : a)) ?? null]));

      return out;
    });
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
