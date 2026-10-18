/**
 * The service zones the platform starts with (P1-11): the 24 governorates of Tunisia, each as a
 * circle (the city that gives its name, and a radius). An applicant picks from this list, and the
 * mission board and the matching check a job against the circles copied from it.
 *
 * The centres are the governorate capitals, to the nearest few hundred metres; the radius is a
 * starting value (20 km for the four governorates of Greater Tunis, which are small and dense,
 * 30 km elsewhere) that the back office adjusts through the zone routes (PATCH
 * /admin/settings/service-zones/:id; the dashboard has no screen for them yet). A zone that is too
 * small leaves jobs unanswered; one that is too big sends artisans too far. Nothing here is
 * final, which is why the seed never changes a zone that already exists.
 */
export type GovernorateZone = {
  name: string;
  city: string;
  latitude: number;
  longitude: number;
  radiusKm: number;
};

const GRAND_TUNIS = 20;
const OTHER = 30;

export const GOVERNORATES: GovernorateZone[] = [
  { name: 'Tunis', city: 'Tunis', latitude: 36.8065, longitude: 10.1815, radiusKm: GRAND_TUNIS },
  { name: 'Ariana', city: 'Ariana', latitude: 36.8665, longitude: 10.1647, radiusKm: GRAND_TUNIS },
  { name: 'Ben Arous', city: 'Ben Arous', latitude: 36.7533, longitude: 10.2189, radiusKm: GRAND_TUNIS },
  { name: 'La Manouba', city: 'La Manouba', latitude: 36.8101, longitude: 10.0863, radiusKm: GRAND_TUNIS },
  { name: 'Nabeul', city: 'Nabeul', latitude: 36.4513, longitude: 10.7357, radiusKm: OTHER },
  { name: 'Zaghouan', city: 'Zaghouan', latitude: 36.4029, longitude: 10.1429, radiusKm: OTHER },
  { name: 'Bizerte', city: 'Bizerte', latitude: 37.2744, longitude: 9.8739, radiusKm: OTHER },
  { name: 'Béja', city: 'Béja', latitude: 36.7256, longitude: 9.1817, radiusKm: OTHER },
  { name: 'Jendouba', city: 'Jendouba', latitude: 36.5011, longitude: 8.7802, radiusKm: OTHER },
  { name: 'Le Kef', city: 'Le Kef', latitude: 36.1742, longitude: 8.7049, radiusKm: OTHER },
  { name: 'Siliana', city: 'Siliana', latitude: 36.0849, longitude: 9.3708, radiusKm: OTHER },
  { name: 'Sousse', city: 'Sousse', latitude: 35.8256, longitude: 10.6369, radiusKm: OTHER },
  { name: 'Monastir', city: 'Monastir', latitude: 35.7643, longitude: 10.8113, radiusKm: OTHER },
  { name: 'Mahdia', city: 'Mahdia', latitude: 35.5047, longitude: 11.0622, radiusKm: OTHER },
  { name: 'Sfax', city: 'Sfax', latitude: 34.7406, longitude: 10.7603, radiusKm: OTHER },
  { name: 'Kairouan', city: 'Kairouan', latitude: 35.6781, longitude: 10.0963, radiusKm: OTHER },
  { name: 'Kasserine', city: 'Kasserine', latitude: 35.1676, longitude: 8.8365, radiusKm: OTHER },
  { name: 'Sidi Bouzid', city: 'Sidi Bouzid', latitude: 35.0382, longitude: 9.4849, radiusKm: OTHER },
  { name: 'Gabès', city: 'Gabès', latitude: 33.8815, longitude: 10.0982, radiusKm: OTHER },
  { name: 'Médenine', city: 'Médenine', latitude: 33.3549, longitude: 10.5055, radiusKm: OTHER },
  { name: 'Tataouine', city: 'Tataouine', latitude: 32.9297, longitude: 10.4518, radiusKm: OTHER },
  { name: 'Gafsa', city: 'Gafsa', latitude: 34.425, longitude: 8.7842, radiusKm: OTHER },
  { name: 'Tozeur', city: 'Tozeur', latitude: 33.9197, longitude: 8.1335, radiusKm: OTHER },
  { name: 'Kébili', city: 'Kébili', latitude: 33.7044, longitude: 8.969, radiusKm: OTHER },
];
