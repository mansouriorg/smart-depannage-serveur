/**
 * A stand-in for the catalog tables, for the specs of the routes that check a request against it
 * (P1-10). Test support only: nothing in the application imports it.
 */
export interface FakeSubService {
  id: number;
  name: string;
  isActive: boolean;
  requiresPhotos: boolean;
  category: { name: string; serviceType: string; isActive: boolean };
}

const plumbing = { name: 'Plomberie', serviceType: 'PLOMBIER', isActive: true };

export const CATALOG_ROWS: Record<string, FakeSubService> = {
  leak: { id: 1, name: 'Fuite d’eau', isActive: true, requiresPhotos: true, category: plumbing },
  tap: { id: 2, name: 'Remplacement robinet', isActive: true, requiresPhotos: false, category: plumbing },
  retired: { id: 3, name: 'Ancien service', isActive: false, requiresPhotos: false, category: plumbing },
  lock: {
    id: 4,
    name: 'Remplacement de serrure',
    isActive: true,
    requiresPhotos: true,
    category: { name: 'Serrurerie', serviceType: 'SERRURIER', isActive: true },
  },
  coldCategory: {
    id: 5,
    name: 'Climatiseur en panne',
    isActive: true,
    requiresPhotos: false,
    category: { name: 'Climatisation', serviceType: 'CLIMATICIEN', isActive: false },
  },
};

/** The part of `prisma.subService` the check uses; `calls` lists the ids it was asked for. */
export function fakeSubServices(rows: FakeSubService[] = Object.values(CATALOG_ROWS)) {
  const calls: number[] = [];

  return {
    calls,
    findUnique: async ({ where }: { where: { id: number } }) => {
      calls.push(where.id);

      return rows.find((row) => row.id === where.id) ?? null;
    },
  };
}
