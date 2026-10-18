import { FakeTable } from '../../common/testing/fake-tables';
import { artisanZoneRowsFor } from './zone-pick';

const world = () => {
  const adminServiceZone = new FakeTable();

  adminServiceZone.insert({ name: 'Tunis', city: 'Tunis', postalCode: '1000', latitude: 36.8, longitude: 10.2, radiusKm: 20, isActive: true });
  adminServiceZone.insert({ name: 'Sfax', city: 'Sfax', postalCode: null, latitude: 34.7, longitude: 10.8, radiusKm: 30, isActive: true });
  adminServiceZone.insert({ name: 'Off', city: null, latitude: 35, longitude: 10, radiusKm: 10, isActive: false });
  adminServiceZone.insert({ name: 'Typed', city: null, latitude: null, longitude: null, radiusKm: 10, isActive: true });

  return { adminServiceZone, db: { adminServiceZone } };
};

async function failure(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('expected a failure');
}

describe('the zones an artisan picks from the platform list (P1-11)', () => {
  it('copies the centre and the radius, and keeps the link with the zone it was taken from', async () => {
    const { db } = world();

    expect(await artisanZoneRowsFor(db, [1, 2])).toEqual([
      { label: 'Tunis', city: 'Tunis', postalCode: '1000', latitude: 36.8, longitude: 10.2, radiusKm: 20, adminZoneId: 1, isActive: true },
      { label: 'Sfax', city: 'Sfax', postalCode: null, latitude: 34.7, longitude: 10.8, radiusKm: 30, adminZoneId: 2, isActive: true },
    ]);
  });

  it('the label is the name of the zone, not its city', async () => {
    const { db, adminServiceZone } = world();

    adminServiceZone.insert({ name: 'Grand Tunis', city: 'Tunis', postalCode: null, latitude: 36.8, longitude: 10.2, radiusKm: 25, isActive: true });

    const [row] = await artisanZoneRowsFor(db, [5]);

    expect(row.label).toBe('Grand Tunis');
    expect(row.city).toBe('Tunis');
  });

  it('a zone picked twice is one zone, and the order asked for is kept', async () => {
    const { db } = world();

    const rows = await artisanZoneRowsFor(db, [2, 1, 2]);

    expect(rows.map((row) => row.adminZoneId)).toEqual([2, 1]);
  });

  it('no zone picked gives no row (the caller decides whether that is allowed)', async () => {
    const { db } = world();

    expect(await artisanZoneRowsFor(db, [])).toEqual([]);
  });

  it('a zone that does not exist is a 400 that names its number', async () => {
    const { db } = world();

    const error = await failure(artisanZoneRowsFor(db, [1, 99]));

    expect(error.getStatus()).toBe(400);
    expect(error.message).toContain('99');
  });

  it('a zone that is switched off is a 400', async () => {
    const { db } = world();

    const error = await failure(artisanZoneRowsFor(db, [3]));

    expect(error.getStatus()).toBe(400);
    expect(error.message).toContain('Off');
  });

  it('a zone with no centre is a 400: it would leave the artisan believing they cover a zone nobody checks', async () => {
    const { db } = world();

    const error = await failure(artisanZoneRowsFor(db, [4]));

    expect(error.getStatus()).toBe(400);
    expect(error.message).toContain('Typed');
  });

  it('one bad zone refuses the whole list', async () => {
    const { db } = world();

    expect((await failure(artisanZoneRowsFor(db, [1, 3]))).getStatus()).toBe(400);
  });
});
