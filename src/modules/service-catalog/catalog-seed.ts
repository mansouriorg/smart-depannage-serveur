/**
 * Writes the service catalog list (prisma/seed-service-catalog.ts) into the database.
 *
 * Two ways, and the difference matters on a database that is already in use (P1-10):
 *  - the default is the seed as it always was: every category and sub-service of the list is created
 *    or brought back to the list, descriptions and prices included. It would undo a price the back
 *    office has changed since;
 *  - `missingOnly` creates the categories and sub-services that do not exist yet and touches nothing
 *    else. This is how the three trades added in P1-10 (heating, glazing, air conditioning) are put
 *    into a catalog that is already live.
 */
export type SeedSubService = {
  name: string;
  description: string;
  estimatedDuration: number;
  // null = "sur devis": the price is set by the quote. The three categories added in P1-10 have no list price yet.
  basePrice: number | null;
  emergencyPrice: number | null;
  requiresPhotos: boolean;
  isActive?: boolean;
};

export type SeedCategory = {
  serviceType: string;
  name: string;
  description: string;
  subServices: SeedSubService[];
};

export type SeedReport = {
  categoriesCreated: number;
  subServicesCreated: number;
  subServicesUpdated: number;
};

type CatalogTables = {
  serviceCategory: {
    findUnique: (args: any) => Promise<any>;
    upsert: (args: any) => Promise<any>;
  };
  subService: {
    findFirst: (args: any) => Promise<any>;
    create: (args: any) => Promise<any>;
    update: (args: any) => Promise<any>;
  };
};

/** The database client, or a stand-in in the tests. */
export type SeedDb = object;

export async function seedCatalog(
  database: SeedDb,
  catalog: SeedCategory[],
  options: { missingOnly: boolean },
): Promise<SeedReport> {
  const db = database as CatalogTables;
  const report: SeedReport = { categoriesCreated: 0, subServicesCreated: 0, subServicesUpdated: 0 };

  for (const categoryData of catalog) {
    const known = await db.serviceCategory.findUnique({ where: { serviceType: categoryData.serviceType } });

    // A category that exists is left as it is; only what is missing under it is created.
    const category =
      known && options.missingOnly
        ? known
        : await db.serviceCategory.upsert({
            where: { serviceType: categoryData.serviceType },
            update: {
              name: categoryData.name,
              description: categoryData.description,
              isActive: true,
            },
            create: {
              serviceType: categoryData.serviceType,
              name: categoryData.name,
              description: categoryData.description,
              isActive: true,
            },
          });

    if (!known) report.categoriesCreated++;

    for (const subServiceData of categoryData.subServices) {
      const existingSubService = await db.subService.findFirst({
        where: { categoryId: category.id, name: subServiceData.name },
      });

      // A null price is "sur devis": it is never written over a price typed in since (undefined = untouched).
      const data = {
        description: subServiceData.description,
        estimatedDuration: subServiceData.estimatedDuration,
        basePrice: subServiceData.basePrice ?? undefined,
        emergencyPrice: subServiceData.emergencyPrice ?? undefined,
        requiresPhotos: subServiceData.requiresPhotos,
        isActive: subServiceData.isActive ?? true,
      };

      if (existingSubService) {
        if (options.missingOnly) continue;

        await db.subService.update({ where: { id: existingSubService.id }, data });
        report.subServicesUpdated++;
      } else {
        await db.subService.create({ data: { categoryId: category.id, name: subServiceData.name, ...data } });
        report.subServicesCreated++;
      }
    }
  }

  return report;
}
