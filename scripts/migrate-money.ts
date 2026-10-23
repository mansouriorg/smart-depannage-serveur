/**
 * One-off: money columns move from FLOAT to DECIMAL(14,3) (P2-01).
 *
 *   Quote.amountHT 12.345   was a float that printed 12.345 and added up to 37.034999999999997;
 *   it is now a DECIMAL(14,3) that holds exactly 12.345 (the dinar has three decimals: millimes).
 *
 * RUN THIS BEFORE `prisma db push`. `db push` would change the types by itself and ask to accept a data loss without saying
 * which rows are touched; this script changes them with an explicit ROUND(..., 3) and tells beforehand how many rows change.
 * Afterwards `db push` has nothing left to do for these columns (it still adds the new ones: the currency of quotes and
 * invoices, and the locale fields of the company settings).
 *
 * Usage (from the server folder, with DATABASE_URL in .env):
 *   npm run money:migrate                         # dry run: counts the rows that change, writes nothing
 *   npm run money:migrate -- --apply              # changes the types, in one transaction
 *   npm run money:migrate -- --apply --tunisia    # also: existing data was typed in dinars of Tunisia
 *
 * --tunisia (only with --apply) additionally:
 *   - relabels the currency EUR -> TND on every row that carries one (the old default said EUR for amounts typed in dinars),
 *   - sets the VAT rate of the company settings from 20 to 19 (20 % is not a Tunisian rate) when it is still the old default,
 *   - relabels the time zone Europe/Paris -> Africa/Tunis on the appointments (the old default).
 * Without it, only the type of the columns changes. Both steps can be run again: a column already DECIMAL is left alone.
 *
 * Take a database backup before running with --apply.
 */
import 'dotenv/config';

import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';

import {
  COLUMN_TYPE_QUERY,
  alterStatement,
  currencyColumns,
  needsConversion,
  planDecimalColumns,
  roundingQuery,
} from '../src/common/money/migrate-money-plan';

const apply = process.argv.includes('--apply');
const tunisia = process.argv.includes('--tunisia');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  if (tunisia && !apply) {
    console.log('--tunisia only counts anything with --apply; this is a dry run of the types only.\n');
  }

  console.log(apply ? 'APPLY: the column types will be changed.\n' : 'DRY RUN: nothing is written.\n');

  const schema = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');
  const plan = planDecimalColumns(schema);
  const tables = [...new Set(plan.map((entry) => entry.table))];

  const types = await pool.query(COLUMN_TYPE_QUERY, [tables]);
  const typeOf = new Map<string, any>(types.rows.map((row: any) => [`${row.table_name}.${row.column_name}`, row]));

  const todo = plan.filter((entry) => needsConversion(typeOf.get(`${entry.table}.${entry.column}`), entry));
  const missing = plan.filter((entry) => !typeOf.get(`${entry.table}.${entry.column}`));

  console.log(`${plan.length} money column(s) in the schema, ${todo.length} still to convert, ${plan.length - todo.length - missing.length} already DECIMAL.`);

  if (missing.length) {
    console.log(`${missing.length} column(s) do not exist yet (db push will create them): ${missing.map((entry) => `${entry.table}.${entry.column}`).join(', ')}`);
  }

  let touched = 0;
  let largest = 0;

  for (const entry of todo) {
    const result = await pool.query(roundingQuery(entry));
    const { changed, largest: biggest } = result.rows[0];

    touched += changed;
    largest = Math.max(largest, Number(biggest ?? 0));

    if (changed > 0) {
      console.log(`  ${entry.table}.${entry.column}: ${changed} row(s) hold more than ${entry.scale} decimals (the largest change: ${biggest})`);
    }
  }

  console.log(`\n${touched} row(s) are rounded to the scale of their column (the largest change anywhere: ${largest}).`);

  if (!apply) {
    console.log('Run again with --apply to change the types.');

    return;
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    for (const entry of todo) {
      await client.query(alterStatement(entry));
    }

    if (tunisia) {
      let relabelled = 0;

      for (const entry of currencyColumns(schema)) {
        const exists = await client.query(
          `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
          [entry.table, entry.column],
        );

        if (!exists.rowCount) continue;

        const done = await client.query(`UPDATE "${entry.table}" SET "${entry.column}" = 'TND' WHERE "${entry.column}" = 'EUR'`);

        relabelled += done.rowCount ?? 0;
      }

      const settings = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'CompanySettings' AND column_name = 'taxRates'`);

      // The settings of a database that has not been pushed yet have no list of rates: the rate alone is changed.
      const rate = await client.query(`UPDATE "CompanySettings" SET "defaultTaxRate" = 19 WHERE "defaultTaxRate" = 20 ${settings.rowCount ? `AND "taxRates" IS NULL` : ''}`);
      const zones = await client.query(`UPDATE "Appointment" SET "timezone" = 'Africa/Tunis' WHERE "timezone" = 'Europe/Paris'`);

      console.log(`Tunisia: ${relabelled} currency label(s) EUR -> TND, ${rate.rowCount ?? 0} company setting(s) 20 -> 19 %, ${zones.rowCount ?? 0} appointment time zone(s) Europe/Paris -> Africa/Tunis.`);
    }

    await client.query('COMMIT');
    console.log(`\n${todo.length} column(s) converted. Now run: npx prisma db push`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
