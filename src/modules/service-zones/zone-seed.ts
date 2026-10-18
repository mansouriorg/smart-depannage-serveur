import type { GovernorateZone } from './governorates';

/**
 * Writes the platform's zone list (governorates.ts) into the table of service zones (P1-11).
 *
 * Additive on purpose: the back office may already have made zones, renamed them, moved their
 * centre or switched them off. A zone whose name is already there (whatever the case) is left
 * exactly as it is; only the missing ones are created. The one exception: the older settings
 * screen let staff add a zone by name alone, and a zone with no centre cannot be picked by an
 * applicant (it cannot be drawn), so for such a zone the list's centre is filled in, and nothing
 * else about it changes. Running it again creates and fills nothing.
 */
export type ZoneSeedReport = { created: string[]; kept: string[]; filled: string[] };

type ZoneTable = {
  adminServiceZone: {
    findFirst: (args: any) => Promise<any>;
    create: (args: any) => Promise<any>;
    update: (args: any) => Promise<any>;
  };
};

/** The database client, or a stand-in in the tests. */
export type ZoneSeedDb = object;

export async function seedServiceZones(database: ZoneSeedDb, zones: GovernorateZone[]): Promise<ZoneSeedReport> {
  const db = database as ZoneTable;
  const report: ZoneSeedReport = { created: [], kept: [], filled: [] };

  for (const zone of zones) {
    const known = await db.adminServiceZone.findFirst({
      where: { name: { equals: zone.name, mode: 'insensitive' } },
      select: { id: true, latitude: true, longitude: true },
    });

    if (known) {
      if (typeof known.latitude !== 'number' || typeof known.longitude !== 'number') {
        await db.adminServiceZone.update({
          where: { id: known.id },
          data: { latitude: zone.latitude, longitude: zone.longitude },
        });
        report.filled.push(zone.name);
      } else {
        report.kept.push(zone.name);
      }

      continue;
    }

    await db.adminServiceZone.create({
      data: {
        name: zone.name,
        city: zone.city,
        latitude: zone.latitude,
        longitude: zone.longitude,
        radiusKm: zone.radiusKm,
        isActive: true,
      },
    });
    report.created.push(zone.name);
  }

  return report;
}
