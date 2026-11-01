import * as fs from 'fs';
import * as path from 'path';

import { UsersService } from './users.service';

/**
 * GET /users/artisans carries the trade and the real rating of each profile (P1-12), and the other
 * lists of users do not change.
 */
function world(rows: any[] = [], groups: any[] = [], underWay: any[] = []) {
  const calls: any[] = [];
  const groupCalls: any[] = [];
  const jobCalls: any[] = [];
  const prisma: any = {
    user: {
      findMany: async (args: any) => {
        calls.push(args);
        return rows;
      },
      count: async () => rows.length,
    },
    intervention: {
      groupBy: async (args: any) => {
        groupCalls.push(args);
        return groups;
      },
      findMany: async (args: any) => {
        jobCalls.push(args);
        return underWay;
      },
    },
  };

  return { calls, groupCalls, jobCalls, service: new UsersService(prisma, {} as any, {} as any) };
}

describe('the list of artisans (P1-12)', () => {
  it('selects the account as everywhere plus the specialty, the average rating and the number of ratings', async () => {
    const { calls, service } = world();

    await service.findArtisans({ where: { role: 'ARTISAN' } as any, page: 2, limit: 10 });

    const select = calls[0].select;

    expect(select.email).toBe(true);
    expect(select.name).toBe(true);
    expect(select.artisanProfile).toEqual({ select: { specialty: true, averageRating: true, ratingCount: true, availabilityStatus: true } });
    expect(calls[0].where).toEqual({ role: 'ARTISAN' });
    expect(calls[0].skip).toBe(10);
    expect(calls[0].take).toBe(10);
  });

  it('never selects the password hash or the tokens of the account', async () => {
    const { calls, service } = world();

    await service.findArtisans({ where: {} });

    expect(Object.keys(calls[0].select)).not.toContain('password');
    expect(Object.keys(calls[0].select)).not.toContain('authTokens');
  });

  it('answers a page with the rows as the database gave them, and the answers customers gave after their jobs', async () => {
    const row = { id: 4, name: 'Sami', artisanProfile: { specialty: 'Plombier', averageRating: 4.5, ratingCount: 12 } };
    const other = { id: 5, name: 'Nour', artisanProfile: { specialty: 'Electricien', averageRating: 0, ratingCount: 0 } };
    const { service } = world([row, other], [{ artisanId: 5, _avg: { rating: 4.3333 }, _count: { rating: 3 } }]);

    const page: any = await service.findArtisans({ where: {}, page: 1, limit: 20 });

    // Rows that carry no time for their position are "unknown" for the flag of the dispatcher (P3-05).
    expect(page.data).toEqual([
      { ...row, feedback: { average: null, count: 0 }, locationState: 'unknown', locationAgeMinutes: null, hasJobUnderWay: false },
      { ...other, feedback: { average: 4.33, count: 3 }, locationState: 'unknown', locationAgeMinutes: null, hasJobUnderWay: false },
    ]);
    expect(page.meta.total).toBe(2);
  });

  it('asks for the answers of the artisans of this page only, in one query, and only the jobs that were rated', async () => {
    const { service, groupCalls } = world([{ id: 4 }, { id: 9 }]);

    await service.findArtisans({ where: {}, page: 1, limit: 20 });

    expect(groupCalls.length).toBe(1);
    expect(groupCalls[0].by).toEqual(['artisanId']);
    expect(groupCalls[0].where).toEqual({ artisanId: { in: [4, 9] }, rating: { not: null } });
    expect(groupCalls[0]._avg).toEqual({ rating: true });
    expect(groupCalls[0]._count).toEqual({ rating: true });
  });

  it('an empty page asks nothing more', async () => {
    const { service, groupCalls } = world([]);

    const page: any = await service.findArtisans({ where: {} });

    expect(groupCalls.length).toBe(0);
    expect(page.data).toEqual([]);
  });

  it('the other lists of users keep the plain account', async () => {
    const { calls, service } = world();

    await service.findAll({ where: {} });

    expect(calls[0].select.artisanProfile).toBeUndefined();
    expect(calls[0].select.email).toBe(true);
  });
});

describe('the route of the list of artisans (P1-12)', () => {
  const source = fs.readFileSync(path.join(__dirname, 'users.controller.ts'), 'utf8');

  it('GET /users/artisans reads the list with the profile summary, not the plain list of users', () => {
    const at = source.indexOf("@Get('artisans')");
    const route = source.slice(at, source.indexOf('\n  }\n', at));

    expect(at).toBeGreaterThan(0);
    expect(route).toContain('this.usersService.findArtisans(');
    expect(route).not.toContain('this.usersService.findAll(');
  });
});

describe('who is on a job, in the list of artisans (P3-05)', () => {
  it('flags the technicians who are on the way, arrived or at work, in either spelling of the status, with one query for the page', async () => {
    const rows = [{ id: 4, name: 'Sami' }, { id: 5, name: 'Nour' }, { id: 6, name: 'Ali' }];
    const { service, jobCalls } = world(rows, [], [{ artisanId: 5 }, { artisanId: 5 }]);

    const page: any = await service.findArtisans({ where: {} });

    expect(page.data.map((row: any) => [row.id, row.hasJobUnderWay])).toEqual([[4, false], [5, true], [6, false]]);
    expect(jobCalls.length).toBe(1);
    expect(jobCalls[0].where.artisanId).toEqual({ in: [4, 5, 6] });
    expect([...jobCalls[0].where.status.in].sort()).toEqual(['ARRIVED', 'ARTISAN_ARRIVED', 'ARTISAN_ON_THE_WAY', 'IN_PROGRESS', 'ON_THE_WAY'].sort());
    expect(jobCalls[0].select).toEqual({ artisanId: true });
  });

  it('asks nothing when the page is empty', async () => {
    const { service, jobCalls } = world([]);

    await service.findArtisans({ where: {} });

    expect(jobCalls.length).toBe(0);
  });
});
