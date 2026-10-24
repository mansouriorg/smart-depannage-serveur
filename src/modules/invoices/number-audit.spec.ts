import { MAX_LISTED_GAPS, auditNumbers, describeAudit, NumberedDocument } from './number-audit';

const invoices = (year: number, ranks: number[]): NumberedDocument[] =>
  ranks.map((rank, at) => ({ id: at + 1, number: `F-${year}-${String(rank).padStart(4, '0')}`, year, sequence: rank }));

describe('the audit of the document numbers (P2-07)', () => {
  it('is fine when the ranks are 1 to n, each once, and the counter is at n', () => {
    const audit = auditNumbers({ INVOICE: invoices(2026, [1, 2, 3, 4]), CREDIT_NOTE: [] }, [{ series: 'INVOICE', year: 2026, last: 4 }]);

    expect(audit.ok).toBe(true);
    expect(audit.problems).toEqual([]);
    expect(audit.years).toHaveLength(1);
    expect(audit.years[0]).toMatchObject({ series: 'INVOICE', year: 2026, count: 4, highest: 4, missing: [], duplicated: [], counter: 4, counterOff: false });
  });

  it('is fine with nothing issued yet', () => {
    const audit = auditNumbers({ INVOICE: [], CREDIT_NOTE: [] }, []);

    expect(audit.ok).toBe(true);
    expect(describeAudit(audit)).toEqual(['No document with a rank yet.', 'OK: the numbers have no gaps.']);
  });

  it('finds a gap: a document that was deleted', () => {
    const audit = auditNumbers({ INVOICE: invoices(2026, [1, 2, 4, 5, 8]), CREDIT_NOTE: [] }, [{ series: 'INVOICE', year: 2026, last: 8 }]);

    expect(audit.ok).toBe(false);
    expect(audit.years[0].missing).toEqual([3, 6, 7]);
    expect(audit.problems).toEqual(['INVOICE 2026: rank(s) 3, 6, 7 missing (a gap).']);
  });

  it('finds a number given twice', () => {
    const audit = auditNumbers({ INVOICE: invoices(2026, [1, 2, 2, 3]), CREDIT_NOTE: [] }, [{ series: 'INVOICE', year: 2026, last: 3 }]);

    expect(audit.ok).toBe(false);
    expect(audit.years[0].duplicated).toEqual([2]);
  });

  it('finds a document whose written number is not the one its rank says', () => {
    const rows = invoices(2026, [1, 2, 3]);

    rows[1].number = 'F-2026-0009';

    const audit = auditNumbers({ INVOICE: rows, CREDIT_NOTE: [] }, [{ series: 'INVOICE', year: 2026, last: 3 }]);

    expect(audit.ok).toBe(false);
    expect(audit.years[0].misnumbered).toEqual([{ id: 2, number: 'F-2026-0009', expected: 'F-2026-0002' }]);
  });

  it('finds a counter that is behind (the next number would be a duplicate) or ahead (it would leave a gap), or missing', () => {
    expect(auditNumbers({ INVOICE: invoices(2026, [1, 2, 3]), CREDIT_NOTE: [] }, [{ series: 'INVOICE', year: 2026, last: 2 }]).ok).toBe(false);
    expect(auditNumbers({ INVOICE: invoices(2026, [1, 2, 3]), CREDIT_NOTE: [] }, [{ series: 'INVOICE', year: 2026, last: 5 }]).ok).toBe(false);

    const none = auditNumbers({ INVOICE: invoices(2026, [1, 2, 3]), CREDIT_NOTE: [] }, []);

    expect(none.ok).toBe(false);
    expect(none.problems[0]).toContain('no row');
  });

  it('finds a counter that gave numbers to nothing', () => {
    const audit = auditNumbers({ INVOICE: invoices(2026, [1]), CREDIT_NOTE: [] }, [{ series: 'INVOICE', year: 2026, last: 1 }, { series: 'INVOICE', year: 2025, last: 7 }]);

    expect(audit.ok).toBe(false);
    expect(audit.counterWithoutDocuments).toEqual([{ series: 'INVOICE', year: 2025, last: 7 }]);
  });

  it('counts the invoices and the credit notes in their own series, and each year from 1', () => {
    const credit: NumberedDocument[] = [
      { id: 1, number: 'AV-2026-0001', year: 2026, sequence: 1 },
      { id: 2, number: 'AV-2026-0002', year: 2026, sequence: 2 },
    ];
    const audit = auditNumbers(
      { INVOICE: [...invoices(2025, [1, 2]), ...invoices(2026, [1, 2, 3])].map((row, at) => ({ ...row, id: at + 1 })), CREDIT_NOTE: credit },
      [
        { series: 'INVOICE', year: 2025, last: 2 },
        { series: 'INVOICE', year: 2026, last: 3 },
        { series: 'CREDIT_NOTE', year: 2026, last: 2 },
      ],
    );

    expect(audit.ok).toBe(true);
    expect(audit.years.map((year) => `${year.series} ${year.year}:${year.count}`)).toEqual(['INVOICE 2025:2', 'INVOICE 2026:3', 'CREDIT_NOTE 2026:2']);
  });

  it('leaves the documents numbered before the counter existed alone, and counts them', () => {
    const legacy: NumberedDocument[] = [
      { id: 90, number: 'INV-20240101-0001', year: null, sequence: null },
      { id: 91, number: 'INV-20240102-0007', year: null, sequence: null },
    ];
    const audit = auditNumbers({ INVOICE: [...legacy, ...invoices(2026, [1, 2])], CREDIT_NOTE: [] }, [{ series: 'INVOICE', year: 2026, last: 2 }]);

    expect(audit.ok).toBe(true);
    expect(audit.legacy.INVOICE).toBe(2);
    expect(describeAudit(audit)).toContain('2 invoice(s) numbered before the counter existed (left alone).');
  });

  it('describes a problem for a person, and ends on the verdict', () => {
    const lines = describeAudit(auditNumbers({ INVOICE: invoices(2026, [1, 3]), CREDIT_NOTE: [] }, [{ series: 'INVOICE', year: 2026, last: 3 }]));

    expect(lines[0]).toBe('INVOICE 2026: 2 document(s), ranks 1 to 3, counter 3 - PROBLEM');
    expect(lines).toContain('PROBLEM: INVOICE 2026: rank(s) 2 missing (a gap).');
    expect(lines[lines.length - 1]).toBe('NOT OK: 1 problem(s).');
  });
  describe('on a lot of documents, or on a rank that cannot be right', () => {
    it('reads a year of a hundred and fifty thousand documents (no spread of the ranks into the arguments of a function)', () => {
      const ranks = Array.from({ length: 150_000 }, (_, at) => at + 1);
      const documents = invoices(2026, ranks);
      const started = Date.now();
      const audit = auditNumbers({ INVOICE: documents, CREDIT_NOTE: [] }, [{ series: 'INVOICE', year: 2026, last: 150_000 }]);

      // a few hundred milliseconds; a copy of the list for each document would take minutes
      expect(Date.now() - started).toBeLessThan(5000);
      expect(audit.ok).toBe(true);
      expect(audit.years[0]).toMatchObject({ count: 150_000, highest: 150_000, missing: [] });
    });

    it('names the first gaps of a rank that is far too high and counts the rest, without listing two billion ranks', () => {
      const started = Date.now();
      const audit = auditNumbers({ INVOICE: invoices(2026, [1, 2, 2_000_000_000]), CREDIT_NOTE: [] }, [{ series: 'INVOICE', year: 2026, last: 3 }]);

      expect(Date.now() - started).toBeLessThan(2000);
      expect(audit.ok).toBe(false);
      expect(audit.years[0].missing).toHaveLength(MAX_LISTED_GAPS);
      expect(audit.years[0].missing[0]).toBe(3);
      expect(audit.problems[0]).toContain(`and ${2_000_000_000 - 2 - 1 - MAX_LISTED_GAPS} more missing (a gap).`);
    });

    it('reports a rank that cannot be one (0, a negative) as a problem, with the gap it leaves, instead of stopping', () => {
      const audit = auditNumbers({ INVOICE: invoices(2026, [0, 2, -4]), CREDIT_NOTE: [] }, [{ series: 'INVOICE', year: 2026, last: 2 }]);

      expect(audit.ok).toBe(false);
      expect(audit.problems).toContain('INVOICE 2026: rank(s) 1 missing (a gap).');
      expect(audit.years[0].misnumbered.map((entry) => entry.expected)).toEqual(['(no number can be written for rank 0 of 2026)', '(no number can be written for rank -4 of 2026)']);
      expect(audit.problems.filter((problem) => problem.includes('its rank says'))).toHaveLength(2);
    });

    it('says all the gaps when there are not many', () => {
      const audit = auditNumbers({ INVOICE: invoices(2026, [1, 5]), CREDIT_NOTE: [] }, [{ series: 'INVOICE', year: 2026, last: 5 }]);

      expect(audit.problems).toEqual(['INVOICE 2026: rank(s) 2, 3, 4 missing (a gap).']);
    });
  });
});
