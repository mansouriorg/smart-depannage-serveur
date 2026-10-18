import { distanceKm } from '../../common/geo/distance';
import { GOVERNORATES } from './governorates';

/**
 * The list of zones the platform starts with (P1-11). The centres are typed by hand, so the tests
 * guard against the slips a list like this collects: a missing or doubled governorate, a latitude
 * and a longitude swapped, a point outside the country, a radius that makes a zone useless.
 */
describe('the governorates of the platform (P1-11)', () => {
  it('lists the 24 governorates of Tunisia, each once', () => {
    expect(GOVERNORATES).toHaveLength(24);
    expect(new Set(GOVERNORATES.map((zone) => zone.name.toLowerCase())).size).toBe(24);
  });

  it('every centre is inside Tunisia (a swapped latitude and longitude lands outside)', () => {
    for (const zone of GOVERNORATES) {
      expect(zone.latitude).toBeGreaterThan(30);
      expect(zone.latitude).toBeLessThan(37.6);
      expect(zone.longitude).toBeGreaterThan(7.5);
      expect(zone.longitude).toBeLessThan(11.7);
    }
  });

  it('every radius is a usable circle: 15 to 50 km, and the four of Greater Tunis are the smallest', () => {
    for (const zone of GOVERNORATES) {
      expect(zone.radiusKm).toBeGreaterThanOrEqual(15);
      expect(zone.radiusKm).toBeLessThanOrEqual(50);
    }

    const grandTunis = ['Tunis', 'Ariana', 'Ben Arous', 'La Manouba'].map((name) => GOVERNORATES.find((zone) => zone.name === name)!);

    expect(grandTunis.every((zone) => zone.radiusKm === 20)).toBe(true);
    expect(GOVERNORATES.filter((zone) => !grandTunis.includes(zone)).every((zone) => zone.radiusKm === 30)).toBe(true);
  });

  it('no two centres are the same place, and neighbours are not on top of each other', () => {
    for (let i = 0; i < GOVERNORATES.length; i += 1) {
      for (let j = i + 1; j < GOVERNORATES.length; j += 1) {
        const a = GOVERNORATES[i];
        const b = GOVERNORATES[j];

        expect(distanceKm(a.latitude, a.longitude, b.latitude, b.longitude)).toBeGreaterThan(5);
      }
    }
  });

  it('the known distances come out right: Tunis-Sfax is about 245 km, Tunis-Ariana about 7 km', () => {
    const at = (name: string) => GOVERNORATES.find((zone) => zone.name === name)!;
    const between = (a: string, b: string) =>
      distanceKm(at(a).latitude, at(a).longitude, at(b).latitude, at(b).longitude);

    expect(between('Tunis', 'Sfax')).toBeGreaterThan(230);
    expect(between('Tunis', 'Sfax')).toBeLessThan(260);
    expect(between('Tunis', 'Ariana')).toBeGreaterThan(5);
    expect(between('Tunis', 'Ariana')).toBeLessThan(10);
  });

  it('the north is north of the south: Bizerte, Tunis, Sousse, Sfax, Gabès, Tataouine from top to bottom', () => {
    const lat = (name: string) => GOVERNORATES.find((zone) => zone.name === name)!.latitude;
    const order = ['Bizerte', 'Tunis', 'Sousse', 'Sfax', 'Gabès', 'Tataouine'].map(lat);

    expect([...order].sort((a, b) => b - a)).toEqual(order);
  });

  it('the city of each zone is a name a person types: no empty text, no spaces around it', () => {
    for (const zone of GOVERNORATES) {
      expect(zone.name).toBe(zone.name.trim());
      expect(zone.city).toBe(zone.city.trim());
      expect(zone.name.length).toBeGreaterThan(1);
    }
  });
});
