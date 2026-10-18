import { FakeTable } from '../../common/testing/fake-tables';
import { ServiceZonesService } from './service-zones.service';

describe('the public list of zones (P1-11)', () => {
  it('lists the zones that can be picked, by name, with only the number, the name and the city asked for', async () => {
    const adminServiceZone = new FakeTable();
    const asked: any[] = [];

    adminServiceZone.insert({ name: 'Sfax', city: 'Sfax', latitude: 34.7, longitude: 10.8, radiusKm: 30, isActive: true });
    adminServiceZone.insert({ name: 'Tunis', city: 'Tunis', latitude: 36.8, longitude: 10.2, radiusKm: 20, isActive: true });
    adminServiceZone.insert({ name: 'Off', city: null, latitude: 35, longitude: 10, radiusKm: 10, isActive: false });
    adminServiceZone.insert({ name: 'Typed', city: null, latitude: null, longitude: null, radiusKm: 10, isActive: true });

    const prisma: any = {
      adminServiceZone: {
        findMany: async (args: any) => {
          asked.push(args);
          return adminServiceZone.findMany(args);
        },
      },
    };

    const rows = await new ServiceZonesService(prisma).findPublic();

    expect(rows.map((row: any) => row.name)).toEqual(['Sfax', 'Tunis']);
    // the centre and the radius never leave the server through this route
    expect(asked[0].select).toEqual({ id: true, name: true, city: true });
    expect(asked[0].orderBy).toEqual({ name: 'asc' });
  });
});
