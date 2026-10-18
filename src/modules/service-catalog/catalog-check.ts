import { BadRequestException } from '@nestjs/common';

import { TRADES, isTradeCode } from '../../common/trades/trades';

/**
 * What a request for a job may say about the catalog (P1-10).
 *
 * The request form lets a customer pick a service type and then a sub-service of the catalog
 * ("Fuite d'eau", "Remplacement de serrure"). The server took both as they came: a sub-service
 * that does not exist failed later as a database error, and one that was switched off or that
 * belongs to another trade was saved.
 *
 * Photos are not refused here. A picture can only be uploaded once the request exists (the upload
 * route needs its id; a visitor's pictures come on the tracking link), so refusing a request for
 * lacking them could never be satisfied honestly: every booking would fail, or the caller would
 * invent a link. The answer says that photos are expected (`photosRequired`) and the pictures
 * follow through the upload routes.
 *
 * Only the part of the database client used here is described, so the check runs on a stand-in
 * in the unit tests and is called from the two routes that create a request with a sub-service,
 * and from the update of a request that has one.
 */
export interface CatalogSubService {
  id: number;
  name: string;
  isActive: boolean;
  requiresPhotos: boolean;
  category: { name: string; serviceType: string; isActive: boolean };
}

/** The part of the database client this check uses. */
type CatalogTables = {
  subService: { findUnique: (args: any) => Promise<CatalogSubService | null> };
};

/**
 * The database client or a transaction of it. Typed loosely on purpose, like the other helpers
 * that take one: it is the generated client in the application and a stand-in in the tests.
 */
export type CatalogDb = object;

export interface RequestedService {
  serviceType: string;
  subServiceId?: number | null;
}

export interface CheckedService {
  /** The sub-service picked, or null when the request names none. */
  subServiceId: number | null;
  /** True when the picked sub-service asks for photos of the problem. */
  photosRequired: boolean;
}

const labelOf = (serviceType: string) => (isTradeCode(serviceType) ? TRADES[serviceType].label : serviceType);

/**
 * Refuses (400) a request whose sub-service does not exist, is switched off, belongs to a
 * category that is switched off, or belongs to another trade than the one requested. Otherwise
 * says which sub-service it is and whether it expects photos of the problem.
 */
export async function checkRequestedService(
  db: CatalogDb,
  request: RequestedService,
): Promise<CheckedService> {
  if (request.subServiceId === undefined || request.subServiceId === null) {
    return { subServiceId: null, photosRequired: false };
  }

  const subService = await (db as CatalogTables).subService.findUnique({
    where: { id: request.subServiceId },
    select: {
      id: true,
      name: true,
      isActive: true,
      requiresPhotos: true,
      category: { select: { name: true, serviceType: true, isActive: true } },
    },
  });

  if (!subService) {
    throw new BadRequestException("Ce service n'existe pas dans le catalogue.");
  }

  if (!subService.isActive || !subService.category.isActive) {
    throw new BadRequestException(`Le service « ${subService.name} » n'est plus proposé.`);
  }

  if (subService.category.serviceType !== request.serviceType) {
    throw new BadRequestException(
      `Le service « ${subService.name} » relève de « ${subService.category.name} », ` +
        `pas du type de service demandé (${labelOf(request.serviceType)}).`,
    );
  }

  return { subServiceId: subService.id, photosRequired: subService.requiresPhotos };
}
