import { distanceKm } from './distance';
import { ZoneCircle, drawableZones, zoneVerdict } from './zone-match';

const sfax: ZoneCircle = { latitude: 34.7406, longitude: 10.7603, radiusKm: 30, isActive: true };
const tunis: ZoneCircle = { latitude: 36.8065, longitude: 10.1815, radiusKm: 20, isActive: true };

describe('the distance between two points', () => {
  it('is 0 for the same point and about 235 km from Tunis to Sfax', () => {
    expect(distanceKm(36.8065, 10.1815, 36.8065, 10.1815)).toBe(0);

    const km = distanceKm(36.8065, 10.1815, 34.7406, 10.7603);

    expect(km > 225 && km < 245).toBe(true);
  });
});

describe('a job and the zones of an artisan (P1-11)', () => {
  it('an artisan with no zone is not limited', () => {
    expect(zoneVerdict([], { latitude: 36.8, longitude: 10.1 })).toEqual({ matches: true, kind: 'unrestricted' });
  });

  it('a zone that is switched off, or has no centre, does not count: the artisan is not limited by it', () => {
    const off = { ...sfax, isActive: false };
    const unplaced = { ...sfax, latitude: null, longitude: null };

    expect(zoneVerdict([off], { latitude: 36.8, longitude: 10.1 }).matches).toBe(true);
    expect(zoneVerdict([unplaced], { latitude: 36.8, longitude: 10.1 })).toEqual({ matches: true, kind: 'unrestricted' });
    expect(drawableZones([off, unplaced, tunis])).toEqual([tunis]);
  });

  it('a job whose position is unknown is let through', () => {
    for (const job of [{}, { latitude: 36.8 }, { longitude: 10.1 }, { latitude: null, longitude: null }]) {
      expect(zoneVerdict([sfax], job)).toEqual({ matches: true, kind: 'unknown-position' });
    }
  });

  it('a job inside the radius of a zone matches, and says how far from its centre', () => {
    const verdict: any = zoneVerdict([tunis], { latitude: 36.85, longitude: 10.2 });

    expect(verdict.matches).toBe(true);
    expect(verdict.kind).toBe('inside');
    expect(verdict.distanceKm < 20).toBe(true);
  });

  it('a job outside every zone does not match', () => {
    expect(zoneVerdict([tunis, sfax], { latitude: 33.88, longitude: 10.1 })).toEqual({ matches: false, kind: 'outside' });
  });

  it('any one zone is enough', () => {
    expect(zoneVerdict([tunis, sfax], { latitude: 34.75, longitude: 10.75 }).matches).toBe(true);
  });

  it('the radius is the limit: just inside matches, just outside does not', () => {
    const centre = { latitude: 35, longitude: 10 };
    const zone: ZoneCircle = { ...centre, radiusKm: 10, isActive: true, };
    // 0.08 degrees of latitude is about 8.9 km, 0.12 about 13.3 km
    expect(zoneVerdict([zone], { latitude: 35.08, longitude: 10 }).matches).toBe(true);
    expect(zoneVerdict([zone], { latitude: 35.12, longitude: 10 }).matches).toBe(false);
  });

  it('a job exactly on the limit of the radius is inside', () => {
    const km = distanceKm(35, 10, 35.05, 10);
    const zone: ZoneCircle = { latitude: 35, longitude: 10, radiusKm: km, isActive: true };

    expect(zoneVerdict([zone], { latitude: 35.05, longitude: 10 }).matches).toBe(true);
    expect(zoneVerdict([{ ...zone, radiusKm: km - 0.001 }], { latitude: 35.05, longitude: 10 }).matches).toBe(false);
  });

  it('a position at 0 is a position, not a missing one', () => {
    const zone: ZoneCircle = { latitude: 0, longitude: 0, radiusKm: 5, isActive: true };

    expect(zoneVerdict([zone], { latitude: 0, longitude: 0 }).kind).toBe('inside');
  });
});
