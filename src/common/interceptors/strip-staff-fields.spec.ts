import { stripStaffFields } from './strip-staff-fields';

describe('stripStaffFields', () => {
  it('removes staff-only keys at any depth, in objects and arrays', () => {
    const input = {
      id: 1,
      adminInternalNotes: 'secret',
      intervention: {
        id: 2,
        trackingToken: 'abc',
        client: { name: 'A' },
        payments: [{ id: 3, adminNote: 'x', amount: 10 }],
      },
    };

    expect(stripStaffFields(input)).toEqual({
      id: 1,
      intervention: {
        id: 2,
        client: { name: 'A' },
        payments: [{ id: 3, amount: 10 }],
      },
    });
  });

  it('does not mutate its input', () => {
    const input = { id: 1, adminNote: 'x' };

    stripStaffFields(input);

    expect(input).toEqual({ id: 1, adminNote: 'x' });
  });

  it('leaves dates, buffers and primitives untouched', () => {
    const date = new Date('2026-01-01T00:00:00Z');
    const buffer = Buffer.from('pdf');

    const out: any = stripStaffFields({ at: date, file: buffer, n: 5, s: 'x', nothing: null });

    expect(out.at).toBe(date);
    expect(out.file).toBe(buffer);
    expect(out.n).toBe(5);
    expect(out.s).toBe('x');
    expect(out.nothing).toBeNull();
  });

  it('keeps fields that merely contain the word admin', () => {
    expect(stripStaffFields({ adminDecisionNote: 'for the client' })).toEqual({
      adminDecisionNote: 'for the client',
    });
  });
});
