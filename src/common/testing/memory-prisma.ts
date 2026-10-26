import * as fs from 'fs';
import * as path from 'path';

import { Decimal, averageDecimals, compareDecimals, isDecimalInput, sumDecimals, toColumnDecimal } from './decimal-double';

/**
 * A Prisma client that keeps its rows in memory and reads its shape from `prisma/schema.prisma` (P1-17).
 *
 * The access specs run the real controllers and services against it, so that what a route answers to
 * the wrong person comes from the code under test and from a database that follows the relations
 * (`where: { intervention: { clientId } }`, `some`, `include`, `select`), not from a stand-in that was
 * written to give the answer the test wants. It is strict on purpose: a field, an operator or a nested
 * write it does not know is an error, never a silent "everything matches".
 *
 * What it does: findUnique / findFirst / findMany (where, select, include, orderBy, take, skip, distinct),
 * count, aggregate, groupBy (by, _count, _sum), create, createMany, update, updateMany, upsert, delete,
 * deleteMany, nested `connect` / `create` / `connectOrCreate` / `disconnect` / `createMany` / `set` /
 * `update` / `delete` on relations, DECIMAL columns (answered as `Decimal` objects, never as numbers: see `decimal-double.ts`), defaults (autoincrement, now, uuid, cuid, literals), `@updatedAt`,
 * unique constraints (`P2002`), not-found updates (`P2025`), `$transaction` with an undo journal and
 * `pg_advisory_xact_lock` as a real wait.
 * What it does not: raw SQL (other than that lock), full-text search, database-level cascades,
 * isolation levels (reads see what other open transactions wrote).
 * Test support only: nothing in the application imports it.
 */

type Row = Record<string, any>;

interface FieldInfo {
  name: string;
  type: string;
  list: boolean;
  optional: boolean;
  id: boolean;
  unique: boolean;
  updatedAt: boolean;
  /** The source text of `@default(...)`, if any. */
  defaultExpr: string | null;
  kind: 'scalar' | 'enum' | 'relation';
  /** Decimal fields: `@db.Decimal(precision, scale)`; the default of Prisma for PostgreSQL is (65, 30). */
  precision: number;
  scale: number;
  /** Relation fields: the name of the relation, the columns here and the columns they point at (owner side). */
  relationName: string | null;
  fkFields: string[];
  refFields: string[];
}

interface ModelInfo {
  name: string;
  fields: Map<string, FieldInfo>;
  /** Column groups that must be unique (single `@unique`, `@id` and `@@unique`/`@@id`). */
  uniques: string[][];
}

/** One end of a relation as seen from a row of the model that holds the field. */
interface Link {
  target: string;
  /** Columns of the row here and the columns of the target they equal. */
  here: string[];
  there: string[];
  /** True when the row here holds the foreign key (so there is at most one target). */
  holdsKey: boolean;
}

const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'DateTime', 'Json', 'BigInt', 'Decimal', 'Bytes']);

function stripComment(line: string): string {
  let quote = false;

  for (let i = 0; i < line.length - 1; i += 1) {
    if (line[i] === '"') quote = !quote;
    if (!quote && line[i] === '/' && line[i + 1] === '/') return line.slice(0, i);
  }

  return line;
}

function listOf(text: string): string[] {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/** The text inside the parenthesis that opens right after `at` in `text`. */
function parenthesised(text: string, at: number): string {
  let depth = 0;
  let quote = false;

  for (let i = at; i < text.length; i += 1) {
    const char = text[i];

    if (char === '"') quote = !quote;
    if (quote) continue;
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(at + 1, i);
    }
  }

  throw new Error(`unclosed parenthesis in: ${text}`);
}

export function parseSchema(schema: string): { models: Map<string, ModelInfo>; enums: Map<string, string[]> } {
  const models = new Map<string, ModelInfo>();
  const enums = new Map<string, string[]>();
  let current: { kind: 'model' | 'enum'; name: string } | null = null;
  const modelLines = new Map<string, string[]>();

  for (const raw of schema.split(/\r?\n/)) {
    const line = stripComment(raw).trim();

    if (!line) continue;

    if (!current) {
      const open = /^(model|enum)\s+(\w+)\s*\{$/.exec(line);

      if (open) {
        current = { kind: open[1] as 'model' | 'enum', name: open[2] };
        if (current.kind === 'enum') enums.set(current.name, []);
        else modelLines.set(current.name, []);
      }

      continue;
    }

    if (line === '}') {
      current = null;
      continue;
    }

    if (current.kind === 'enum') enums.get(current.name)?.push(line.split(/\s+/)[0]);
    else modelLines.get(current.name)?.push(line);
  }

  for (const [name, lines] of modelLines) {
    const fields = new Map<string, FieldInfo>();
    const uniques: string[][] = [];

    for (const line of lines) {
      if (line.startsWith('@@')) {
        const block = /^@@(unique|id)\(\s*\[([^\]]*)\]/.exec(line);

        if (block) uniques.push(listOf(block[2]));
        continue;
      }

      const match = /^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(line);

      if (!match) throw new Error(`cannot read the field line "${line}" of ${name}`);

      const [, fieldName, type, list, optional, attributes] = match;
      const isRelation = !SCALARS.has(type) && !enums.has(type);
      const defaultAt = attributes.indexOf('@default(');
      const decimalColumn = /@db\.Decimal\(\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(attributes);
      const relationAt = attributes.indexOf('@relation(');
      const relationText = relationAt >= 0 ? parenthesised(attributes, relationAt + '@relation'.length) : '';
      const nameMatch = /^\s*(?:name:\s*)?"([^"]+)"/.exec(relationText);
      const fieldsMatch = /fields:\s*\[([^\]]*)\]/.exec(relationText);
      const referencesMatch = /references:\s*\[([^\]]*)\]/.exec(relationText);

      fields.set(fieldName, {
        name: fieldName,
        type,
        list: Boolean(list),
        optional: Boolean(optional),
        id: /(^|\s)@id(\s|$)/.test(attributes),
        unique: /(^|\s)@unique(\s|$)/.test(attributes),
        updatedAt: attributes.includes('@updatedAt'),
        defaultExpr: defaultAt >= 0 ? parenthesised(attributes, defaultAt + '@default'.length).trim() : null,
        kind: isRelation ? 'relation' : enums.has(type) ? 'enum' : 'scalar',
        precision: decimalColumn ? Number(decimalColumn[1]) : 65,
        scale: decimalColumn ? Number(decimalColumn[2]) : 30,
        relationName: nameMatch ? nameMatch[1] : null,
        fkFields: fieldsMatch ? listOf(fieldsMatch[1]) : [],
        refFields: referencesMatch ? listOf(referencesMatch[1]) : [],
      });
    }

    for (const field of fields.values()) {
      if (field.id || field.unique) uniques.push([field.name]);
    }

    models.set(name, { name, fields, uniques });
  }

  for (const model of models.values()) {
    for (const field of model.fields.values()) {
      if (field.kind === 'relation' && !models.has(field.type)) {
        throw new Error(`${model.name}.${field.name} points at ${field.type}, which is not a model`);
      }
    }
  }

  return { models, enums };
}

const lowerFirst = (name: string) => name.charAt(0).toLowerCase() + name.slice(1);

function clone<T>(value: T): T {
  if (value instanceof Decimal) return value;
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => clone(item)) as unknown as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Row).map(([key, item]) => [key, clone(item)])) as T;
  }

  return value;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Decimal || b instanceof Decimal) return isDecimalInput(a) && isDecimalInput(b) && compareDecimals(a, b) === 0;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Date || b instanceof Date) return false;
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);

  return a === b;
}

function comparable(value: unknown): number | string | boolean | null {
  if (value instanceof Date) return value.getTime();
  if (value instanceof Decimal) return value.toNumber();
  if (value === undefined) return null;

  return value as number | string | boolean | null;
}

function prismaError(code: string, message: string, meta?: Row): Error {
  return Object.assign(new Error(message), { code, ...(meta ? { meta } : {}) });
}

type JournalEntry = { table: string; before: Row | null; after: Row | null };

class Mutex {
  private holder: number | null = null;
  private waiting: Array<() => void> = [];

  async acquire(owner: number): Promise<void> {
    if (this.holder === owner) return;

    while (this.holder !== null) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }

    this.holder = owner;
  }

  release(owner: number): void {
    if (this.holder !== owner) return;

    this.holder = null;
    this.waiting.shift()?.();
  }
}

let parsedSchema: ReturnType<typeof parseSchema> | null = null;

/** The columns of a model that hold text (`String`): the ones the world labels with a mark. Read from `prisma/schema.prisma`. */
export function textColumnsOf(model: string): string[] {
  parsedSchema ??= parseSchema(fs.readFileSync(path.resolve(__dirname, '../../../prisma/schema.prisma'), 'utf8'));

  const info = parsedSchema.models.get(model);

  if (!info) throw new Error(`textColumnsOf: no model ${model}`);

  return [...info.fields.values()].filter((field) => field.kind === 'scalar' && field.type === 'String' && !field.list).map((field) => field.name);
}

/** Whether a model has a column of that name (a scalar, an enum or a relation). */
export function hasColumn(model: string, column: string): boolean {
  parsedSchema ??= parseSchema(fs.readFileSync(path.resolve(__dirname, '../../../prisma/schema.prisma'), 'utf8'));

  return parsedSchema.models.get(model)?.fields.has(column) ?? false;
}

export class MemoryPrisma {
  readonly models: Map<string, ModelInfo>;
  readonly enums: Map<string, string[]>;
  private readonly tables = new Map<string, Row[]>();
  private readonly counters = new Map<string, number>();
  private readonly locks = new Map<string, Mutex>();
  private nextTransaction = 1;
  /** Every call made on a delegate, in order: `"intervention.update"`. A spec may read it to see what a route did. */
  readonly calls: string[] = [];
  private clock: () => Date = () => new Date();

  constructor(schemaText?: string) {
    const text = schemaText ?? fs.readFileSync(path.resolve(__dirname, '../../../prisma/schema.prisma'), 'utf8');

    const parsed = parseSchema(text);

    this.models = parsed.models;
    this.enums = parsed.enums;

    for (const name of this.models.keys()) this.tables.set(name, []);
  }

  /** What `now()` and `@updatedAt` give: a spec that needs a fixed time sets it here. */
  setClock(clock: () => Date): void {
    this.clock = clock;
  }

  // ------------------------------------------------------------------ the client

  /** A root client, or the one a transaction callback receives. Model delegates are `client.intervention`, `client.user`... */
  client(): any {
    return this.makeClient(null);
  }

  private makeClient(tx: { id: number; journal: JournalEntry[]; held: Set<string> } | null): any {
    const delegates = new Map<string, any>();
    const self = this;

    return new Proxy(
      {},
      {
        get: (_target, key) => {
          if (typeof key !== 'string') return undefined;

          if (key === 'then') return undefined;
          if (key === '$connect' || key === '$disconnect') return async () => undefined;
          if (key === '$transaction') {
            // `$transaction([a, b])`: the operations were started when they were written, so what is left is to wait for all of them (a failure does not undo the others: the list form is only used for writes that do not depend on each other).
            return (work: any, _options?: unknown) =>
              Array.isArray(work) ? Promise.all(work) : tx ? self.nested(work, this.makeClient(tx)) : self.transaction(work);
          }
          if (key === '$executeRaw' || key === '$executeRawUnsafe') {
            return (strings: TemplateStringsArray, ...values: unknown[]) => self.raw(tx, strings, values);
          }
          if (key === '$queryRaw' || key === '$queryRawUnsafe') {
            return (strings: TemplateStringsArray, ...values: unknown[]) => self.raw(tx, strings, values);
          }

          const model = [...self.models.keys()].find((name) => lowerFirst(name) === key);

          if (!model) return undefined;

          if (!delegates.has(model)) delegates.set(model, self.delegate(model, tx));

          return delegates.get(model);
        },
      },
    );
  }

  private async nested(work: any, client: any) {
    // Already inside a transaction: the work belongs to it.
    return typeof work === 'function' ? work(client) : Promise.all(work);
  }

  private async transaction(work: any): Promise<any> {
    if (typeof work !== 'function') return Promise.all(work);

    const tx = { id: this.nextTransaction++, journal: [] as JournalEntry[], held: new Set<string>() };

    try {
      return await work(this.makeClient(tx));
    } catch (error) {
      for (const entry of [...tx.journal].reverse()) this.undo(entry);

      throw error;
    } finally {
      for (const key of tx.held) this.locks.get(key)?.release(tx.id);
    }
  }

  private undo(entry: JournalEntry) {
    const rows = this.tables.get(entry.table) as Row[];

    if (entry.before === null) {
      const at = rows.findIndex((row) => row === entry.after);

      if (at >= 0) rows.splice(at, 1);
    } else if (entry.after === null) {
      rows.push(entry.before);
    } else {
      Object.keys(entry.after).forEach((key) => delete entry.after![key]);
      Object.assign(entry.after, entry.before);
    }
  }

  /** `pg_advisory_xact_lock(a, b)` is a real wait, kept until the transaction ends; anything else is an error. */
  private async raw(tx: { id: number; held: Set<string> } | null, strings: TemplateStringsArray, values: unknown[]) {
    const text = Array.isArray(strings) ? strings.join('?') : String(strings);

    if (!/pg_advisory_xact_lock/.test(text)) throw new Error(`MemoryPrisma does not run raw SQL: ${text.slice(0, 80)}`);
    if (!tx) throw new Error('pg_advisory_xact_lock outside a transaction');

    const key = values.join(':');

    if (!this.locks.has(key)) this.locks.set(key, new Mutex());

    await (this.locks.get(key) as Mutex).acquire(tx.id);
    tx.held.add(key);

    return 0;
  }

  // ------------------------------------------------------------------ direct access for specs

  /** The rows of a table as they are now (not copies: a spec may edit them to build a situation). */
  rows(model: string): Row[] {
    const rows = this.tables.get(this.modelName(model));

    if (!rows) throw new Error(`no model ${model}`);

    return rows;
  }

  /** Adds a row the way `create` does, without the journal: for building a world. Returns a copy. */
  seed(model: string, data: Row): Row {
    return clone(this.insert(this.modelName(model), data, null));
  }

  /**
   * Builds a row for a world: whatever `data` does not say is filled in, so a spec names only what matters to it.
   * A required text, number, flag, date, json or enum column gets a plain value (unique text and numbers get a
   * counter in them), and the defaults of the schema apply as in `create`. A required key to another row is never
   * invented: planting a row whose parent is missing is a mistake of the spec, and says so.
   */
  plant(model: string, data: Row = {}, options: { optionalText?: boolean } = {}): Row {
    const name = this.modelName(model);
    const info = this.info(name);
    const keys = new Set<string>();

    for (const field of info.fields.values()) {
      if (field.kind === 'relation') field.fkFields.forEach((column) => keys.add(column));
    }

    const filled: Row = { ...data };

    for (const field of info.fields.values()) {
      if (field.kind === 'relation' || filled[field.name] !== undefined) continue;

      // With `optionalText`, the optional text columns that are not keys are filled too: a response that shows one of them shows the mark.
      const optionalText = options.optionalText && field.optional && !field.list && field.kind === 'scalar' && field.type === 'String' && !keys.has(field.name);

      if (!optionalText && (field.optional || field.list || field.updatedAt || field.defaultExpr !== null)) continue;
      if (optionalText && field.defaultExpr !== null) continue;

      if (keys.has(field.name)) throw new Error(`plant ${name}: ${field.name} points at another row and was not given`);

      this.plantedCount += 1;

      const unique = this.uniqueText(info, field) ? `-${this.plantedCount}` : '';

      if (field.kind === 'enum') filled[field.name] = (this.enums.get(field.type) as string[])[0];
      else if (field.type === 'String') filled[field.name] = this.labeller ? this.labeller(name, field.name, unique) : `${lowerFirst(name)}.${field.name}${unique}`;
      else if (field.type === 'Int' || field.type === 'Float' || field.type === 'Decimal') filled[field.name] = unique ? this.plantedCount : 0;
      else if (field.type === 'Boolean') filled[field.name] = false;
      else if (field.type === 'DateTime') filled[field.name] = this.clock();
      else if (field.type === 'Json') filled[field.name] = {};
      else throw new Error(`plant ${name}.${field.name}: no plain value for ${field.type}`);
    }

    return this.seed(name, filled);
  }

  private plantedCount = 0;
  private labeller: ((model: string, field: string, unique: string) => string) | null = null;

  /** What `plant` writes into a required text column that the spec did not fill: a world can mark its rows with it. */
  labelWith(labeller: ((model: string, field: string, unique: string) => string) | null): void {
    this.labeller = labeller;
  }

  private uniqueText(info: ModelInfo, field: FieldInfo): boolean {
    return info.uniques.some((columns) => columns.includes(field.name));
  }

  /** Every table, copied: compare two of them to see what a call changed. */
  snapshot(): Record<string, Row[]> {
    return Object.fromEntries([...this.tables].map(([name, rows]) => [name, clone(rows)]));
  }

  /** Puts every table back as it was in a snapshot (ids already given are not given again). */
  restore(snapshot: Record<string, Row[]>): void {
    for (const [name, rows] of this.tables) {
      rows.length = 0;
      rows.push(...clone(snapshot[name] ?? []));
    }
  }

  /** The tables that differ between two snapshots, with the number of rows before and after. */
  changedTables(before: Record<string, Row[]>, ignore: string[] = []): string[] {
    const after = this.snapshot();

    return Object.keys(after)
      .filter((name) => !ignore.includes(name))
      .filter((name) => JSON.stringify(before[name]) !== JSON.stringify(after[name]));
  }

  /**
   * Checks the schema the engine reads: every relation finds its other side, and the key columns it names exist
   * on both tables with the same type. Run against the real schema, this is what makes the engine's relations trustworthy.
   */
  verifySchema(): void {
    for (const info of this.models.values()) {
      for (const field of info.fields.values()) {
        if (field.kind !== 'relation') continue;

        const link = this.link(info.name, field);

        if (link.here.length === 0 || link.here.length !== link.there.length) {
          throw new Error(`${info.name}.${field.name}: the relation has no usable key`);
        }

        link.here.forEach((column, index) => {
          const mine = this.info(info.name).fields.get(column);
          const theirs = this.info(link.target).fields.get(link.there[index]);

          if (!mine || mine.kind === 'relation') throw new Error(`${info.name}.${field.name}: no column ${column} on ${info.name}`);
          if (!theirs || theirs.kind === 'relation') throw new Error(`${info.name}.${field.name}: no column ${link.there[index]} on ${link.target}`);
          if (mine.type !== theirs.type) throw new Error(`${info.name}.${column} is ${mine.type} but ${link.target}.${theirs.name} is ${theirs.type}`);
        });
      }
    }
  }

  private modelName(model: string): string {
    const found = [...this.models.keys()].find((name) => name === model || lowerFirst(name) === model);

    if (!found) throw new Error(`no model ${model}`);

    return found;
  }

  private info(model: string): ModelInfo {
    return this.models.get(model) as ModelInfo;
  }

  private field(model: string, name: string): FieldInfo {
    const field = this.info(model).fields.get(name);

    if (!field) throw new Error(`${model} has no field "${name}"`);

    return field;
  }

  // ------------------------------------------------------------------ relations

  private link(model: string, field: FieldInfo): Link {
    if (field.fkFields.length > 0) {
      return { target: field.type, here: field.fkFields, there: field.refFields, holdsKey: true };
    }

    // The other side holds the key: the field of the target that points back at this model.
    const candidates = [...this.info(field.type).fields.values()].filter(
      (other) => other.kind === 'relation' && other.type === model && other.fkFields.length > 0,
    );
    const back =
      candidates.find((other) => other.relationName === field.relationName) ??
      (field.relationName === null && candidates.length === 1 ? candidates[0] : undefined);

    if (!back) throw new Error(`cannot find the other side of ${model}.${field.name}`);

    return { target: field.type, here: back.refFields, there: back.fkFields, holdsKey: false };
  }

  private related(model: string, row: Row, field: FieldInfo): Row[] {
    const link = this.link(model, field);
    const values = link.here.map((column) => row[column]);

    // A key that is null points at nothing.
    if (values.some((value) => value === null || value === undefined)) return [];

    return (this.tables.get(link.target) as Row[]).filter((candidate) =>
      link.there.every((column, index) => sameValue(candidate[column], values[index])),
    );
  }

  // ------------------------------------------------------------------ where

  private matches(model: string, row: Row, where: any): boolean {
    if (!where) return true;

    for (const [key, cond] of Object.entries<any>(where)) {
      if (cond === undefined) continue;

      if (key === 'AND') {
        if (!(Array.isArray(cond) ? cond : [cond]).every((item: any) => this.matches(model, row, item))) return false;
        continue;
      }

      if (key === 'OR') {
        if (!cond.some((item: any) => this.matches(model, row, item))) return false;
        continue;
      }

      if (key === 'NOT') {
        if ((Array.isArray(cond) ? cond : [cond]).some((item: any) => this.matches(model, row, item))) return false;
        continue;
      }

      const info = this.info(model);
      const field = info.fields.get(key);

      if (!field) {
        // A compound unique key: { userId_interventionId: { userId, interventionId } }
        const group = info.uniques.find((columns) => columns.length > 1 && columns.join('_') === key);

        if (!group) throw new Error(`${model} has no field "${key}" (in a where)`);

        if (!group.every((column) => sameValue(row[column], cond[column]))) return false;
        continue;
      }

      if (field.kind === 'relation') {
        if (!this.matchesRelation(model, row, field, cond)) return false;
        continue;
      }

      if (!this.matchesScalar(row[key], cond, field)) return false;
    }

    return true;
  }

  private matchesRelation(model: string, row: Row, field: FieldInfo, cond: any): boolean {
    const rows = this.related(model, row, field);

    if (field.list) {
      const operators = Object.keys(cond);
      const unknown = operators.filter((op) => !['some', 'every', 'none'].includes(op));

      if (unknown.length) throw new Error(`${model}.${field.name}: unknown relation filter ${unknown.join(', ')}`);

      if ('some' in cond && !rows.some((target) => this.matches(field.type, target, cond.some))) return false;
      if ('every' in cond && !rows.every((target) => this.matches(field.type, target, cond.every))) return false;
      if ('none' in cond && rows.some((target) => this.matches(field.type, target, cond.none))) return false;

      return true;
    }

    // To one: `null` means "has none", `{ is: ... }` / `{ isNot: ... }`, or the where itself.
    if (cond === null) return rows.length === 0;

    const keys = Object.keys(cond);

    if (keys.length > 0 && keys.every((key) => key === 'is' || key === 'isNot')) {
      if ('is' in cond) {
        if (cond.is === null ? rows.length !== 0 : !rows.some((target) => this.matches(field.type, target, cond.is))) return false;
      }

      if ('isNot' in cond) {
        if (cond.isNot === null ? rows.length === 0 : rows.some((target) => this.matches(field.type, target, cond.isNot))) return false;
      }

      return true;
    }

    return rows.some((target) => this.matches(field.type, target, cond));
  }

  private matchesScalar(value: unknown, cond: any, field: FieldInfo): boolean {
    const isFilter = cond !== null && typeof cond === 'object' && !(cond instanceof Date) && !(cond instanceof Decimal) && !Array.isArray(cond);

    if (!isFilter) {
      if (cond === null) return value === null || value === undefined;

      return sameValue(value === undefined ? null : value, cond);
    }

    const insensitive = cond.mode === 'insensitive';
    const text = (item: unknown) => (typeof item === 'string' && insensitive ? item.toLowerCase() : item);
    const known = ['equals', 'in', 'notIn', 'not', 'lt', 'lte', 'gt', 'gte', 'contains', 'startsWith', 'endsWith', 'mode', 'has', 'hasSome', 'hasEvery', 'isEmpty', 'path', 'string_contains'];
    const unknown = Object.keys(cond).filter((op) => !known.includes(op));

    if (unknown.length) throw new Error(`${field.name}: unknown filter ${unknown.join(', ')}`);

    const here = value === undefined ? null : value;

    if (field.list) {
      const list = (here ?? []) as unknown[];

      if ('has' in cond && !list.some((item) => sameValue(item, cond.has))) return false;
      if ('hasSome' in cond && !cond.hasSome.some((wanted: unknown) => list.some((item) => sameValue(item, wanted)))) return false;
      if ('hasEvery' in cond && !cond.hasEvery.every((wanted: unknown) => list.some((item) => sameValue(item, wanted)))) return false;
      if ('isEmpty' in cond && (list.length === 0) !== cond.isEmpty) return false;
      if ('equals' in cond && !sameValue(list, cond.equals)) return false;

      return true;
    }

    if ('path' in cond || 'string_contains' in cond) throw new Error(`${field.name}: JSON filters are not supported`);

    if ('equals' in cond && !(text(here) === text(cond.equals) || sameValue(here, cond.equals))) return false;
    if ('in' in cond && !cond.in.some((item: unknown) => sameValue(here, item))) return false;
    if ('notIn' in cond && cond.notIn.some((item: unknown) => sameValue(here, item))) return false;

    if ('not' in cond) {
      const not = cond.not;

      if (not !== null && typeof not === 'object' && !(not instanceof Date) && !(not instanceof Decimal) && !Array.isArray(not)) {
        if (this.matchesScalar(here, not, field)) return false;
      } else if (not === null ? here === null : sameValue(here, not)) {
        return false;
      }
    }

    const a = comparable(here);

    if ('lt' in cond && !(a !== null && (a as number) < (comparable(cond.lt) as number))) return false;
    if ('lte' in cond && !(a !== null && (a as number) <= (comparable(cond.lte) as number))) return false;
    if ('gt' in cond && !(a !== null && (a as number) > (comparable(cond.gt) as number))) return false;
    if ('gte' in cond && !(a !== null && (a as number) >= (comparable(cond.gte) as number))) return false;

    // As PostgreSQL's LIKE reads it: a backslash makes the next character literal (the caller escapes "%" and "_" this way).
    if ('contains' in cond && !(typeof here === 'string' && String(text(here)).includes(String(text(cond.contains)).replace(/\\(.)/gs, '$1')))) return false;
    if ('startsWith' in cond && !(typeof here === 'string' && String(text(here)).startsWith(String(text(cond.startsWith))))) return false;
    if ('endsWith' in cond && !(typeof here === 'string' && String(text(here)).endsWith(String(text(cond.endsWith))))) return false;

    return true;
  }

  // ------------------------------------------------------------------ reading

  private order(model: string, rows: Row[], orderBy: any): Row[] {
    if (!orderBy) return rows;

    const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((item: Row) =>
      Object.entries<any>(item).map(([name, direction]) => ({ name, direction })),
    );

    const valueOf = (row: Row, name: string, direction: any): [unknown, 'asc' | 'desc', 'first' | 'last' | undefined] => {
      const field = this.field(model, name);

      if (field.kind === 'relation') {
        const [innerName, innerDirection] = Object.entries<any>(direction)[0];
        const target = this.related(model, row, field)[0];

        return [target ? target[innerName] : null, innerDirection === 'desc' ? 'desc' : 'asc', undefined];
      }

      const sort = typeof direction === 'string' ? direction : direction?.sort;
      const nulls = typeof direction === 'object' && direction !== null ? direction.nulls : undefined;

      return [row[name], sort === 'desc' ? 'desc' : 'asc', nulls === 'first' || nulls === 'last' ? nulls : undefined];
    };

    return [...rows].sort((a, b) => {
      for (const { name, direction } of keys) {
        const [x, how, nulls] = valueOf(a, name, direction);
        const [y] = valueOf(b, name, direction);
        const cx = comparable(x as never);
        const cy = comparable(y as never);

        if (cx === cy) continue;
        // Postgres puts null last when ascending and first when descending, unless the order says `nulls: 'first' | 'last'`.
        const nullsFirst = nulls ? nulls === 'first' : how === 'desc';

        if (cx === null) return nullsFirst ? -1 : 1;
        if (cy === null) return nullsFirst ? 1 : -1;

        return (cx > cy ? 1 : -1) * (how === 'desc' ? -1 : 1);
      }

      return 0;
    });
  }

  private project(model: string, row: Row, args: any): Row {
    const info = this.info(model);
    const out: Row = {};
    const select = args?.select;
    const include = args?.include;

    if (select && include) throw new Error('select and include cannot be used together');

    const addRelation = (name: string, sub: any) => {
      const field = this.field(model, name);

      if (field.kind !== 'relation') throw new Error(`${model}.${name} is not a relation`);

      const subArgs = sub === true ? {} : sub;
      let rows = this.related(model, row, field);

      if (subArgs.where) rows = rows.filter((target) => this.matches(field.type, target, subArgs.where));
      rows = this.order(field.type, rows, subArgs.orderBy);
      if (subArgs.skip) rows = rows.slice(subArgs.skip);
      if (subArgs.take !== undefined) rows = rows.slice(0, subArgs.take);

      const shaped = rows.map((target) => this.project(field.type, target, subArgs));

      out[name] = field.list ? shaped : (shaped[0] ?? null);
    };

    const addCount = (spec: any) => {
      const wanted = spec === true ? Object.fromEntries([...info.fields.values()].filter((f) => f.kind === 'relation' && f.list).map((f) => [f.name, true])) : spec.select;

      out._count = Object.fromEntries(
        Object.entries<any>(wanted).map(([name, sub]) => {
          const field = this.field(model, name);
          let rows = this.related(model, row, field);

          if (sub && sub !== true && sub.where) rows = rows.filter((target) => this.matches(field.type, target, sub.where));

          return [name, rows.length];
        }),
      );
    };

    if (select) {
      for (const [name, wanted] of Object.entries<any>(select)) {
        if (!wanted) continue;
        if (name === '_count') addCount(wanted);
        else if (this.field(model, name).kind === 'relation') addRelation(name, wanted);
        else out[name] = clone(row[name] ?? null);
      }

      return out;
    }

    for (const field of info.fields.values()) {
      if (field.kind !== 'relation') out[field.name] = clone(row[field.name] ?? null);
    }

    if (include) {
      for (const [name, wanted] of Object.entries<any>(include)) {
        if (!wanted) continue;
        if (name === '_count') addCount(wanted);
        else addRelation(name, wanted);
      }
    }

    return out;
  }

  private find(model: string, args: any = {}): Row[] {
    let rows = (this.tables.get(model) as Row[]).filter((row) => this.matches(model, row, args.where));

    rows = this.order(model, rows, args.orderBy);

    if (args.distinct) {
      const columns: string[] = Array.isArray(args.distinct) ? args.distinct : [args.distinct];
      const seen = new Set<string>();

      rows = rows.filter((row) => {
        const key = JSON.stringify(columns.map((column) => row[column]));

        if (seen.has(key)) return false;
        seen.add(key);

        return true;
      });
    }

    if (args.skip) rows = rows.slice(args.skip);
    if (args.take !== undefined) rows = rows.slice(0, args.take);

    return rows;
  }

  // ------------------------------------------------------------------ writing

  private newId(model: string): number {
    const next = (this.counters.get(model) ?? 0) + 1;

    this.counters.set(model, next);

    return next;
  }

  private defaultValue(model: string, field: FieldInfo): unknown {
    const expr = field.defaultExpr;

    if (expr === null) return undefined;
    if (expr === 'autoincrement()') return this.newId(model);
    if (expr === 'now()') return this.clock();
    if (expr === 'uuid()' || expr === 'cuid()') return `${model.toLowerCase()}-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    if (expr === 'true') return true;
    if (expr === 'false') return false;
    if (expr === '[]') return [];
    if (/^-?\d+(\.\d+)?$/.test(expr)) return Number(expr);

    const quoted = /^"(.*)"$/.exec(expr);

    if (quoted) return quoted[1];
    if (field.kind === 'enum' && /^\w+$/.test(expr)) return expr;

    throw new Error(`${model}.${field.name}: cannot evaluate @default(${expr})`);
  }

  private record(tx: { journal: JournalEntry[] } | null, entry: JournalEntry) {
    if (tx) tx.journal.push(entry);
  }

  /** What the column keeps: a DECIMAL column rounds to its scale and holds a Decimal, whatever was given. */
  private stored(model: string, field: FieldInfo, value: unknown): unknown {
    if (field.type !== 'Decimal' || field.list || value === null || value === undefined) return clone(value);

    return toColumnDecimal(value, field.precision, field.scale, `${model}.${field.name}`);
  }

  private decimalAggregate(aggregate: string, values: unknown[]): Decimal | null {
    if (!values.length) return null;
    if (aggregate === '_sum') return sumDecimals(values);
    if (aggregate === '_avg') return averageDecimals(values);

    const pick = aggregate === '_min' ? -1 : 1;

    return values.reduce((best, value) => (compareDecimals(value, best) === pick ? value : best)) as Decimal;
  }

  private checkType(model: string, field: FieldInfo, value: unknown) {
    if (value === null || value === undefined) return;

    const bad = (expected: string) => {
      throw new Error(`${model}.${field.name} expects ${expected}, got ${typeof value}: ${String(value).slice(0, 40)}`);
    };

    if (field.list) {
      if (!Array.isArray(value)) bad('a list');

      return;
    }

    if (field.type === 'Int' && !Number.isInteger(value)) bad('an integer');
    if (field.type === 'Float' && typeof value !== 'number') bad('a number');
    if (field.type === 'Decimal' && !isDecimalInput(value)) bad('a number, a decimal text or a Decimal');
    if (field.type === 'String' && typeof value !== 'string') bad('a string');
    if (field.type === 'Boolean' && typeof value !== 'boolean') bad('a boolean');
    if (field.type === 'DateTime' && !(value instanceof Date) && typeof value !== 'string') bad('a date');
    if (field.kind === 'enum' && typeof value !== 'string') bad('an enum value');
  }

  private assertUnique(model: string, candidate: Row, ignore: Row | null) {
    for (const columns of this.info(model).uniques) {
      if (columns.some((column) => candidate[column] === null || candidate[column] === undefined)) continue;

      const clash = (this.tables.get(model) as Row[]).some(
        (row) => row !== ignore && columns.every((column) => sameValue(row[column], candidate[column])),
      );

      if (clash) {
        throw prismaError('P2002', `Unique constraint failed on the fields: (${columns.map((column) => `\`${column}\``).join(',')})`, { target: columns });
      }
    }
  }

  /** Stores a new row (after its scalar data and the keys of its parents are known). */
  private insert(model: string, data: Row, tx: { journal: JournalEntry[] } | null): Row {
    const info = this.info(model);
    const row: Row = {};

    for (const field of info.fields.values()) {
      if (field.kind === 'relation') continue;

      let value = data[field.name];

      if (value === undefined) value = this.defaultValue(model, field);
      if (value === undefined && field.updatedAt) value = this.clock();
      if (value === undefined) value = field.optional ? null : undefined;
      if (value === undefined && field.list) value = [];

      if (value === undefined) {
        throw new Error(`${model}.${field.name} is required and was not given`);
      }

      this.checkType(model, field, value);
      row[field.name] = this.stored(model, field, value);

      if (field.id && field.defaultExpr === 'autoincrement()' && typeof row[field.name] === 'number') {
        this.counters.set(model, Math.max(this.counters.get(model) ?? 0, row[field.name]));
      }
    }

    for (const key of Object.keys(data)) {
      if (!info.fields.has(key)) throw new Error(`${model} has no field "${key}" (in a create)`);
    }

    this.assertUnique(model, row, null);
    (this.tables.get(model) as Row[]).push(row);
    this.record(tx, { table: model, before: null, after: row });

    return row;
  }

  /** Splits `data` into scalar columns, and runs the nested writes of the relations that hold the key here. */
  private async prepare(model: string, data: Row, tx: any, creating: boolean): Promise<{ scalars: Row; after: Array<(row: Row) => Promise<void>> }> {
    const scalars: Row = {};
    const after: Array<(row: Row) => Promise<void>> = [];

    for (const [key, value] of Object.entries<any>(data ?? {})) {
      if (value === undefined) continue;

      const field = this.info(model).fields.get(key);

      if (!field) throw new Error(`${model} has no field "${key}" (in a write)`);

      if (field.kind !== 'relation') {
        scalars[key] = value;
        continue;
      }

      const link = this.link(model, field);

      if (link.holdsKey) {
        const operations = Object.keys(value);

        for (const operation of operations) {
          if (operation === 'connect') {
            const target = this.uniqueRow(field.type, value.connect);

            if (!target) throw prismaError('P2025', `An operation failed because it depends on one or more records that were required but not found. (${field.name})`);

            link.here.forEach((column, index) => (scalars[column] = target[link.there[index]]));
          } else if (operation === 'create') {
            const created = await this.createRow(field.type, value.create, tx);

            link.here.forEach((column, index) => (scalars[column] = created[link.there[index]]));
          } else if (operation === 'connectOrCreate') {
            const target = this.uniqueRow(field.type, value.connectOrCreate.where) ?? (await this.createRow(field.type, value.connectOrCreate.create, tx));

            link.here.forEach((column, index) => (scalars[column] = target[link.there[index]]));
          } else if (operation === 'disconnect') {
            link.here.forEach((column) => (scalars[column] = null));
          } else {
            throw new Error(`${model}.${field.name}: nested "${operation}" is not supported`);
          }
        }

        continue;
      }

      // The other table holds the key: written once this row exists.
      after.push(async (row) => {
        const withKey = (child: Row) => ({ ...child, ...Object.fromEntries(link.there.map((column, index) => [column, row[link.here[index]]])) });

        for (const [operation, payload] of Object.entries<any>(value)) {
          if (operation === 'create') {
            for (const child of Array.isArray(payload) ? payload : [payload]) await this.createRow(field.type, withKey(child), tx);
          } else if (operation === 'createMany') {
            for (const child of payload.data) await this.createRow(field.type, withKey(child), tx);
          } else if (operation === 'connect') {
            for (const where of Array.isArray(payload) ? payload : [payload]) {
              const child = this.uniqueRow(field.type, where);

              if (!child) throw prismaError('P2025', `An operation failed because it depends on one or more records that were required but not found. (${field.name})`);

              this.change(field.type, child, withKey({}), tx);
            }
          } else if (operation === 'disconnect' || operation === 'set') {
            if (operation === 'set' && !creating) {
              for (const child of this.related(model, row, field)) this.change(field.type, child, Object.fromEntries(link.there.map((c) => [c, null])), tx);
            }

            for (const where of operation === 'set' ? payload : Array.isArray(payload) ? payload : [payload]) {
              const child = this.uniqueRow(field.type, where);

              if (!child) continue;

              this.change(field.type, child, operation === 'set' ? withKey({}) : Object.fromEntries(link.there.map((c) => [c, null])), tx);
            }
          } else if (operation === 'update') {
            for (const item of Array.isArray(payload) ? payload : [payload]) {
              const child = this.related(model, row, field).find((candidate) => this.matches(field.type, candidate, item.where));

              if (!child) throw prismaError('P2025', 'Record to update not found.');

              await this.updateRow(field.type, child, item.data, tx);
            }
          } else if (operation === 'deleteMany') {
            for (const child of this.related(model, row, field).filter((candidate) => this.matches(field.type, candidate, payload))) this.remove(field.type, child, tx);
          } else if (operation === 'updateMany') {
            for (const child of this.related(model, row, field).filter((candidate) => this.matches(field.type, candidate, payload.where))) await this.updateRow(field.type, child, payload.data, tx);
          } else {
            throw new Error(`${model}.${field.name}: nested "${operation}" is not supported`);
          }
        }
      });
    }

    return { scalars, after };
  }

  private uniqueRow(model: string, where: Row): Row | undefined {
    return (this.tables.get(model) as Row[]).find((row) => this.matches(model, row, where));
  }

  private async createRow(model: string, data: Row, tx: any): Promise<Row> {
    const { scalars, after } = await this.prepare(model, data, tx, true);
    const row = this.insert(model, scalars, tx);

    for (const step of after) await step(row);

    return row;
  }

  private change(model: string, row: Row, changes: Row, tx: any) {
    const info = this.info(model);
    const next: Row = { ...row };

    for (const [key, value] of Object.entries<any>(changes)) {
      const field = this.field(model, key);

      if (value !== null && typeof value === 'object' && !(value instanceof Date) && !(value instanceof Decimal) && !Array.isArray(value) && field.kind === 'scalar' && field.type !== 'Json') {
        const operations = Object.keys(value);
        const current = row[key];

        if (field.type === 'Decimal' && !field.list && operations.some((operation) => ['increment', 'decrement', 'multiply', 'divide'].includes(operation))) {
          const operand = value[operations[0]];

          this.checkType(model, field, operand);

          const here = new Decimal(current ?? 0);
          const result = 'increment' in value ? here.plus(operand) : 'decrement' in value ? here.minus(operand) : 'multiply' in value ? here.times(operand) : here.dividedBy(operand);

          next[key] = this.stored(model, field, result);
        } else if (operations.includes('set')) next[key] = this.stored(model, field, value.set);
        else if ('increment' in value) next[key] = (current ?? 0) + value.increment;
        else if ('decrement' in value) next[key] = (current ?? 0) - value.decrement;
        else if ('multiply' in value) next[key] = (current ?? 0) * value.multiply;
        else if ('divide' in value) next[key] = (current ?? 0) / value.divide;
        else if ('push' in value) next[key] = [...(current ?? []), ...(Array.isArray(value.push) ? value.push : [value.push])];
        else throw new Error(`${model}.${key}: unknown update operator ${operations.join(', ')}`);
      } else {
        this.checkType(model, field, value);
        next[key] = this.stored(model, field, value);
      }

      if (value === null && !field.optional) throw new Error(`${model}.${key} cannot be null`);
    }

    for (const field of info.fields.values()) {
      if (field.updatedAt) next[field.name] = this.clock();
    }

    this.assertUnique(model, next, row);

    const before = { ...row };

    this.record(tx, { table: model, before, after: row });
    Object.keys(row).forEach((key) => delete row[key]);
    Object.assign(row, next);
  }

  /**
   * One UPDATE statement. The nested writes that look other rows up are done first (they may wait), then the
   * rows are found and changed in one go with nothing awaited in between: like Postgres, two statements
   * never interleave between "which rows match" and "change them", so the second of two identical claims
   * finds nothing left to claim.
   */
  private async applyUpdate(model: string, locate: () => Row[], data: Row, tx: any): Promise<Row[]> {
    const { scalars, after } = await this.prepare(model, data, tx, false);
    const rows = locate();

    for (const row of rows) this.change(model, row, scalars, tx);
    for (const row of rows) for (const step of after) await step(row);

    return rows;
  }

  private async updateRow(model: string, row: Row, data: Row, tx: any): Promise<Row> {
    await this.applyUpdate(model, () => ((this.tables.get(model) as Row[]).includes(row) ? [row] : []), data, tx);

    return row;
  }

  private remove(model: string, row: Row, tx: any) {
    const rows = this.tables.get(model) as Row[];
    const at = rows.indexOf(row);

    if (at < 0) return;

    rows.splice(at, 1);
    this.record(tx, { table: model, before: { ...row }, after: null });
  }

  // ------------------------------------------------------------------ the delegate of a model

  private delegate(model: string, tx: any) {
    const self = this;
    const note = (operation: string) => self.calls.push(`${lowerFirst(model)}.${operation}`);
    const single = (rows: Row[], args: any) => (rows[0] ? self.project(model, rows[0], args) : null);
    const needOne = (rows: Row[], args: any) => {
      if (!rows[0]) throw prismaError('P2025', 'No record was found for a query.');

      return self.project(model, rows[0], args);
    };

    return {
      findUnique: async (args: any) => (note('findUnique'), single(self.find(model, { where: args.where }), args)),
      findUniqueOrThrow: async (args: any) => (note('findUniqueOrThrow'), needOne(self.find(model, { where: args.where }), args)),
      findFirst: async (args: any = {}) => (note('findFirst'), single(self.find(model, { ...args, take: 1 }), args)),
      findFirstOrThrow: async (args: any = {}) => (note('findFirstOrThrow'), needOne(self.find(model, { ...args, take: 1 }), args)),
      findMany: async (args: any = {}) => (note('findMany'), self.find(model, args).map((row) => self.project(model, row, args))),
      count: async (args: any = {}) => {
        note('count');

        if (args.select) {
          const rows = self.find(model, { where: args.where });

          return Object.fromEntries(Object.entries<any>(args.select).filter(([, wanted]) => wanted).map(([name]) => [name, name === '_all' ? rows.length : rows.filter((row) => row[name] !== null && row[name] !== undefined).length]));
        }

        return self.find(model, { where: args.where, skip: args.skip, take: args.take }).length;
      },
      aggregate: async (args: any = {}) => {
        note('aggregate');

        const rows = self.find(model, { where: args.where });
        const out: Row = {};
        const numbers = (column: string) => rows.map((row) => row[column]).filter((value) => value !== null && value !== undefined) as number[];
        const decimal = (column: string) => this.field(model, column).type === 'Decimal';

        for (const [aggregate, columns] of Object.entries<any>(args)) {
          if (!aggregate.startsWith('_')) continue;

          out[aggregate] = {};

          for (const column of Object.keys(columns)) {
            const values = numbers(column);

            if (aggregate === '_count') out._count[column] = column === '_all' ? rows.length : values.length;
            else if (column !== '_all' && decimal(column) && ['_sum', '_avg', '_min', '_max'].includes(aggregate)) {
              out[aggregate][column] = this.decimalAggregate(aggregate, values);
            } else if (aggregate === '_sum') out._sum[column] = values.length ? values.reduce((a, b) => a + b, 0) : null;
            else if (aggregate === '_avg') out._avg[column] = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
            else if (aggregate === '_min') out._min[column] = values.length ? Math.min(...values) : null;
            else if (aggregate === '_max') out._max[column] = values.length ? Math.max(...values) : null;
            else throw new Error(`aggregate ${aggregate} is not supported`);
          }

          if (aggregate === '_count' && columns === true) out._count = rows.length;
        }

        return out;
      },
      groupBy: async (args: any) => {
        note('groupBy');

        const rows = self.find(model, { where: args.where });
        const by: string[] = Array.isArray(args.by) ? args.by : [args.by];
        const groups = new Map<string, Row[]>();

        for (const row of rows) {
          const key = JSON.stringify(by.map((column) => row[column]));

          groups.set(key, [...(groups.get(key) ?? []), row]);
        }

        return [...groups.values()].map((members) => {
          const out: Row = Object.fromEntries(by.map((column) => [column, members[0][column]]));

          if (args._count) out._count = args._count === true ? members.length : Object.fromEntries(Object.keys(args._count).map((column) => [column, column === '_all' ? members.length : members.filter((m) => m[column] != null).length]));
          if (args._sum) {
            out._sum = Object.fromEntries(
              Object.keys(args._sum).map((column) => [
                column,
                self.field(model, column).type === 'Decimal'
                  ? sumDecimals(members.map((m) => m[column]).filter((value) => value !== null && value !== undefined))
                  : members.reduce((sum, m) => sum + (m[column] ?? 0), 0),
              ]),
            );
          }

          return out;
        });
      },
      create: async (args: any) => {
        note('create');

        return self.project(model, await self.createRow(model, args.data, tx), args);
      },
      createMany: async (args: any) => {
        note('createMany');

        for (const item of args.data) await self.createRow(model, item, tx);

        return { count: args.data.length };
      },
      update: async (args: any) => {
        note('update');

        if (!self.find(model, { where: args.where })[0]) throw prismaError('P2025', 'Record to update not found.');

        const [row] = await self.applyUpdate(model, () => self.find(model, { where: args.where }).slice(0, 1), args.data, tx);

        if (!row) throw prismaError('P2025', 'Record to update not found.');

        return self.project(model, row, args);
      },
      updateMany: async (args: any) => {
        note('updateMany');

        const hit = await self.applyUpdate(model, () => self.find(model, { where: args.where }), args.data, tx);

        return { count: hit.length };
      },
      upsert: async (args: any) => {
        note('upsert');

        const row = self.find(model, { where: args.where })[0];

        return self.project(model, row ? await self.updateRow(model, row, args.update, tx) : await self.createRow(model, args.create, tx), args);
      },
      delete: async (args: any) => {
        note('delete');

        const row = self.find(model, { where: args.where })[0];

        if (!row) throw prismaError('P2025', 'Record to delete does not exist.');

        const shown = self.project(model, row, args);

        self.remove(model, row, tx);

        return shown;
      },
      deleteMany: async (args: any = {}) => {
        note('deleteMany');

        const hit = self.find(model, { where: args.where });

        for (const row of hit) self.remove(model, row, tx);

        return { count: hit.length };
      },
    };
  }
}
