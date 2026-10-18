import { BadRequestException } from '@nestjs/common';

/**
 * Turns zone numbers picked from the platform's list into the rows of an artisan's own zones
 * (P1-11). The centre and the radius are copied, so changing a platform zone later does not
 * move the zones of artisans who already have it; `adminZoneId` keeps the link.
 *
 * A zone is refused if it does not exist, if it is switched off, or if it has no centre (a
 * circle needs one, and an artisan whose zones have none is not limited by them: the applicant
 * would believe they cover a zone that is not checked).
 */
export type ArtisanZoneRow = {
  label: string;
  city: string | null;
  postalCode: string | null;
  latitude: number;
  longitude: number;
  radiusKm: number;
  adminZoneId: number;
  isActive: true;
};

type ZoneTable = {
  adminServiceZone: {
    findMany: (args: any) => Promise<any[]>;
  };
};

/** The database client, or a stand-in in the tests. */
export type ZonePickDb = object;

export async function artisanZoneRowsFor(database: ZonePickDb, ids: number[]): Promise<ArtisanZoneRow[]> {
  const db = database as ZoneTable;
  const wanted = [...new Set(ids)];

  if (!wanted.length) return [];

  const found = await db.adminServiceZone.findMany({ where: { id: { in: wanted } } });
  const byId = new Map<number, any>(found.map((zone) => [zone.id, zone]));

  return wanted.map((id) => {
    const zone = byId.get(id);

    if (!zone) throw new BadRequestException(`Zone de service inconnue (${id}).`);
    if (!zone.isActive) throw new BadRequestException(`La zone « ${zone.name} » n’est plus proposée.`);

    if (typeof zone.latitude !== 'number' || typeof zone.longitude !== 'number') {
      throw new BadRequestException(`La zone « ${zone.name} » n’a pas de centre : elle ne peut pas être choisie.`);
    }

    return {
      label: zone.name,
      city: zone.city ?? null,
      postalCode: zone.postalCode ?? null,
      latitude: zone.latitude,
      longitude: zone.longitude,
      radiusKm: zone.radiusKm ?? 10,
      adminZoneId: zone.id,
      isActive: true as const,
    };
  });
}
