import { misfitOf } from './job-fit';

const TUNIS = { latitude: 36.8065, longitude: 10.1815 };
const SFAX = { latitude: 34.7406, longitude: 10.7603 };

const zone = (over: any = {}) => ({ ...TUNIS, radiusKm: 20, isActive: true, ...over });

describe('does an open job fit an artisan (P1-11)', () => {
  it('a profile with no trade and no zone is offered every job', () => {
    expect(misfitOf({}, { serviceType: 'PLOMBIER', ...SFAX })).toBeNull();
    expect(misfitOf({ serviceZones: [] }, { serviceType: 'VITRIER', ...TUNIS })).toBeNull();
  });

  it('a job of another trade does not fit, whatever the zone', () => {
    expect(misfitOf({ serviceTypes: ['PLOMBIER'] }, { serviceType: 'SERRURIER', ...TUNIS })).toBe('trade');
    expect(misfitOf({ serviceTypes: ['PLOMBIER'], serviceZones: [zone()] }, { serviceType: 'SERRURIER', ...TUNIS })).toBe('trade');
  });

  it('the trade is read from the words of the profile too ("Plombier"), and the first of several is not the only one', () => {
    expect(misfitOf({ specialty: 'Plomberie', specialties: ['Plomberie', 'Électricité'] }, { serviceType: 'ELECTRICIEN' })).toBeNull();
    expect(misfitOf({ specialty: 'Plomberie', specialties: ['Plomberie'] }, { serviceType: 'ELECTRICIEN' })).toBe('trade');
  });

  it('a job that names no type cannot be judged on trade and is not refused for it', () => {
    expect(misfitOf({ serviceTypes: ['PLOMBIER'] }, { ...TUNIS })).toBeNull();
    expect(misfitOf({ serviceTypes: ['PLOMBIER'] }, { serviceType: null, ...TUNIS })).toBeNull();
    expect(misfitOf({ serviceTypes: ['PLOMBIER'], serviceZones: [zone()] }, { ...SFAX })).toBe('zone');
  });

  it('a job of the trade but outside every zone does not fit', () => {
    expect(misfitOf({ serviceTypes: ['PLOMBIER'], serviceZones: [zone()] }, { serviceType: 'PLOMBIER', ...SFAX })).toBe('zone');
  });

  it('a job inside one of the zones fits', () => {
    const zones = [zone({ ...SFAX }), zone()];

    expect(misfitOf({ serviceTypes: ['PLOMBIER'], serviceZones: zones }, { serviceType: 'PLOMBIER', ...TUNIS })).toBeNull();
  });

  it('a job with no position is not refused for its place', () => {
    expect(misfitOf({ serviceZones: [zone()] }, { serviceType: 'PLOMBIER', latitude: null, longitude: null })).toBeNull();
    expect(misfitOf({ serviceZones: [zone()] }, { serviceType: 'PLOMBIER' })).toBeNull();
  });

  it('zones that are switched off or have no centre do not limit the artisan', () => {
    expect(misfitOf({ serviceZones: [zone({ isActive: false })] }, { serviceType: 'PLOMBIER', ...SFAX })).toBeNull();
    expect(misfitOf({ serviceZones: [zone({ latitude: null, longitude: null })] }, { serviceType: 'PLOMBIER', ...SFAX })).toBeNull();
  });
});
