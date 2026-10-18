import { BadRequestException } from '@nestjs/common';

import { CATALOG_ROWS, fakeSubServices } from '../../common/testing/catalog';
import { CatalogDb, checkRequestedService } from './catalog-check';

const world = () => {
  const subService = fakeSubServices();

  return { subService, db: { subService } as CatalogDb };
};

async function failure(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('expected a failure');
}

describe('the sub-service of a request is checked against the catalog (P1-10)', () => {
  it('a request with no sub-service is let through and the catalog is not read', async () => {
    const w = world();

    expect(await checkRequestedService(w.db, { serviceType: 'PLOMBIER' })).toEqual({
      subServiceId: null,
      photosRequired: false,
    });
    expect(await checkRequestedService(w.db, { serviceType: 'PLOMBIER', subServiceId: null })).toEqual({
      subServiceId: null,
      photosRequired: false,
    });
    expect(w.subService.calls).toEqual([]);
  });

  it('a sub-service of the trade asked for is accepted, with its photo rule', async () => {
    const w = world();

    expect(
      await checkRequestedService(w.db, { serviceType: 'PLOMBIER', subServiceId: 2 }),
    ).toEqual({ subServiceId: 2, photosRequired: false });
    expect(
      await checkRequestedService(w.db, { serviceType: 'PLOMBIER', subServiceId: 1 }),
    ).toEqual({ subServiceId: 1, photosRequired: true });
  });

  it('a sub-service that does not exist is a 400, not a database error', async () => {
    const w = world();

    const error = await failure(checkRequestedService(w.db, { serviceType: 'PLOMBIER', subServiceId: 999 }));

    expect(error instanceof BadRequestException).toBe(true);
    expect(error.getStatus()).toBe(400);
    expect(error.message).toMatch(/n'existe pas/);
  });

  it('a sub-service of another trade is a 400 that names both', async () => {
    const w = world();

    const error = await failure(checkRequestedService(w.db, { serviceType: 'PLOMBIER', subServiceId: 4 }));

    expect(error instanceof BadRequestException).toBe(true);
    expect(error.message).toContain('Remplacement de serrure');
    expect(error.message).toContain('Serrurerie');
    expect(error.message).toContain('Plombier');
  });

  it('a mismatch is refused whatever else the request says', async () => {
    const w = world();

    const error = await failure(
      checkRequestedService(w.db, { serviceType: 'ELECTRICIEN', subServiceId: 1 }),
    );

    expect(error.getStatus()).toBe(400);
  });

  it('a sub-service that is switched off is a 400', async () => {
    const w = world();

    const error = await failure(checkRequestedService(w.db, { serviceType: 'PLOMBIER', subServiceId: 3 }));

    expect(error instanceof BadRequestException).toBe(true);
    expect(error.message).toMatch(/plus proposé/);
  });

  it('a sub-service whose category is switched off is a 400', async () => {
    const w = world();

    const error = await failure(checkRequestedService(w.db, { serviceType: 'CLIMATICIEN', subServiceId: 5 }));

    expect(error.getStatus()).toBe(400);
    expect(error.message).toMatch(/plus proposé/);
  });

  it('photos are not refused for lacking: they can only be uploaded once the request exists, and the answer says they are expected', async () => {
    const w = world();

    expect(await checkRequestedService(w.db, { serviceType: 'PLOMBIER', subServiceId: 1 })).toEqual({
      subServiceId: 1,
      photosRequired: true,
    });
    expect(await checkRequestedService(w.db, { serviceType: 'SERRURIER', subServiceId: 4 })).toEqual({
      subServiceId: 4,
      photosRequired: true,
    });
  });

  it('a mismatch is refused even when the sub-service asks for photos', async () => {
    const w = world();

    const error = await failure(checkRequestedService(w.db, { serviceType: 'PLOMBIER', subServiceId: 4 }));

    expect(error.message).toMatch(/relève de/);
    expect(CATALOG_ROWS.lock.requiresPhotos).toBe(true);
  });
});
