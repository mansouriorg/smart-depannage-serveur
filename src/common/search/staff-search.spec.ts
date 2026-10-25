import { MAX_ROW_ID, MAX_SEARCH_LENGTH, NOTHING, idOf, likeContains, likeLiteral, phoneConditions, rowNumber, searchText, withoutNul } from './staff-search';

/** What the search boxes of the back office share (P2-09): the text, a number, a phone, a bad id. */

describe('searchText', () => {
  it('trims what the person typed', () => {
    expect(searchText('  fuite  ')).toBe('fuite');
    expect(searchText('\n\tfuite\t')).toBe('fuite');
  });

  it('is empty for nothing, for spaces, and for what is not text', () => {
    expect(searchText(undefined)).toBe('');
    expect(searchText(null)).toBe('');
    expect(searchText('   ')).toBe('');
    expect(searchText('\u0000')).toBe('');
  });

  it('reads a number as text', () => {
    expect(searchText(12)).toBe('12');
  });

  it('cuts a long text at the limit, and trims again what the cut leaves at its end', () => {
    expect(MAX_SEARCH_LENGTH).toBe(100);
    expect(searchText('a'.repeat(300))).toHaveLength(100);
    expect(searchText(`${'a'.repeat(99)} ${'b'.repeat(50)}`)).toBe('a'.repeat(99));
  });

  it('does not cut a text of exactly the limit', () => {
    expect(searchText('a'.repeat(100))).toHaveLength(100);
    expect(searchText('a'.repeat(101))).toHaveLength(100);
  });

  it('drops a NUL byte, which PostgreSQL refuses with an error', () => {
    expect(searchText('fu\u0000ite')).toBe('fuite');
    expect(withoutNul('a\u0000b\u0000')).toBe('ab');
  });
});

describe('likeLiteral', () => {
  it('makes the three characters of LIKE literal, so that "50%" finds 50% and not every row', () => {
    expect(likeLiteral('50%')).toBe('50\\%');
    expect(likeLiteral('VIR_1')).toBe('VIR\\_1');
    expect(likeLiteral('a\\b')).toBe('a\\\\b');
  });

  it('escapes every one of them, not only the first', () => {
    expect(likeLiteral('%_%_\\')).toBe('\\%\\_\\%\\_\\\\');
    expect(likeLiteral('100% de 50% à 20_000')).toBe('100\\% de 50\\% à 20\\_000');
  });

  it('leaves alone a text that has none of them', () => {
    expect(likeLiteral('F-2026-0001')).toBe('F-2026-0001');
    expect(likeLiteral('')).toBe('');
    expect(likeLiteral("l'évier fuit")).toBe("l'évier fuit");
  });
});

describe('likeContains', () => {
  it('is a case-insensitive "contains" on the text with the characters of LIKE taken literally', () => {
    expect(likeContains('Fuite')).toEqual({ contains: 'Fuite', mode: 'insensitive' });
    expect(likeContains('50%')).toEqual({ contains: '50\\%', mode: 'insensitive' });
    expect(likeContains('a_b')).toEqual({ contains: 'a\\_b', mode: 'insensitive' });
  });
});

describe('rowNumber', () => {
  it('reads "12" and "#12" as the row 12', () => {
    expect(rowNumber('12')).toBe(12);
    expect(rowNumber('#12')).toBe(12);
    expect(rowNumber('# 12')).toBe(12);
  });

  it('is not a row for text that merely starts or ends with a number', () => {
    expect(rowNumber('12a')).toBeNull();
    expect(rowNumber('a12')).toBeNull();
    expect(rowNumber('12 34')).toBeNull();
    expect(rowNumber('')).toBeNull();
    expect(rowNumber('-3')).toBeNull();
    expect(rowNumber('1.5')).toBeNull();
  });

  it('is not a row for zero, nor for a number past the largest id of the database', () => {
    expect(rowNumber('0')).toBeNull();
    expect(rowNumber('000')).toBeNull();
    expect(rowNumber(String(MAX_ROW_ID))).toBe(MAX_ROW_ID);
    expect(rowNumber(String(MAX_ROW_ID + 1))).toBeNull();
    expect(rowNumber('99999999999999999999')).toBeNull();
  });
});

describe('idOf', () => {
  it('reads a whole number from the query', () => {
    expect(idOf('7')).toBe(7);
    expect(idOf(7)).toBe(7);
    expect(idOf(' 7 ')).toBe(7);
  });

  it('is null for what is no row: text, a fraction, zero, a negative, past the database, nothing', () => {
    for (const bad of ['abc', '1.5', 0, '0', -1, '-1', MAX_ROW_ID + 1, 'NaN', undefined, {}, [], 'Infinity']) expect(idOf(bad)).toBeNull();
  });

  it('keeps the largest id of the database', () => {
    expect(idOf(MAX_ROW_ID)).toBe(MAX_ROW_ID);
  });
});

describe('NOTHING', () => {
  it('is a condition no row satisfies, not an empty one that every row does', () => {
    expect(NOTHING).toEqual({ id: { in: [] } });
  });
});

describe('phoneConditions', () => {
  const leaf = (column: string) => (value: Record<string, unknown>) => ({ [column]: value });

  it('looks for a text that is no phone as typed, in every place', () => {
    expect(phoneConditions('fuite', [leaf('a'), leaf('b')])).toEqual([{ a: { contains: 'fuite', mode: 'insensitive' } }, { b: { contains: 'fuite', mode: 'insensitive' } }]);
  });

  it('looks for a number in every way it may have been written, in every place', () => {
    const found = phoneConditions('22123456', [leaf('a'), leaf('b')]);
    const spellings = found.map((condition) => (Object.values(condition)[0] as { contains: string }).contains);

    expect(spellings.includes('22123456')).toBe(true);
    expect(spellings.includes('22 123 456')).toBe(true);
    expect(found).toHaveLength(4);
    expect(found.filter((condition) => 'a' in condition)).toHaveLength(2);
    expect(found.filter((condition) => 'b' in condition)).toHaveLength(2);
  });

  it('adds the account key of the phone (digits only) where the account keeps one', () => {
    const found = phoneConditions('+216 22 123 456', [leaf('a')], [(digits) => ({ key: { contains: digits } })]);

    expect(found.some((condition) => JSON.stringify(condition) === JSON.stringify({ key: { contains: '21622123456' } }))).toBe(true);
    expect(found.some((condition) => 'a' in condition && (condition as any).a.contains === '22123456')).toBe(true);
  });

  it('does not look for the account key of a text that is no phone', () => {
    expect(phoneConditions('fuite', [leaf('a')], [(digits) => ({ key: { contains: digits } })])).toEqual([{ a: { contains: 'fuite', mode: 'insensitive' } }]);
  });

  it('takes the characters of LIKE literally in a text that is no phone', () => {
    expect(phoneConditions('50%', [leaf('a'), leaf('b')])).toEqual([{ a: { contains: '50\\%', mode: 'insensitive' } }, { b: { contains: '50\\%', mode: 'insensitive' } }]);
    expect(phoneConditions('a_b', [leaf('a')])).toEqual([{ a: { contains: 'a\\_b', mode: 'insensitive' } }]);
  });

  it('is not a phone under four digits', () => {
    expect(phoneConditions('123', [leaf('a')], [(digits) => ({ key: { contains: digits } })])).toEqual([{ a: { contains: '123', mode: 'insensitive' } }]);
  });
});
