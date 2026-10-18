import { FakeTable } from '../../common/testing/fake-tables';
import { ArtisansService } from './artisans.service';

/**
 * P1-11: a zone an artisan adds to their own profile is either one of the platform's list or a
 * circle with a centre. A name alone used to be taken, and it could never be checked against a
 * job (the matching used to refuse every job to such an artisan).
 */
function makeWorld() {
  const platform = new FakeTable();
  const zones = new FakeTable({ defaults: () => ({ radiusKm: 10 }) });

  platform.insert({ name: 'Tunis', city: 'Tunis', postalCode: '1000', latitude: 36.8, longitude: 10.2, radiusKm: 20, isActive: true });
  platform.insert({ name: 'Off', city: null, latitude: 35, longitude: 10, radiusKm: 10, isActive: false });

  const prisma: any = { adminServiceZone: platform, artisanServiceZone: zones };
  const service = new ArtisansService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any);

  (service as any).getArtisanProfileByUserId = async () => ({
    id: 7,
    userId: 4,
    serviceZones: zones.rows.filter((zone) => zone.artisanProfileId === 7),
  });

  return { service, zones };
}

async function failure(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('expected a failure');
}

describe('the zones an artisan adds to their own profile (P1-11)', () => {
  it('a zone of the platform\'s list: its centre and radius are copied, the link is kept', async () => {
    const w = makeWorld();

    await w.service.addServiceZone(4, { zoneId: 1 } as any);

    expect(w.zones.rows).toHaveLength(1);
    expect(w.zones.rows[0]).toMatchObject({ artisanProfileId: 7, label: 'Tunis', city: 'Tunis', postalCode: '1000', latitude: 36.8, longitude: 10.2, radiusKm: 20, adminZoneId: 1, isActive: true });
  });

  it('the same zone twice is refused, naming it', async () => {
    const w = makeWorld();

    await w.service.addServiceZone(4, { zoneId: 1 } as any);

    const error = await failure(w.service.addServiceZone(4, { zoneId: 1 } as any));

    expect(error.getStatus()).toBe(400);
    expect(error.message).toContain('Tunis');
    expect(w.zones.rows).toHaveLength(1);
  });

  it('a zone that does not exist or is switched off is a 400', async () => {
    const w = makeWorld();

    expect((await failure(w.service.addServiceZone(4, { zoneId: 99 } as any))).getStatus()).toBe(400);
    expect((await failure(w.service.addServiceZone(4, { zoneId: 2 } as any))).getStatus()).toBe(400);
    expect(w.zones.rows).toHaveLength(0);
  });

  it('a circle of their own needs a centre; its radius is 10 km when not given', async () => {
    const w = makeWorld();

    await w.service.addServiceZone(4, { label: 'Mon quartier', latitude: 36.85, longitude: 10.3 } as any);

    expect(w.zones.rows[0]).toMatchObject({ label: 'Mon quartier', latitude: 36.85, longitude: 10.3, radiusKm: 10, isActive: true });
    expect(w.zones.rows[0].adminZoneId).toBeUndefined();
  });

  it('a name alone, or a latitude without a longitude, is refused: it could never be checked against a job', async () => {
    const w = makeWorld();

    for (const dto of [{ label: 'Tunis' }, { city: 'Sfax', radiusKm: 15 }, { latitude: 36.8 }, { longitude: 10.2 }, {}]) {
      const error = await failure(w.service.addServiceZone(4, dto as any));

      expect(error.getStatus()).toBe(400);
      expect(error.message).toContain('Choisissez une zone de la liste');
    }

    expect(w.zones.rows).toHaveLength(0);
  });
});

describe('taking a zone away (P1-11 review)', () => {
  const circle = (extra: Record<string, unknown> = {}) => ({ artisanProfileId: 7, label: 'Z', latitude: 36.8, longitude: 10.2, radiusKm: 20, isActive: true, ...extra });

  it('one of several zones can be removed', async () => {
    const w = makeWorld();
    const a = w.zones.insert(circle());
    const b = w.zones.insert(circle({ label: 'Y', latitude: 35.8 }));

    await w.service.removeServiceZone(4, a.id);

    expect(w.zones.rows.map((zone) => zone.id)).toEqual([b.id]);
  });

  it('the last zone that can be drawn cannot: with none, every job of the trades would be shown', async () => {
    const w = makeWorld();
    const only = w.zones.insert(circle());

    const error = await failure(w.service.removeServiceZone(4, only.id));

    expect(error.getStatus()).toBe(400);
    expect(error.message).toContain('au moins une zone');
    expect(w.zones.rows).toHaveLength(1);
  });

  it('a zone that is switched off or has no centre does not count as one that is kept', async () => {
    const w = makeWorld();
    const live = w.zones.insert(circle());

    w.zones.insert(circle({ label: 'Off', isActive: false }));
    w.zones.insert(circle({ label: 'Name only', latitude: null, longitude: null }));

    expect((await failure(w.service.removeServiceZone(4, live.id))).getStatus()).toBe(400);
    expect(w.zones.rows).toHaveLength(3);
  });

  it('a zone that cannot be drawn can always be removed, and so can the last one of an artisan who had none that can', async () => {
    const w = makeWorld();
    const off = w.zones.insert(circle({ isActive: false }));
    const nameOnly = w.zones.insert(circle({ latitude: null, longitude: null }));

    await w.service.removeServiceZone(4, off.id);
    await w.service.removeServiceZone(4, nameOnly.id);

    expect(w.zones.rows).toEqual([]);
  });

  it('another artisan\'s zone is a 404', async () => {
    const w = makeWorld();
    const foreign = w.zones.insert(circle({ artisanProfileId: 8 }));

    expect((await failure(w.service.removeServiceZone(4, foreign.id))).getStatus()).toBe(404);
    expect(w.zones.rows).toHaveLength(1);
  });
});
