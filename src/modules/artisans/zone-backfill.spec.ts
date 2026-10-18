import { FakeTable } from '../../common/testing/fake-tables';
import { backfillZones, zoneWord } from './zone-backfill';

function makeWorld() {
  const platform = new FakeTable();
  const zones = new FakeTable({ defaults: () => ({ radiusKm: 10, adminZoneId: null, latitude: null, longitude: null }) });

  platform.insert({ name: 'Tunis', city: 'Tunis', latitude: 36.8, longitude: 10.2, radiusKm: 20, isActive: true });
  platform.insert({ name: 'Béja', city: 'Béja', latitude: 36.7, longitude: 9.2, radiusKm: 30, isActive: true });
  platform.insert({ name: 'Sfax', city: 'Sfax', latitude: 34.7, longitude: 10.8, radiusKm: 30, isActive: true });
  platform.insert({ name: 'Off', city: 'Off', latitude: 35, longitude: 10, radiusKm: 30, isActive: false });
  platform.insert({ name: 'Typed', city: 'Typed', latitude: null, longitude: null, radiusKm: 30, isActive: true });

  return { platform, zones, db: { adminServiceZone: platform, artisanServiceZone: zones } };
}

describe('reading a place name (P1-11)', () => {
  it('the case, the accents and the punctuation do not matter', () => {
    expect(zoneWord('Béja')).toBe('beja');
    expect(zoneWord('  BEJA. ')).toBe('beja');
    expect(zoneWord('Ben-Arous')).toBe('ben arous');
    expect(zoneWord("Sidi  Bouzid")).toBe('sidi bouzid');
    expect(zoneWord(null)).toBe('');
  });
});

describe('giving a centre to the zones artisans typed as a name (P1-11)', () => {
  it('a dry run lists what it would fill and writes nothing', async () => {
    const w = makeWorld();

    w.zones.insert({ artisanProfileId: 5, label: 'Tunis', city: null });

    const report = await backfillZones(w.db, { apply: false });

    expect(report.withoutCentre).toBe(1);
    expect(report.changes).toEqual([
      { zoneId: 1, profileId: 5, before: { label: 'Tunis', city: null, latitude: null, longitude: null, radiusKm: 10, adminZoneId: null }, platformZoneId: 1, platformZoneName: 'Tunis' },
    ]);
    expect(w.zones.rows[0].latitude).toBeNull();
  });

  it('fills the centre and the radius from the platform zone the label or the city names, and links it', async () => {
    const w = makeWorld();

    w.zones.insert({ artisanProfileId: 5, label: 'beja', city: null });
    w.zones.insert({ artisanProfileId: 6, label: 'Centre ville', city: 'SFAX' });

    const report = await backfillZones(w.db, { apply: true });

    expect(report.written).toEqual([1, 2]);
    expect(w.zones.rows[0]).toMatchObject({ latitude: 36.7, longitude: 9.2, radiusKm: 30, adminZoneId: 2 });
    expect(w.zones.rows[1]).toMatchObject({ latitude: 34.7, longitude: 10.8, radiusKm: 30, adminZoneId: 3 });
    // the words the artisan typed stay
    expect(w.zones.rows[0].label).toBe('beja');
    expect(w.zones.rows[1].label).toBe('Centre ville');
  });

  it('a zone that already has a centre is never touched', async () => {
    const w = makeWorld();

    w.zones.insert({ artisanProfileId: 5, label: 'Tunis', latitude: 36.9, longitude: 10.3, radiusKm: 4 });

    const report = await backfillZones(w.db, { apply: true });

    expect(report.withoutCentre).toBe(0);
    expect(w.zones.rows[0]).toMatchObject({ latitude: 36.9, longitude: 10.3, radiusKm: 4, adminZoneId: null });
  });

  it('a name that is no platform zone (a quarter) is listed with the words typed and left as it is', async () => {
    const w = makeWorld();

    w.zones.insert({ artisanProfileId: 5, label: 'Cité Ennasr', city: 'Ariana' });
    w.zones.insert({ artisanProfileId: 5, label: null, city: null });

    const report = await backfillZones(w.db, { apply: true });

    expect(report.changes).toEqual([]);
    expect(report.unmatched).toEqual([
      { zoneId: 1, words: ['Cité Ennasr', 'Ariana'] },
      { zoneId: 2, words: [] },
    ]);
    expect(w.zones.rows.every((zone) => zone.latitude === null)).toBe(true);
  });

  it('a zone that names two platform zones is listed and left as it is', async () => {
    const w = makeWorld();

    w.zones.insert({ artisanProfileId: 5, label: 'Tunis', city: 'Sfax' });

    const report = await backfillZones(w.db, { apply: true });

    expect(report.ambiguous).toEqual([{ zoneId: 1, words: ['Tunis', 'Sfax'], candidates: ['Tunis', 'Sfax'] }]);
    expect(w.zones.rows[0].latitude).toBeNull();
  });

  it('a label and a city that name the same platform zone are not ambiguous', async () => {
    const w = makeWorld();

    w.zones.insert({ artisanProfileId: 5, label: 'Tunis', city: 'tunis' });

    const report = await backfillZones(w.db, { apply: true });

    expect(report.changes).toHaveLength(1);
    expect(report.ambiguous).toEqual([]);
  });

  it('a platform zone that is switched off or has no centre is not a target', async () => {
    const w = makeWorld();

    w.zones.insert({ artisanProfileId: 5, label: 'Off' });
    w.zones.insert({ artisanProfileId: 5, label: 'Typed' });

    const report = await backfillZones(w.db, { apply: true });

    expect(report.changes).toEqual([]);
    expect(report.unmatched.map((item) => item.zoneId)).toEqual([1, 2]);
  });

  it('the old values are handed over before the first write, and a backup that fails stops the run', async () => {
    const w = makeWorld();

    w.zones.insert({ artisanProfileId: 5, label: 'Tunis' });

    let handed: any[] = [];
    let seenAtBackup: any = 'never';

    await backfillZones(w.db, {
      apply: true,
      beforeWrite: (changes) => {
        handed = changes;
        seenAtBackup = w.zones.rows[0].latitude;
      },
    });

    expect(handed.map((change) => change.before.label)).toEqual(['Tunis']);
    expect(seenAtBackup).toBeNull();
    expect(w.zones.rows[0].latitude).toBe(36.8);

    const other = makeWorld();

    other.zones.insert({ artisanProfileId: 5, label: 'Tunis' });

    await expect(
      backfillZones(other.db, {
        apply: true,
        beforeWrite: () => {
          throw new Error('disk full');
        },
      }),
    ).rejects.toThrow('disk full');
    expect(other.zones.rows[0].latitude).toBeNull();
  });

  it('a dry run does not ask for a backup, and neither does a run with nothing to change', async () => {
    const w = makeWorld();
    let asked = 0;

    w.zones.insert({ artisanProfileId: 5, label: 'Tunis' });
    await backfillZones(w.db, { apply: false, beforeWrite: () => void asked++ });

    const empty = makeWorld();

    await backfillZones(empty.db, { apply: true, beforeWrite: () => void asked++ });

    expect(asked).toBe(0);
  });

  it('a zone to which the artisan gave a centre while the script ran keeps it', async () => {
    const w = makeWorld();

    w.zones.insert({ artisanProfileId: 5, label: 'Tunis' });

    const realFind = w.zones.findMany;

    w.zones.findMany = async (args: any) => {
      const found = await realFind(args);

      w.zones.rows[0].latitude = 36.95;
      w.zones.rows[0].longitude = 10.35;

      return found;
    };

    const report = await backfillZones(w.db, { apply: true });

    expect(report.raced).toEqual([1]);
    expect(report.written).toEqual([]);
    expect(w.zones.rows[0]).toMatchObject({ latitude: 36.95, longitude: 10.35 });
  });

  it('running it twice changes nothing the second time', async () => {
    const w = makeWorld();

    w.zones.insert({ artisanProfileId: 5, label: 'Tunis' });
    await backfillZones(w.db, { apply: true });

    const again = await backfillZones(w.db, { apply: true });

    expect(again.withoutCentre).toBe(0);
    expect(again.changes).toEqual([]);
  });
});
