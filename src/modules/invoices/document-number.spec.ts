import { MemoryPrisma } from '../../common/testing/memory-prisma';
import { DOCUMENT_SERIES, formatDocumentNumber, lockKeyOf, parseDocumentNumber, takeDocumentNumber } from './document-number';

/** A clock that gives the dates one after the other (the last one again and again). */
const clockOf = (...dates: string[]) => {
  let at = 0;

  return () => new Date(dates[Math.min(at++, dates.length - 1)]);
};

const NOON = '2026-06-15T12:00:00Z';

describe('the numbers of the invoices and of the credit notes (P2-07)', () => {
  describe('how a number is written and read', () => {
    it('writes F-2026-0001 for the first invoice and AV-2026-0012 for the twelfth credit note', () => {
      expect(formatDocumentNumber('INVOICE', 2026, 1)).toBe('F-2026-0001');
      expect(formatDocumentNumber('CREDIT_NOTE', 2026, 12)).toBe('AV-2026-0012');
    });

    it('does not cut a number that has more than four digits', () => {
      expect(formatDocumentNumber('INVOICE', 2026, 9999)).toBe('F-2026-9999');
      expect(formatDocumentNumber('INVOICE', 2026, 10000)).toBe('F-2026-10000');
      expect(parseDocumentNumber('F-2026-10000')).toEqual({ series: 'INVOICE', year: 2026, sequence: 10000 });
    });

    it('refuses a rank or a year that cannot be one', () => {
      expect(() => formatDocumentNumber('INVOICE', 2026, 0)).toThrow('rank');
      expect(() => formatDocumentNumber('INVOICE', 2026, -3)).toThrow('rank');
      expect(() => formatDocumentNumber('INVOICE', 2026, 1.5)).toThrow('rank');
      expect(() => formatDocumentNumber('INVOICE', 26, 1)).toThrow('year');
      expect(() => formatDocumentNumber('INVOICE', 20260, 1)).toThrow('year');
    });

    it('reads back what it wrote, and nothing else (the numbers of before the counter are not in the series)', () => {
      for (const series of DOCUMENT_SERIES) for (const [year, sequence] of [[2026, 1], [2027, 345], [2030, 12345]]) expect(parseDocumentNumber(formatDocumentNumber(series, year, sequence))).toEqual({ series, year, sequence });

      for (const other of ['INV-202606-1767225600000', 'F-2026-001', 'F-2026-0000', 'f-2026-0001', 'F-26-0001', ' F-2026-0001', 'F-2026-0001 ', 'X-2026-0001', '', null, undefined]) expect(parseDocumentNumber(other as any)).toBeNull();
    });

    it('gives each series and year its own lock', () => {
      const keys = new Set([lockKeyOf('INVOICE', 2026), lockKeyOf('CREDIT_NOTE', 2026), lockKeyOf('INVOICE', 2027), lockKeyOf('CREDIT_NOTE', 2027)]);

      expect(keys.size).toBe(4);
      expect(lockKeyOf('INVOICE', 2026)).toBeLessThan(2 ** 31);
    });
  });

  describe('taking numbers', () => {
    const take = (db: any, series: 'INVOICE' | 'CREDIT_NOTE', now?: () => Date) => db.$transaction((tx: any) => takeDocumentNumber(tx, series, now));

    it('gives 1, 2, 3 ... in order, to the invoices and, separately, to the credit notes', async () => {
      const db = new MemoryPrisma().client();
      const invoices = [];
      const notes = [];

      invoices.push((await take(db, 'INVOICE', clockOf(NOON))).number);
      notes.push((await take(db, 'CREDIT_NOTE', clockOf(NOON))).number);
      invoices.push((await take(db, 'INVOICE', clockOf(NOON))).number);
      invoices.push((await take(db, 'INVOICE', clockOf(NOON))).number);
      notes.push((await take(db, 'CREDIT_NOTE', clockOf(NOON))).number);

      expect(invoices).toEqual(['F-2026-0001', 'F-2026-0002', 'F-2026-0003']);
      expect(notes).toEqual(['AV-2026-0001', 'AV-2026-0002']);
    });

    it('starts again at 1 each year, on the clock of the business', async () => {
      const db = new MemoryPrisma().client();

      // 23:30 on 31 December in UTC is already 00:30 on 1 January in Tunis.
      expect((await take(db, 'INVOICE', clockOf('2026-12-31T22:30:00Z'))).number).toBe('F-2026-0001');
      expect((await take(db, 'INVOICE', clockOf('2026-12-31T23:30:00Z'))).number).toBe('F-2027-0001');
      expect((await take(db, 'INVOICE', clockOf('2027-01-01T08:00:00Z'))).number).toBe('F-2027-0002');
      expect((await take(db, 'INVOICE', clockOf('2026-12-31T21:00:00Z'))).number).toBe('F-2026-0002');
    });

    it('gives the date of the document along with the number: the date is taken after the lock', async () => {
      const db = new MemoryPrisma().client();
      const given = await take(db, 'INVOICE', clockOf('2026-06-15T12:00:00Z', '2026-06-15T12:00:05Z'));

      expect(given.issuedAt.toISOString()).toBe('2026-06-15T12:00:05.000Z');
      expect(given).toMatchObject({ series: 'INVOICE', year: 2026, sequence: 1, number: 'F-2026-0001' });
    });

    it('a document that waited for the lock across midnight belongs to the new year', async () => {
      const db = new MemoryPrisma().client();
      const given = await take(db, 'INVOICE', clockOf('2026-12-31T22:59:59Z', '2026-12-31T23:00:01Z'));

      expect(given.number).toBe('F-2027-0001');
      expect(given.issuedAt.toISOString()).toBe('2026-12-31T23:00:01.000Z');
    });

    it('a document that waited for the lock of the new year is dated after it, so that the numbers follow the dates', async () => {
      const db = new MemoryPrisma().client();
      // the year is read at 22:59:59Z (2026 in Tunis), the first lock is ours at 23:00:01Z (already 2027), the second at 23:00:03Z
      const given = await take(db, 'INVOICE', clockOf('2026-12-31T22:59:59Z', '2026-12-31T23:00:01Z', '2026-12-31T23:00:03Z'));

      expect(given.number).toBe('F-2027-0001');
      expect(given.issuedAt.toISOString()).toBe('2026-12-31T23:00:03.000Z');
    });

    it('a document that fails to save leaves its number to the next one: no gap', async () => {
      const memory = new MemoryPrisma();
      const db = memory.client();

      await take(db, 'INVOICE', clockOf(NOON));
      await expect(
        db.$transaction(async (tx: any) => {
          const taken = await takeDocumentNumber(tx, 'INVOICE', clockOf(NOON));

          expect(taken.number).toBe('F-2026-0002');
          throw new Error('the invoice could not be saved');
        }),
      ).rejects.toThrow('could not be saved');

      expect(memory.rows('documentCounter')).toHaveLength(1);
      expect(memory.rows('documentCounter')[0].last).toBe(1);
      expect((await take(db, 'INVOICE', clockOf(NOON))).number).toBe('F-2026-0002');
    });

    it('a year that was never used starts at 1 and leaves no row behind when it fails', async () => {
      const memory = new MemoryPrisma();
      const db = memory.client();

      await expect(
        db.$transaction(async (tx: any) => {
          await takeDocumentNumber(tx, 'CREDIT_NOTE', clockOf(NOON));
          throw new Error('no');
        }),
      ).rejects.toThrow('no');

      expect(memory.rows('documentCounter')).toHaveLength(0);
      expect((await take(db, 'CREDIT_NOTE', clockOf(NOON))).number).toBe('AV-2026-0001');
    });

    it('a document waits for the one before it to be saved (or to fail) before it takes its number', async () => {
      const db = new MemoryPrisma().client();
      const log: string[] = [];
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

      const first = db.$transaction(async (tx: any) => {
        const taken = await takeDocumentNumber(tx, 'INVOICE', clockOf(NOON));

        log.push(`first took ${taken.sequence}`);
        await sleep(30);
        log.push('first saved');
      });

      await sleep(5);

      const second = db.$transaction(async (tx: any) => {
        const taken = await takeDocumentNumber(tx, 'INVOICE', clockOf(NOON));

        log.push(`second took ${taken.sequence}`);
      });

      await Promise.all([first, second]);

      expect(log).toEqual(['first took 1', 'first saved', 'second took 2']);
    });

    it('the credit notes and the invoices do not wait for each other, nor do two different years', async () => {
      const db = new MemoryPrisma().client();
      const log: string[] = [];
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

      const first = db.$transaction(async (tx: any) => {
        await takeDocumentNumber(tx, 'INVOICE', clockOf(NOON));
        await sleep(30);
        log.push('invoice saved');
      });

      await sleep(5);

      await db.$transaction(async (tx: any) => {
        await takeDocumentNumber(tx, 'CREDIT_NOTE', clockOf(NOON));
        await takeDocumentNumber(tx, 'INVOICE', clockOf('2027-03-01T12:00:00Z'));
        log.push('others saved');
      });

      await first;

      expect(log).toEqual(['others saved', 'invoice saved']);
    });

    it('twenty documents written at the same moment get twenty different numbers, 1 to 20, whatever the order they finish in', async () => {
      const memory = new MemoryPrisma();
      const db = memory.client();
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

      const numbers = await Promise.all(
        Array.from({ length: 20 }, (_, at) =>
          db.$transaction(async (tx: any) => {
            await sleep((at * 7) % 5);
            const taken = await takeDocumentNumber(tx, 'INVOICE', clockOf(NOON));

            await sleep((at * 3) % 4);

            return taken.sequence;
          }),
        ),
      );

      expect([...numbers].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, at) => at + 1));
      expect(memory.rows('documentCounter')[0].last).toBe(20);
    });

    it('when some of the documents fail, the ones that were saved have the numbers 1 to n with nothing missing', async () => {
      const memory = new MemoryPrisma();
      const db = memory.client();
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

      const results = await Promise.allSettled(
        Array.from({ length: 24 }, (_, at) =>
          db.$transaction(async (tx: any) => {
            await sleep(at % 3);
            const taken = await takeDocumentNumber(tx, 'INVOICE', clockOf(NOON));

            await sleep(at % 2);

            // every third document fails after it was given its number
            if (at % 3 === 0) throw new Error(`document ${at} failed`);

            return taken.sequence;
          }),
        ),
      );

      const saved = results.filter((result): result is PromiseFulfilledResult<number> => result.status === 'fulfilled').map((result) => result.value);

      expect(saved).toHaveLength(16);
      expect([...saved].sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, at) => at + 1));
      expect(memory.rows('documentCounter')[0].last).toBe(16);
    });
  });
});
