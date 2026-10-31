import { TICKET_STAFF_ROLES } from '../auth/role-policy';
import { ROUTE_ACCESS } from './route-access.golden';
import { ScannedRoute, routeKey, scanController } from './route-roles';
import { listSourceFiles, readSource } from './source-scan';

/**
 * Who may call each route, pinned (P3-02). The matrix changes who reaches a route from one line, so this spec reads every controller
 * and compares, route by route, with the table written out in `route-access.golden.ts`.
 */

interface Found extends ScannedRoute {
  key: string;
  file: string;
}

function allRoutes(): Found[] {
  const found: Found[] = [];

  for (const file of listSourceFiles().filter((name) => name.endsWith('.controller.ts'))) {
    for (const route of scanController(readSource(file), TICKET_STAFF_ROLES)) {
      found.push({ ...route, key: routeKey(route.method, route.path), file });
    }
  }

  return found;
}

const ROUTES = allRoutes();

/** What the table says about a route read from its source. */
const accessOf = (route: ScannedRoute): string => {
  if (route.permission !== null && route.roles !== null) return `${route.permission} | ${[...route.roles].sort().join(',')}`;

  return route.roles !== null ? [...route.roles].sort().join(',') : route.how;
};

describe('the table of who may call each route (P3-02)', () => {
  it('reads the controllers', () => {
    expect(ROUTES.length).toBeGreaterThan(300);
    expect(Object.keys(ROUTE_ACCESS).length).toBe(ROUTES.length);
  });

  it('no route is read twice under one key', () => {
    const seen = new Set<string>();
    const twice = ROUTES.filter((route) => (seen.has(route.key) ? true : (seen.add(route.key), false))).map((route) => route.key);

    expect(twice).toEqual([]);
  });

  it('every route is in the table with the roles it has, and the table has no route that is gone', () => {
    const differences: string[] = [];

    for (const route of ROUTES) {
      const written = Object.prototype.hasOwnProperty.call(ROUTE_ACCESS, route.key) ? ROUTE_ACCESS[route.key] : undefined;

      if (written === undefined) differences.push(`${route.key}: not in the table (the code says ${accessOf(route)})`);
      else if (written !== accessOf(route)) differences.push(`${route.key}: the table says ${written}, the code says ${accessOf(route)}`);
    }

    const present = new Set(ROUTES.map((route) => route.key));

    for (const key of Object.keys(ROUTE_ACCESS)) {
      if (!present.has(key)) differences.push(`${key}: in the table, no such route`);
    }

    expect(differences).toEqual([]);
  });

  it('a route that names roles is enforced by a guard, and its roles are not empty', () => {
    const bad = ROUTES.filter((route) => route.roles !== null && (!route.rolesEnforced || route.roles.length === 0)).map((route) => route.key);

    expect(bad).toEqual([]);
  });

  it('the values of the table are a list of known roles or one of the three words', () => {
    const roles = new Set(['ADMIN', 'SUPER_ADMIN', 'SUPPORT', 'DISPATCHER', 'ACCOUNTANT', 'CLIENT', 'ARTISAN']);
    const words = new Set(['signed-in', 'in-code', 'public']);
    const bad = Object.entries(ROUTE_ACCESS)
      .filter(([, value]) => {
        const [permission, list] = value.includes(' | ') ? value.split(' | ') : [null, value];

        if (permission !== null && !/^[a-z][a-z-]*\.[a-z][a-z-]*$/.test(permission)) return true;

        return !words.has(list) && !list.split(',').every((role) => roles.has(role));
      })
      .map(([key]) => key);

    expect(bad).toEqual([]);
  });
});
