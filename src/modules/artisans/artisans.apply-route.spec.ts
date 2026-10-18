import * as fs from 'fs';
import * as path from 'path';

/**
 * The public application route is a multipart request, and nothing in a unit test goes through
 * Nest's decorators. These checks read the controller's source for the few lines that decide how
 * much a visitor can make the server do: the names of the files the website sends, the size
 * limits, and the order (the rate limit answers before the upload is read).
 */
const source = fs.readFileSync(path.join(__dirname, 'artisans.controller.ts'), 'utf8');

/** The decorators and the signature of apply(), up to the opening of its body. */
function applyRoute(): string {
  const at = source.indexOf("@Post('apply')");

  expect(at).toBeGreaterThan(0);

  // from the guard decorators above the route to the body of the method
  const start = source.lastIndexOf('@UseGuards(RateLimitGuard)', at);
  const end = source.indexOf('const dto = parseApplication(data);', at);

  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(at);

  return source.slice(start, end);
}

describe('the public application route (P1-11 review)', () => {
  it('takes the three document fields the website sends, one file each, and the form in `data`', () => {
    const route = applyRoute();

    for (const field of ['identityDocument', 'companyDocument', 'insuranceCertificate']) {
      expect(route).toContain(`{ name: '${field}', maxCount: 1 }`);
    }

    expect(route).toContain("@Body('data') data: unknown");
    expect(route.match(/maxCount: 1/g)).toHaveLength(3);
  });

  it('keeps the files in memory, at the size of an applicant document (5 MB), with no more than three files and two fields', () => {
    const route = applyRoute();

    expect(route).toContain('storage: memoryStorage()');
    // the whole object, so "files: 30" or "fields: 200" is not read as "files: 3" and "fields: 2"
    expect(route).toContain('limits: { fileSize: APPLICANT_DOCUMENT_MAX_MB * 1024 * 1024, files: 3, fields: 2, fieldSize: 64 * 1024 },');
    expect(source).toContain("import { APPLICANT_DOCUMENT_MAX_MB } from '../files/files.service';");
  });

  it('is capped per visitor, and the cap answers before the upload is read', () => {
    const route = applyRoute();

    expect(route).toContain("@RateLimit({ name: 'artisan-apply', limit: 5, windowMs: 60 * 60_000 })");
    expect(route.indexOf('@UseGuards(RateLimitGuard)')).toBeLessThan(route.indexOf('@UseInterceptors('));
    expect(route.indexOf('@RateLimit(')).toBeLessThan(route.indexOf('@UseInterceptors('));
  });

  it('is public: it is not behind the login or a role', () => {
    const route = applyRoute();

    expect(route).not.toContain('JwtAuthGuard');
    expect(route).not.toContain('@Roles(');
  });

  it('checks the form before anything is stored (parseApplication first, then the service)', () => {
    const at = source.indexOf('const dto = parseApplication(data);');
    const call = source.indexOf('this.artisansService.apply(dto', at);

    expect(at).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(at);
  });
});
