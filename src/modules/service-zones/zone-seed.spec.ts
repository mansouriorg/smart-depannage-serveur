import { FakeTable } from '../../common/testing/fake-tables';
import { GOVERNORATES } from './governorates';
import { seedServiceZones } from './zone-seed';

const world = () => {
  const adminServiceZone = new FakeTable();

  return { adminServiceZone, db: { adminServiceZone } };
};

const list = [
  { name: 'Tunis', city: 'Tunis', latitude: 36.8, longitude: 10.2, radiusKm: 20 },
  { name: 'Sfax', city: 'Sfax', latitude: 34.7, longitude: 10.8, radiusKm: 30 },
];

describe('the seed of the platform zones (P1-11)', () => {
  it('creates every zone of the list on an empty table, switched on, with its centre and radius', async () => {
    const { db, adminServiceZone } = world();

    const report = await seedServiceZones(db, list);

    expect(report).toEqual({ created: ['Tunis', 'Sfax'], kept: [], filled: [] });
    expect(adminServiceZone.rows.map((row) => [row.name, row.city, row.latitude, row.longitude, row.radiusKm, row.isActive])).toEqual([
      ['Tunis', 'Tunis', 36.8, 10.2, 20, true],
      ['Sfax', 'Sfax', 34.7, 10.8, 30, true],
    ]);
  });

  it('a zone that is already there is left exactly as the back office made it', async () => {
    const { db, adminServiceZone } = world();

    adminServiceZone.insert({ name: 'Tunis', city: 'Grand Tunis', latitude: 36.9, longitude: 10.3, radiusKm: 45, isActive: false });

    const report = await seedServiceZones(db, list);

    expect(report).toEqual({ created: ['Sfax'], kept: ['Tunis'], filled: [] });
    expect(adminServiceZone.rows.find((row) => row.name === 'Tunis')).toMatchObject({
      city: 'Grand Tunis',
      latitude: 36.9,
      longitude: 10.3,
      radiusKm: 45,
      isActive: false,
    });
  });

  it('the name is compared without the case: "sfax" typed by hand is the same zone', async () => {
    const { db, adminServiceZone } = world();

    adminServiceZone.insert({ name: 'sfax', city: 'Sfax', latitude: 34.6, longitude: 10.7, radiusKm: 10, isActive: true });

    const report = await seedServiceZones(db, list);

    expect(report.kept).toEqual(['Sfax']);
    expect(adminServiceZone.rows).toHaveLength(2);
  });

  it('a zone made by name alone (no centre) gets the list\'s centre and nothing else changes', async () => {
    const { db, adminServiceZone } = world();

    adminServiceZone.insert({ name: 'sfax', city: 'Sfax-ville', latitude: null, longitude: null, radiusKm: 12, isActive: false });
    adminServiceZone.insert({ name: 'Tunis', city: null, latitude: 36.9, longitude: null, radiusKm: 15, isActive: true });

    const report = await seedServiceZones(db, list);

    expect(report).toEqual({ created: [], kept: [], filled: ['Tunis', 'Sfax'] });
    expect(adminServiceZone.rows.find((row) => row.name === 'sfax')).toMatchObject({
      name: 'sfax',
      city: 'Sfax-ville',
      latitude: 34.7,
      longitude: 10.8,
      radiusKm: 12,
      isActive: false,
    });
    // half a centre is not a centre: both are taken from the list
    expect(adminServiceZone.rows.find((row) => row.name === 'Tunis')).toMatchObject({ latitude: 36.8, longitude: 10.2, radiusKm: 15 });
  });

  it('a zone that was filled is kept the second time', async () => {
    const { db, adminServiceZone } = world();

    adminServiceZone.insert({ name: 'Sfax', latitude: null, longitude: null, radiusKm: 10, isActive: true });

    await seedServiceZones(db, list);
    const again = await seedServiceZones(db, list);

    expect(again).toEqual({ created: [], kept: ['Tunis', 'Sfax'], filled: [] });
  });

  it('running it twice creates nothing the second time', async () => {
    const { db, adminServiceZone } = world();

    await seedServiceZones(db, GOVERNORATES);
    const again = await seedServiceZones(db, GOVERNORATES);

    expect(again.created).toEqual([]);
    expect(again.kept).toHaveLength(24);
    expect(adminServiceZone.rows).toHaveLength(24);
  });
});
