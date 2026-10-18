import * as fs from 'fs';
import * as path from 'path';

import { FakeTable } from '../../common/testing/fake-tables';
import { SeedCategory, seedCatalog } from './catalog-seed';

const world = () => {
  const serviceCategory = new FakeTable({ unique: ['serviceType'] });
  const subService = new FakeTable();

  return { serviceCategory, subService, db: { serviceCategory, subService } };
};

const listed = (): SeedCategory[] => [
  {
    serviceType: 'PLOMBIER',
    name: 'Plomberie',
    description: 'List description',
    subServices: [
      { name: 'Fuite', description: 'List text', estimatedDuration: 60, basePrice: 89, emergencyPrice: 139, requiresPhotos: true },
      { name: 'Robinet', description: 'List text', estimatedDuration: 60, basePrice: 99, emergencyPrice: 149, requiresPhotos: false },
    ],
  },
  {
    serviceType: 'CLIMATICIEN',
    name: 'Climatisation',
    description: 'List description',
    subServices: [
      { name: 'Climatiseur en panne', description: 'List text', estimatedDuration: 90, basePrice: null, emergencyPrice: null, requiresPhotos: true },
    ],
  },
];

describe('the service catalog seed (P1-10)', () => {
  it('fills an empty catalog from the list', async () => {
    const w = world();

    const report = await seedCatalog(w.db, listed(), { missingOnly: false });

    expect(report).toEqual({ categoriesCreated: 2, subServicesCreated: 3, subServicesUpdated: 0 });
    expect(w.serviceCategory.rows.map((row) => row.serviceType)).toEqual(['PLOMBIER', 'CLIMATICIEN']);
    expect(w.subService.rows.map((row) => row.categoryId)).toEqual([1, 1, 2]);
  });

  it('a service "sur devis" has no price, not a price of zero', async () => {
    const w = world();

    await seedCatalog(w.db, listed(), { missingOnly: false });

    const quote = w.subService.rows.find((row) => row.name === 'Climatiseur en panne')!;

    expect(quote.basePrice ?? null).toBe(null);
    expect(quote.emergencyPrice ?? null).toBe(null);
    expect(quote.requiresPhotos).toBe(true);
  });

  it('the full seed, as it always was, brings the existing ones back to the list (prices included)', async () => {
    const w = world();
    await seedCatalog(w.db, listed(), { missingOnly: false });
    w.subService.rows[0].basePrice = 120; // the back office changed it
    w.serviceCategory.rows[0].name = 'Plomberie générale';

    const report = await seedCatalog(w.db, listed(), { missingOnly: false });

    expect(report).toEqual({ categoriesCreated: 0, subServicesCreated: 0, subServicesUpdated: 3 });
    expect(w.subService.rows[0].basePrice).toBe(89);
    expect(w.serviceCategory.rows[0].name).toBe('Plomberie');
  });

  it('the full seed also switches back on a service the back office switched off, which is why the deploy uses --missing-only', async () => {
    const w = world();
    await seedCatalog(w.db, listed(), { missingOnly: false });
    w.subService.rows[0].isActive = false;

    await seedCatalog(w.db, listed(), { missingOnly: false });
    expect(w.subService.rows[0].isActive).toBe(true);

    w.subService.rows[0].isActive = false;
    await seedCatalog(w.db, listed(), { missingOnly: true });
    expect(w.subService.rows[0].isActive).toBe(false);
  });

  it('a price typed in for a service "sur devis" is not written over by the full seed', async () => {
    const w = world();
    await seedCatalog(w.db, listed(), { missingOnly: false });
    const quote = w.subService.rows.find((row) => row.name === 'Climatiseur en panne')!;
    quote.basePrice = 180;
    quote.emergencyPrice = 240;

    await seedCatalog(w.db, listed(), { missingOnly: false });

    expect(quote.basePrice).toBe(180);
    expect(quote.emergencyPrice).toBe(240);
  });

  it('--missing-only adds what does not exist and touches nothing else', async () => {
    const w = world();
    // a live catalog: plumbing exists, with a price and a name the back office changed, and a service switched off
    const plumbing = w.serviceCategory.insert({ serviceType: 'PLOMBIER', name: 'Plomberie & sanitaire', description: 'Mine', isActive: true });
    w.subService.insert({ categoryId: plumbing.id, name: 'Fuite', description: 'Mine', estimatedDuration: 30, basePrice: 150, emergencyPrice: 200, requiresPhotos: false, isActive: false });

    const report = await seedCatalog(w.db, listed(), { missingOnly: true });

    expect(report).toEqual({ categoriesCreated: 1, subServicesCreated: 2, subServicesUpdated: 0 });

    const fuite = w.subService.rows.find((row) => row.name === 'Fuite')!;

    expect(fuite.basePrice).toBe(150);
    expect(fuite.description).toBe('Mine');
    expect(fuite.isActive).toBe(false);
    expect(w.serviceCategory.rows[0].name).toBe('Plomberie & sanitaire');
    // the missing service of an existing category and the whole new category are there
    expect(w.subService.rows.map((row) => row.name).sort()).toEqual(['Climatiseur en panne', 'Fuite', 'Robinet']);
    expect(w.serviceCategory.rows.map((row) => row.serviceType)).toEqual(['PLOMBIER', 'CLIMATICIEN']);
  });

  it('--missing-only can be run again: the second run creates nothing', async () => {
    const w = world();

    await seedCatalog(w.db, listed(), { missingOnly: true });
    const again = await seedCatalog(w.db, listed(), { missingOnly: true });

    expect(again).toEqual({ categoriesCreated: 0, subServicesCreated: 0, subServicesUpdated: 0 });
    expect(w.subService.rows.length).toBe(3);
  });

  it('the seed script reads the flag and hands the work to this module', () => {
    const script = fs.readFileSync(path.resolve(__dirname, '../../../prisma/seed-service-catalog.ts'), 'utf8');

    expect(script).toContain("process.argv.includes('--missing-only')");
    expect(script).toContain('seedCatalog(prisma, catalog');
  });
});
