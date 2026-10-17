import { planPhoneKeys, PhoneRow } from './phone-backfill';

const row = (id: number, phone: string | null, extra: Partial<PhoneRow> = {}): PhoneRow => ({
  id,
  phone,
  phoneKey: null,
  isGuest: false,
  isActive: true,
  deletedAt: null,
  ...extra,
});

describe('planPhoneKeys', () => {
  it('gives every number its key', () => {
    const plan = planPhoneKeys([row(1, '22 123 456'), row(2, '+216 98 765 432'), row(3, null), row(4, '  ')]);

    expect(plan.assign).toEqual([
      { id: 1, phoneKey: '+21622123456' },
      { id: 2, phoneKey: '+21698765432' },
    ]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.invalid).toEqual([]);
  });

  it('two spellings of one number: the real, live, oldest account keeps it', () => {
    const plan = planPhoneKeys([
      row(1, '22 123 456', { isGuest: true }),
      row(2, '22123456', { isActive: false }),
      row(3, '+216 22 123 456'),
      row(4, '0021622123456'),
    ]);

    expect(plan.assign).toEqual([{ id: 3, phoneKey: '+21622123456' }]);
    expect(plan.conflicts).toEqual([{ phoneKey: '+21622123456', keep: 3, others: [4, 2, 1] }]);
  });

  it('a number somebody proved with a code stays with them, even against an older real account', () => {
    const plan = planPhoneKeys([row(1, '22 123 456'), row(7, '22123456', { phoneVerifiedAt: new Date() })]);

    expect(plan.assign).toEqual([{ id: 7, phoneKey: '+21622123456' }]);
    expect(plan.conflicts).toEqual([{ phoneKey: '+21622123456', keep: 7, others: [1] }]);
  });

  it('a deleted account takes no key and gives up one it holds, so the number is free for a live account', () => {
    const gone = { isActive: false, deletedAt: new Date() };
    const plan = planPhoneKeys([
      row(1, '22 123 456', gone),
      row(2, '98 765 432', { ...gone, phoneKey: '+21698765432' }),
      row(3, '98765432'),
    ]);

    expect(plan.assign).toEqual([{ id: 3, phoneKey: '+21698765432' }]);
    expect(plan.release).toEqual([2]);
    expect(plan.conflicts).toEqual([]);
  });

  it('a guest loses to a real account even when older; two guests: the older keeps it', () => {
    expect(planPhoneKeys([row(1, '22123456', { isGuest: true }), row(2, '22123456')]).assign).toEqual([{ id: 2, phoneKey: '+21622123456' }]);
    expect(planPhoneKeys([row(5, '22123456', { isGuest: true }), row(3, '22123456', { isGuest: true })]).assign).toEqual([{ id: 3, phoneKey: '+21622123456' }]);
  });

  it('an account that already has the key keeps it; late arrivals are conflicts', () => {
    const plan = planPhoneKeys([row(1, '22 123 456', { phoneKey: '+21622123456' }), row(2, '22123456')]);

    expect(plan.assign).toEqual([]);
    expect(plan.conflicts).toEqual([{ phoneKey: '+21622123456', keep: 1, others: [2] }]);
  });

  it('running it again changes nothing', () => {
    const first = planPhoneKeys([row(1, '22123456'), row(2, '22 123 456')]);
    const applied = [row(1, '22123456', { phoneKey: '+21622123456' }), row(2, '22 123 456')];
    const second = planPhoneKeys(applied);

    expect(first.assign).toEqual([{ id: 1, phoneKey: '+21622123456' }]);
    expect(second.assign).toEqual([]);
    expect(second.conflicts).toEqual([{ phoneKey: '+21622123456', keep: 1, others: [2] }]);
  });

  it('what is not a phone number is reported and left alone', () => {
    const plan = planPhoneKeys([row(1, 'abc'), row(2, '12')]);

    expect(plan.assign).toEqual([]);
    expect(plan.invalid).toEqual([{ id: 1, phone: 'abc' }, { id: 2, phone: '12' }]);
  });
});
