/**
 * The check behind "invoice numbers have no gaps" (P2-07): reads every invoice and credit note, and says for each series and year
 * whether the ranks are 1, 2, 3 ... n with none missing and none twice, whether the number written on each document is the one its
 * rank says, and whether the counter stands at the last rank given. Only reads (in one snapshot): nothing is written.
 *
 * Usage (from the server folder, with DATABASE_URL in .env):
 *   npm run invoices:audit
 *
 * The exit code is 1 when there is a problem, so a scheduled run can alert on it. Invoices numbered before the counter existed
 * ("INV-...") are counted and left alone: they are not in the series.
 */
import 'dotenv/config';

import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { auditNumbers, describeAudit } from '../src/modules/invoices/number-audit';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  // One snapshot for the three reads: a document made while the script runs must not show up in the counter and not in the list
  // (the counter would look ahead of the documents, a false alarm). Repeatable read: all three see the database as it was at the first.
  const { invoices, creditNotes, counters } = await prisma.$transaction(
    async (tx) => ({
      invoices: await tx.invoice.findMany({ select: { id: true, invoiceNumber: true, numberYear: true, sequence: true }, orderBy: { id: 'asc' } }),
      creditNotes: await tx.creditNote.findMany({ select: { id: true, creditNoteNumber: true, numberYear: true, sequence: true }, orderBy: { id: 'asc' } }),
      counters: await tx.documentCounter.findMany({ select: { series: true, year: true, last: true } }),
    }),
    { isolationLevel: 'RepeatableRead', timeout: 60_000, maxWait: 10_000 },
  );

  const audit = auditNumbers(
    {
      INVOICE: invoices.map((row: any) => ({ id: row.id, number: row.invoiceNumber, year: row.numberYear, sequence: row.sequence })),
      CREDIT_NOTE: creditNotes.map((row: any) => ({ id: row.id, number: row.creditNoteNumber, year: row.numberYear, sequence: row.sequence })),
    },
    counters,
  );

  for (const line of describeAudit(audit)) console.log(line);

  process.exitCode = audit.ok ? 0 : 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 2;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
