import { listSourceFiles, readSource, stripComments } from '../testing/source-scan';
import {
  ApiErrorBody,
  OffsetPaginated,
  Paginated,
  offsetPaginated,
  pageItems,
  pageMeta,
  paginated,
} from './envelope';

/**
 * P1-09: one shape for a page of a list, built in one place. The same file is copied into the
 * shared package, so the apps read these types; a list that built its own `meta` would be the
 * mismatch the apps cannot see, which is why the second block reads the source for it.
 */
describe('the page of a list (P1-09)', () => {
  it('the meta says where the page stands, and the page count is worked out in one place', () => {
    expect(pageMeta(2, 20, 41)).toEqual({ page: 2, limit: 20, total: 41, totalPages: 3 });
    expect(pageMeta(1, 20, 40).totalPages).toBe(2);
    expect(pageMeta(1, 20, 0)).toEqual({ page: 1, limit: 20, total: 0, totalPages: 0 });
    expect(pageMeta(1, 0, 5).totalPages).toBe(0);
  });

  it('a page is { data, meta }', () => {
    const answer: Paginated<string> = paginated(['a', 'b'], 1, 2, 5);

    expect(Object.keys(answer).sort()).toEqual(['data', 'meta']);
    expect(answer.data).toEqual(['a', 'b']);
    expect(answer.meta).toEqual({ page: 1, limit: 2, total: 5, totalPages: 3 });
  });

  it('a list paged by take and skip says the same things, and also take and skip', () => {
    const answer: OffsetPaginated<number> = offsetPaginated([1], 2, 1, 3);

    expect(answer.meta).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2, take: 2, skip: 1 });
    expect(offsetPaginated([], 50, 100, 120).meta.page).toBe(3);
    expect(offsetPaginated([], 0, 0, 0).meta.page).toBe(1);
  });

  it('the rows of an answer: a page, or the bare list of an older route, never a guess', () => {
    expect(pageItems(paginated([1, 2], 1, 2, 2))).toEqual([1, 2]);
    expect(pageItems([3, 4])).toEqual([3, 4]);
    expect(pageItems(null)).toEqual([]);
    expect(pageItems(undefined)).toEqual([]);
    expect(pageItems({ data: 'not a list' } as any)).toEqual([]);
  });

  it('the error body names the sentence and the reasons', () => {
    const body: ApiErrorBody = { statusCode: 400, message: ['a', 'b'], issues: ['c'] };

    expect(body.issues).toEqual(['c']);
  });
});

describe('every paged list is built by the helper (P1-09)', () => {
  const files = listSourceFiles().filter((rel) => rel.startsWith('modules/'));

  it('no service writes its own meta object for a page', () => {
    // `meta: {...}` and the shorthand `{ data, meta }` both mean a service built its own.
    const found = files.filter((rel) => /\bmeta\s*:\s*\{|\bdata\s*,\s*meta\b/.test(stripComments(readSource(rel))));

    expect(found).toEqual([]);
  });

  it('the services that answer { data, meta } use the helper', () => {
    for (const rel of [
      'modules/admin/admin.service.ts',
      'modules/users/users.service.ts',
      'modules/artisans/artisans.service.ts',
      'modules/proofs/proofs.service.ts',
    ]) {
      expect(stripComments(readSource(rel))).toMatch(/\b(?:offsetP|p)aginated\(/);
    }

    const admin = stripComments(readSource('modules/admin/admin.service.ts'));

    expect((admin.match(/\bpaginated\(/g) ?? []).length).toBe(4);
  });

  it('the file has no import, so it can be copied as it is into the shared package', () => {
    expect(stripComments(readSource('common/api-contract/envelope.ts'))).not.toMatch(/^\s*import\s/m);
  });
});
