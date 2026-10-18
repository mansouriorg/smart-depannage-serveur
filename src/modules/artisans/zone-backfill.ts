/**
 * One-off, run when P1-11 is deployed (npm run zones:backfill): gives a centre to the zones that
 * artisans typed as a name.
 *
 * Until now an artisan's zone was a label and a city, with no coordinates (the form took names), so
 * no job could ever be checked against it. From P1-11 a zone is a circle on the map. For each zone
 * that has no centre this looks for the platform zone (the governorates) it names, by its label or
 * its city, and copies that zone's centre and radius onto it, and links it. A name is read without
 * the case, the accents or the punctuation ("TUNIS", "Béja" and "beja" are the same name).
 *
 *  - a zone that names exactly one platform zone is filled;
 *  - a zone that names none ("Cité Ennasr", a quarter) is listed and left as it is: the artisan is
 *    then not limited by it (a zone that cannot be drawn limits nobody), until they pick a zone
 *    from the list;
 *  - a zone that names two different platform zones is listed and left as it is;
 *  - a zone that already has a centre is never touched;
 *  - the radius becomes the platform zone's: the 10 km every typed zone got was a default nobody chose.
 *
 * The old values of the zones it changes are handed to `beforeWrite` first (the script saves them
 * in a file), and nothing is written if that fails. Running it again changes nothing.
 */
export type ZoneBackfillChange = {
  zoneId: number;
  profileId: number;
  before: { label: string | null; city: string | null; latitude: number | null; longitude: number | null; radiusKm: number; adminZoneId: number | null };
  platformZoneId: number;
  platformZoneName: string;
};

export type ZoneBackfillReport = {
  /** Zones read that have no centre. */
  withoutCentre: number;
  changes: ZoneBackfillChange[];
  /** Typed names that match no platform zone: the words typed, by zone number. */
  unmatched: Array<{ zoneId: number; words: string[] }>;
  /** Names that match more than one platform zone. */
  ambiguous: Array<{ zoneId: number; words: string[]; candidates: string[] }>;
  written: number[];
  /** Changed while the script ran: left as they are. */
  raced: number[];
};

type Db = object;

type Tables = {
  artisanServiceZone: {
    findMany: (args: any) => Promise<any[]>;
    updateMany: (args: any) => Promise<{ count: number }>;
  };
  adminServiceZone: {
    findMany: (args: any) => Promise<any[]>;
  };
};

/** "Béja", " BEJA ", "beja." → "beja". */
export function zoneWord(text: unknown): string {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export async function backfillZones(
  database: Db,
  options: {
    apply: boolean;
    /** Called with the old values of the zones to change, before the first write; if it throws, nothing is written. */
    beforeWrite?: (changes: ZoneBackfillChange[]) => Promise<void> | void;
  },
): Promise<ZoneBackfillReport> {
  const db = database as Tables;

  const platform = await db.adminServiceZone.findMany({
    where: { isActive: true, latitude: { not: null }, longitude: { not: null } },
    orderBy: { id: 'asc' },
  });

  const names = new Map<string, Set<number>>();

  for (const zone of platform) {
    for (const word of [zoneWord(zone.name), zoneWord(zone.city)]) {
      if (!word) continue;

      names.set(word, (names.get(word) ?? new Set()).add(zone.id));
    }
  }

  const zones = await db.artisanServiceZone.findMany({
    where: { OR: [{ latitude: null }, { longitude: null }] },
    orderBy: { id: 'asc' },
  });

  const report: ZoneBackfillReport = {
    withoutCentre: zones.length,
    changes: [],
    unmatched: [],
    ambiguous: [],
    written: [],
    raced: [],
  };

  const plans: Array<{ zone: any; platform: any }> = [];

  for (const zone of zones) {
    const words = [zone.label, zone.city].map((text) => String(text ?? '').trim()).filter(Boolean);
    const found = new Set<number>();

    for (const word of words) {
      for (const id of names.get(zoneWord(word)) ?? []) found.add(id);
    }

    if (found.size === 0) {
      report.unmatched.push({ zoneId: zone.id, words });
      continue;
    }

    if (found.size > 1) {
      report.ambiguous.push({
        zoneId: zone.id,
        words,
        candidates: [...found].map((id) => platform.find((candidate) => candidate.id === id)!.name),
      });
      continue;
    }

    const target = platform.find((candidate) => candidate.id === [...found][0])!;

    report.changes.push({
      zoneId: zone.id,
      profileId: zone.artisanProfileId,
      before: {
        label: zone.label ?? null,
        city: zone.city ?? null,
        latitude: zone.latitude ?? null,
        longitude: zone.longitude ?? null,
        radiusKm: zone.radiusKm,
        adminZoneId: zone.adminZoneId ?? null,
      },
      platformZoneId: target.id,
      platformZoneName: target.name,
    });
    plans.push({ zone, platform: target });
  }

  if (!options.apply) return report;

  if (options.beforeWrite && report.changes.length) await options.beforeWrite(report.changes);

  for (const { zone, platform: target } of plans) {
    // Only if the zone still has no centre: an artisan who set one meanwhile keeps it.
    const done = await db.artisanServiceZone.updateMany({
      where: { id: zone.id, OR: [{ latitude: null }, { longitude: null }] },
      data: { latitude: target.latitude, longitude: target.longitude, radiusKm: target.radiusKm, adminZoneId: target.id },
    });

    if (done.count === 1) report.written.push(zone.id);
    else report.raced.push(zone.id);
  }

  return report;
}
