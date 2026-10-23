import { Decimal } from './decimal-double';
import { MemoryPrisma } from './memory-prisma';
import { decimalsToNumbers } from '../money/money-numbers';

const SCHEMA = `
model Quote {
  id        Int      @id @default(autoincrement())
  title     String
  amountHT  Decimal  @db.Decimal(14, 3)
  taxRate   Decimal  @db.Decimal(5, 2) @default(19)
  paid      Decimal  @db.Decimal(14, 3) @default(0)
  refunded  Decimal? @db.Decimal(14, 3)
  ratio     Float    @default(1)
  wide      Decimal
}
`;

async function failure(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('expected a failure');
}

function world() {
  const memory = new MemoryPrisma(SCHEMA);

  return { memory, db: memory.client() };
}

describe('the test database answers Decimal columns like Prisma does (P2-01)', () => {
  it('a Decimal is exact, prints without trailing zeros, and is not a number', () => {
    const d = new Decimal('12.500');

    expect(d.toString()).toBe('12.5');
    expect(d.toFixed(3)).toBe('12.500');
    expect(d.toFixed(0)).toBe('13');
    expect(d.toNumber()).toBe(12.5);
    expect(JSON.stringify(d)).toBe('"12.5"');
    expect(String(Object.prototype.toString.call(d))).toBe('[object Decimal]');
    expect(d.constructor.name).toBe('Decimal');
    expect(typeof d).toBe('object');
    expect(`${d}`).toBe('12.5');
    expect((d as any) + 1).toBe('12.51');
    expect(new Decimal('0').toString()).toBe('0');
    expect(new Decimal('-0.0').toString()).toBe('0');
    expect(new Decimal(1e21).toString()).toBe('1000000000000000000000');
    expect(new Decimal('1e-7').toString()).toBe('0.0000001');
    expect(new Decimal(0.1 + 0.2).toString()).toBe('0.30000000000000004');
  });

  it('adds, subtracts, multiplies, divides and compares without error', () => {
    expect(new Decimal('0.1').plus('0.2').toString()).toBe('0.3');
    expect(new Decimal('10').minus(new Decimal('0.001')).toString()).toBe('9.999');
    expect(new Decimal('12.345').times(3).toString()).toBe('37.035');
    expect(new Decimal('1').dividedBy(3).toString()).toBe('0.33333333333333333333');
    expect(new Decimal('2.5').equals(2.5)).toBe(true);
    expect(new Decimal('2.5').lessThan('2.51')).toBe(true);
    expect(new Decimal('2.5').greaterThanOrEqualTo(2.5)).toBe(true);
    expect(new Decimal('-2.5').isNegative()).toBe(true);
    expect(new Decimal('-2.5').abs().toString()).toBe('2.5');
    expect(new Decimal('0.000').isZero()).toBe(true);
    expect(new Decimal('1.2345').toDecimalPlaces(3).toString()).toBe('1.235');
    expect(() => new Decimal('1').dividedBy(0)).toThrow('division by zero');
    expect(() => new Decimal('abc')).toThrow('not a decimal');
    expect(() => new Decimal(NaN)).toThrow('not a decimal');
  });

  it('a row written with a number comes back as a Decimal rounded to the scale of the column', async () => {
    const { db } = world();
    const created = await db.quote.create({ data: { title: 't', amountHT: 12.3455, wide: 1 } });

    expect(created.amountHT instanceof Decimal).toBe(true);
    expect(created.amountHT.toString()).toBe('12.346');
    expect(created.taxRate.toString()).toBe('19');
    expect(created.paid.toString()).toBe('0');
    expect(created.refunded).toBeNull();
    expect(created.ratio).toBe(1);
    expect(typeof created.ratio).toBe('number');

    const again = await db.quote.findUnique({ where: { id: created.id } });

    expect(again.amountHT instanceof Decimal).toBe(true);
    expect(again.amountHT + again.amountHT).toBe('12.34612.346');
    expect(JSON.stringify(again.amountHT)).toBe('"12.346"');
  });

  it('accepts a text and a Decimal, and refuses what is not an amount', async () => {
    const { db } = world();
    const fromText = await db.quote.create({ data: { title: 't', amountHT: '7.5', wide: '2' } });
    const fromDecimal = await db.quote.create({ data: { title: 't', amountHT: new Decimal('0.001'), wide: new Decimal('1') } });

    expect(fromText.amountHT.toString()).toBe('7.5');
    expect(fromDecimal.amountHT.toString()).toBe('0.001');
    expect((await failure(db.quote.create({ data: { title: 't', amountHT: 'abc', wide: 1 } }))).message).toContain('expects a number, a decimal text or a Decimal');
    expect((await failure(db.quote.create({ data: { title: 't', amountHT: true, wide: 1 } }))).message).toContain('expects');
    expect((await failure(db.quote.create({ data: { title: 't', amountHT: NaN, wide: 1 } }))).message).toContain('expects');
    // A Float column still wants a number.
    expect((await failure(db.quote.create({ data: { title: 't', amountHT: 1, wide: 1, ratio: '1' } }))).message).toContain('expects a number');
  });

  it('a value that does not fit the column is refused as the database refuses it', async () => {
    const { db } = world();
    const error = await failure(db.quote.create({ data: { title: 't', amountHT: 100000000000, wide: 1 } }));

    expect(error.code).toBe('P2020');
    expect((await db.quote.create({ data: { title: 't', amountHT: 99999999999.999, wide: 1 } })).amountHT.toString()).toBe('99999999999.999');
    expect((await failure(db.quote.create({ data: { title: 't', taxRate: 1000, amountHT: 1, wide: 1 } }))).code).toBe('P2020');
  });

  it('finds rows by value with numbers, texts and Decimals', async () => {
    const { db } = world();

    for (const amountHT of [1, 12.345, 12.346, 20]) await db.quote.create({ data: { title: String(amountHT), amountHT, wide: 1 } });

    const titles = async (where: any) => (await db.quote.findMany({ where, orderBy: { id: 'asc' } })).map((row: any) => row.title);

    expect(await titles({ amountHT: 12.345 })).toEqual(['12.345']);
    expect(await titles({ amountHT: '12.345' })).toEqual(['12.345']);
    expect(await titles({ amountHT: new Decimal('12.3450') })).toEqual(['12.345']);
    expect(await titles({ amountHT: { equals: 12.346 } })).toEqual(['12.346']);
    expect(await titles({ amountHT: { gt: 12.345 } })).toEqual(['12.346', '20']);
    expect(await titles({ amountHT: { gte: 12.345, lt: 20 } })).toEqual(['12.345', '12.346']);
    expect(await titles({ amountHT: { in: [1, 20] } })).toEqual(['1', '20']);
    expect(await titles({ amountHT: { not: 20 } })).toEqual(['1', '12.345', '12.346']);
    expect(await titles({ amountHT: { lte: new Decimal('1') } })).toEqual(['1']);

    const ordered = await db.quote.findMany({ orderBy: { amountHT: 'desc' } });

    expect(ordered.map((row: any) => row.title)).toEqual(['20', '12.346', '12.345', '1']);
  });

  it('sums, averages and takes the extremes exactly, as Decimals', async () => {
    const { db } = world();

    for (let at = 0; at < 3; at += 1) await db.quote.create({ data: { title: 't', amountHT: 0.1, wide: 1 } });

    await db.quote.create({ data: { title: 'u', amountHT: 12.345, wide: 1 } });

    const total = await db.quote.aggregate({ _sum: { amountHT: true, ratio: true }, _min: { amountHT: true }, _max: { amountHT: true }, _avg: { amountHT: true }, _count: { amountHT: true } });

    expect(total._sum.amountHT instanceof Decimal).toBe(true);
    expect(total._sum.amountHT.toString()).toBe('12.645');
    expect(typeof total._sum.ratio).toBe('number');
    expect(total._min.amountHT.toString()).toBe('0.1');
    expect(total._max.amountHT.toString()).toBe('12.345');
    expect(total._avg.amountHT.toString()).toBe('3.16125');
    expect(total._count.amountHT).toBe(4);

    const none = await db.quote.aggregate({ where: { title: 'zzz' }, _sum: { amountHT: true } });

    expect(none._sum.amountHT).toBeNull();

    const grouped = await db.quote.groupBy({ by: ['title'], _sum: { amountHT: true } });
    const byTitle = Object.fromEntries(grouped.map((row: any) => [row.title, row._sum.amountHT]));

    expect(byTitle.t instanceof Decimal).toBe(true);
    expect(byTitle.t.toString()).toBe('0.3');
    expect(byTitle.u.toString()).toBe('12.345');
  });

  it('increment, decrement, multiply and divide are exact and round to the scale', async () => {
    const { db } = world();
    const row = await db.quote.create({ data: { title: 't', amountHT: 10, wide: 1 } });
    const after = async (data: any) => (await db.quote.update({ where: { id: row.id }, data })).amountHT.toString();

    expect(await after({ amountHT: { increment: 0.001 } })).toBe('10.001');
    expect(await after({ amountHT: { decrement: new Decimal('0.002') } })).toBe('9.999');
    expect(await after({ amountHT: { multiply: 3 } })).toBe('29.997');
    expect(await after({ amountHT: { divide: 3 } })).toBe('9.999');
    expect(await after({ amountHT: { set: '5.5555' } })).toBe('5.556');
    expect(await after({ amountHT: 1.5 })).toBe('1.5');
  });

  it('keeps a Decimal through a transaction that is rolled back and a snapshot', async () => {
    const { memory, db } = world();
    const row = await db.quote.create({ data: { title: 't', amountHT: 3.5, wide: 1 } });
    const snapshot = memory.snapshot();

    await db.quote.update({ where: { id: row.id }, data: { amountHT: 9 } });
    memory.restore(snapshot);

    const back = await db.quote.findUnique({ where: { id: row.id } });

    expect(back.amountHT instanceof Decimal).toBe(true);
    expect(back.amountHT.toString()).toBe('3.5');
  });

  it('the real schema has Decimal columns, every one with a precision, and the double rounds them to it', async () => {
    const memory = new MemoryPrisma();
    const quote = memory.models.get('Quote')!;

    expect(quote.fields.get('amountHT')).toMatchObject({ type: 'Decimal', precision: 14, scale: 3 });
    expect(quote.fields.get('taxRate')).toMatchObject({ type: 'Decimal', precision: 5, scale: 2 });

    for (const model of memory.models.values()) {
      for (const field of model.fields.values()) {
        if (field.type === 'Decimal') expect(field.precision < 65).toBe(true);
      }
    }

    const row = memory.seed('Quote', { interventionId: 1, title: 't', amountHT: 12.345, taxAmount: 0, amountTTC: 12.345 });

    expect(row.amountHT instanceof Decimal).toBe(true);
    expect(decimalsToNumbers(row).amountHT).toBe(12.345);
    expect(decimalsToNumbers(row).taxRate).toBe(19);
    expect(decimalsToNumbers(row).currency).toBe('TND');
  });
});
