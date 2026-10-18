import { MatchingService } from './matching.service';

/**
 * P1-11: the matching and the mission board read an artisan's service zones with one rule
 * (src/common/geo/zone-match.ts). A zone that has a centre and a radius is a circle; an
 * artisan with no such circle is not restricted; a job with no position is not refused.
 */

const TUNIS = { latitude: 36.8065, longitude: 10.1815 };
const SFAX = { latitude: 34.7406, longitude: 10.7603 };

const zone = (over: any = {}) => ({
  id: 1,
  label: 'Tunis',
  city: 'Tunis',
  postalCode: null,
  latitude: TUNIS.latitude,
  longitude: TUNIS.longitude,
  radiusKm: 20,
  isActive: true,
  ...over,
});

function artisan(id: number, zones: any[]) {
  return {
    id,
    name: `Artisan ${id}`,
    email: `a${id}@example.tn`,
    phone: `+2162000000${id}`,
    latitude: null,
    longitude: null,
    artisanProfile: {
      serviceTypes: ['PLOMBIER'],
      specialty: null,
      specialties: [],
      serviceZones: zones,
      availability: [],
      availabilityStatus: 'ONLINE',
      isAcceptingJobs: true,
      emergencyAvailable: true,
      maxActiveJobs: 3,
      verificationStatus: 'APPROVED',
      averageRating: 4.6,
      completedJobsCount: 10,
      cancelledJobsCount: 0,
    },
    artisanInterventions: [],
    artisanAppointments: [],
    artisanTimeBlocks: [],
  };
}

async function candidates(zones: any[], position?: { latitude: number; longitude: number }) {
  const prisma: any = {
    user: { findMany: async () => [artisan(1, zones)] },
    intervention: { findUnique: async () => null },
  };
  const service = new MatchingService(prisma, { assign: async () => ({}) } as any);

  return service.findMatchingArtisans(1, 'ADMIN' as any, { serviceType: 'PLOMBIER', ...position } as any);
}

describe('the service zones in the matching (P1-11)', () => {
  it('an artisan with no zone is accepted anywhere, with a lower score than a match', async () => {
    const [none] = await candidates([], SFAX);
    const [inside] = await candidates([zone()], TUNIS);

    expect(none.hardIssues).toEqual([]);
    expect(none.scoreBreakdown.serviceZone).toBe(8);
    expect(inside.scoreBreakdown.serviceZone).toBe(10);
  });

  it('a job inside a zone is a match, and the distance to the centre is part of the reason', async () => {
    const [match] = await candidates([zone()], { latitude: 36.85, longitude: 10.2 });

    expect(match.hardIssues).toEqual([]);
    expect(match.serviceFit).toBe(true);
    expect(match.reasons.some((reason: string) => /Client dans la zone de service \(\d+\.\d km\)\./.test(reason))).toBe(true);
  });

  it('a job outside every zone is a hard issue: the artisan is not offered it', async () => {
    const [far] = await candidates([zone()], SFAX);

    expect(far.isAvailable).toBe(false);
    expect(far.serviceFit).toBe(false);
    expect(far.hardIssues).toContain('Client hors zone de service.');
    expect(far.scoreBreakdown.serviceZone).toBe(0);
  });

  it('one zone that contains the job is enough, whatever the others say', async () => {
    const [match] = await candidates([zone({ id: 1, ...SFAX, label: 'Sfax' }), zone({ id: 2 })], TUNIS);

    expect(match.hardIssues).toEqual([]);
  });

  it('a zone that is switched off does not count', async () => {
    const [off] = await candidates([zone({ isActive: false })], SFAX);

    // the only zone is off: nothing draws a limit
    expect(off.hardIssues).toEqual([]);

    const [offAndFar] = await candidates([zone({ isActive: false }), zone({ id: 2, ...SFAX, label: 'Sfax' })], TUNIS);

    expect(offAndFar.hardIssues).toContain('Client hors zone de service.');
  });

  it('a zone typed as text, with no centre, leaves the artisan unrestricted (it used to refuse every job)', async () => {
    const [text] = await candidates([zone({ latitude: null, longitude: null, radiusKm: 10 })], SFAX);

    expect(text.hardIssues).toEqual([]);
    expect(text.scoreBreakdown.serviceZone).toBe(8);
  });

  it('a job with no position is let through, with a middle score', async () => {
    const [unknown] = await candidates([zone()]);

    expect(unknown.hardIssues).toEqual([]);
    expect(unknown.scoreBreakdown.serviceZone).toBe(5);
  });

  it('the edge of the circle: just inside is a match, just outside is not', async () => {
    // 20 km due north of the centre is about 0.1799 degrees of latitude
    const inside = await candidates([zone()], { latitude: TUNIS.latitude + 0.17, longitude: TUNIS.longitude });
    const outside = await candidates([zone()], { latitude: TUNIS.latitude + 0.19, longitude: TUNIS.longitude });

    expect(inside[0].hardIssues).toEqual([]);
    expect(outside[0].hardIssues).toContain('Client hors zone de service.');
  });
});
