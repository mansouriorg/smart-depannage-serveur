/**
 * Whether the API documentation page is served (P1-09).
 *
 * The page lists every route, which is a map for anybody who wants to attack the API, so it is
 * OFF in production unless somebody asks for it on purpose with API_DOCS=true (a staging server
 * that runs with NODE_ENV=production, say). Everywhere else it is on, and API_DOCS=false turns it off.
 *
 * This file has no import on purpose: it is read by the unit tests, which run without the
 * documentation library.
 */

export const API_DOCS_PATH = 'docs';
export const API_DOCS_TITLE = 'Smart-Dépannage API';
export const API_DOCS_DESCRIPTION =
  'Home-repair dispatch: customers, artisans and the back office. Lists answer { data, meta }; errors answer { statusCode, message, error }.';
export const API_DOCS_VERSION = '1.0';

export function apiDocsEnabled(env: Record<string, unknown>): boolean {
  const asked = String(env.API_DOCS ?? '').trim().toLowerCase();
  const production = String(env.NODE_ENV ?? '').trim().toLowerCase() === 'production';

  if (production) return asked === 'true';

  return asked !== 'false';
}
