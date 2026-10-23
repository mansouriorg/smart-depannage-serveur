/**
 * The plan of `scripts/migrate-money.ts` (P2-01): which columns become DECIMAL, and the SQL that moves them.
 *
 * The plan is read from `prisma/schema.prisma` itself (every `@db.Decimal(p, s)` column), so that it cannot fall behind the
 * schema: a money column added later is in the plan the day it is written. Nothing here touches a database; the script runs
 * the statements, and the specs read them.
 *
 * Why not leave it to `prisma db push`: it would change the type of the columns and, for a table that has rows, ask to
 * accept a data loss without saying which rows lose what. The script changes the type itself, with an explicit
 * `ROUND(..., scale)` (3 for an amount, 2 for a rate), and tells beforehand how many rows hold more decimals than their
 * column keeps and by how much the most changed one moves. `db push` then finds nothing to do.
 */

export interface DecimalColumn {
  model: string;
  /** The table: the model name unless `@@map` renames it. */
  table: string;
  column: string;
  precision: number;
  scale: number;
  optional: boolean;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function planDecimalColumns(schemaText: string): DecimalColumn[] {
  const columns: DecimalColumn[] = [];
  const models = schemaText.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm);

  for (const [, model, body] of models) {
    const map = /@@map\(\s*"([^"]+)"\s*\)/.exec(body);
    const table = map ? map[1] : model;

    for (const line of body.split('\n')) {
      const field = /^\s*(\w+)\s+Decimal(\?)?(?:\s+(.*))?$/.exec(line.replace(/\/\/.*$/, ''));

      if (!field) continue;

      const db = /@db\.Decimal\(\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(field[3] ?? '');

      if (!db) throw new Error(`${model}.${field[1]} is a Decimal without @db.Decimal(precision, scale)`);
      if (!IDENTIFIER.test(table) || !IDENTIFIER.test(field[1])) throw new Error(`${model}.${field[1]}: unsafe name`);

      columns.push({ model, table, column: field[1], precision: Number(db[1]), scale: Number(db[2]), optional: Boolean(field[2]) });
    }
  }

  return columns;
}

const q = (name: string) => `"${name}"`;

/** Changes the type of one column; rounds to the scale, half away from zero, as PostgreSQL does for NUMERIC. */
export function alterStatement(column: DecimalColumn): string {
  const target = `NUMERIC(${column.precision},${column.scale})`;

  return `ALTER TABLE ${q(column.table)} ALTER COLUMN ${q(column.column)} TYPE ${target} USING ROUND(${q(column.column)}::numeric, ${column.scale})`;
}

/** How many rows hold a value that is not already a whole number of the column's scale (these are the rows the conversion changes), and the largest change. */
export function roundingQuery(column: DecimalColumn): string {
  const c = q(column.column);

  return (
    `SELECT COUNT(*)::int AS changed, ` +
    `MAX(ABS(${c}::numeric - ROUND(${c}::numeric, ${column.scale})))::text AS largest ` +
    `FROM ${q(column.table)} WHERE ${c} IS NOT NULL AND ${c}::numeric <> ROUND(${c}::numeric, ${column.scale})`
  );
}

export const COLUMN_TYPE_QUERY =
  `SELECT table_name, column_name, data_type, numeric_precision, numeric_scale FROM information_schema.columns ` +
  `WHERE table_schema = current_schema() AND table_name = ANY($1)`;

/** True when the column is still a floating-point column (so that the script converts it). */
export function needsConversion(info: { data_type: string; numeric_precision: number | null; numeric_scale: number | null } | undefined, column: DecimalColumn): boolean {
  if (!info) return false;
  if (info.data_type === 'double precision' || info.data_type === 'real') return true;

  return info.data_type === 'numeric' && (info.numeric_precision !== column.precision || info.numeric_scale !== column.scale);
}

/** Tables with a currency column that has been written as EUR by the old default. */
export function currencyColumns(schemaText: string): Array<{ table: string; column: string }> {
  const found: Array<{ table: string; column: string }> = [];

  for (const [, model, body] of schemaText.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const map = /@@map\(\s*"([^"]+)"\s*\)/.exec(body);

    if (/^\s*currency\s+String\b/m.test(body)) found.push({ table: map ? map[1] : model, column: 'currency' });
  }

  return found;
}
