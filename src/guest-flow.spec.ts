import * as fs from 'fs';
import * as path from 'path';

/**
 * Guards for the guest flow (P1-04). They read the source, like module-wiring.spec.ts,
 * because what they protect is what a future change can quietly take away:
 *   - a text field with no ceiling on a route anybody can call;
 *   - a second place that writes a tracking link by hand;
 *   - a new way of creating a request that forgets to alert the back office;
 *   - a public upload with no limit.
 */

const SRC = __dirname;
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

function listFiles(dir: string, suffix: string): string[] {
  const out: string[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) out.push(...listFiles(full, suffix));
    else if (entry.name.endsWith(suffix)) out.push(full);
  }

  return out;
}

// The test support (common/testing) is not production code: its scenarios write the paths they test.
const TESTING = path.join(SRC, 'common', 'testing') + path.sep;
const productionFiles = listFiles(SRC, '.ts').filter((file) => !file.endsWith('.spec.ts') && !file.startsWith(TESTING));

/** The decorators in front of each property of a DTO class, by property name. */
function propertyDecorators(source: string): Array<{ name: string; decorators: string }> {
  const out: Array<{ name: string; decorators: string }> = [];
  const declaration = /^\s*(\w+)\??:\s*[^;]+;/gm;
  let from = source.indexOf('export class');
  let match: RegExpExecArray | null;

  declaration.lastIndex = from;

  while ((match = declaration.exec(source))) {
    out.push({ name: match[1], decorators: source.slice(from, match.index) });
    from = match.index + match[0].length;
  }

  return out;
}

describe('every text a visitor can send to the guest routes has a ceiling', () => {
  const dtoFiles = listFiles(path.join(SRC, 'modules/guest/dto'), '.dto.ts');

  it('finds the DTOs', () => {
    expect(dtoFiles.length >= 7).toBe(true);
  });

  it('each @IsString field also has @MaxLength', () => {
    const uncapped: string[] = [];

    for (const file of dtoFiles) {
      for (const { name, decorators } of propertyDecorators(fs.readFileSync(file, 'utf8'))) {
        const isText = /@IsString\(\s*\)/.test(decorators) || /@IsEmail\(/.test(decorators);

        if (isText && !/@MaxLength\(\d+\)/.test(decorators)) {
          uncapped.push(`${path.basename(file)}: ${name}`);
        }
      }
    }

    expect(uncapped).toEqual([]);
  });

  it('the property reader sees the decorators of a property (it is not passing for nothing)', () => {
    const sample = `export class A {\n  @IsOptional()\n  @IsString()\n  @MaxLength(5)\n  a?: string;\n\n  @IsString()\n  b: string;\n}`;
    const found = propertyDecorators(sample);

    expect(found.map((item) => item.name)).toEqual(['a', 'b']);
    expect(/@MaxLength\(\d+\)/.test(found[0].decorators)).toBe(true);
    expect(/@MaxLength\(\d+\)/.test(found[1].decorators)).toBe(false);
  });

  it('a request has no field for photo links: pictures are uploaded', () => {
    const text = read('modules/guest/dto/create-guest-intervention.dto.ts');

    expect(/^\s*photos\??:/m.test(text)).toBe(false);
    expect(/photos:\s*dto\.photos/.test(read('modules/guest/guest.service.ts'))).toBe(false);
  });

  it('coordinates are within the earth', () => {
    const text = read('modules/guest/dto/create-guest-intervention.dto.ts');

    expect(text.includes('@Min(-90)') && text.includes('@Max(90)')).toBe(true);
    expect(text.includes('@Min(-180)') && text.includes('@Max(180)')).toBe(true);
  });

  it('ids sent by a form are whole numbers within the database column, on both request forms', () => {
    const decorators = (rel: string, name: string) => {
      const found = propertyDecorators(read(rel)).find((property) => property.name === name);

      return found ? found.decorators : '';
    };

    for (const [rel, name] of [
      ['modules/guest/dto/create-guest-intervention.dto.ts', 'subServiceId'],
      ['modules/client-interventions/dto/create-client-intervention.dto.ts', 'subServiceId'],
      ['modules/client-interventions/dto/create-client-intervention.dto.ts', 'savedAddressId'],
    ]) {
      const text = decorators(rel, name);

      expect(text.includes('@IsInt()') && text.includes('@Min(1)') && text.includes('@Max(2147483647)')).toBe(true);
    }
  });

  it('the older public routes and the signed-in request route have a ceiling too', () => {
    for (const file of [
      'modules/interventions/dto/submit-feedback.dto.ts',
      'modules/interventions/dto/report-issue.dto.ts',
      'modules/interventions/dto/create-intervention.dto.ts',
      'modules/client-interventions/dto/create-client-intervention.dto.ts',
    ]) {
      for (const { name, decorators } of propertyDecorators(read(file))) {
        if (/@IsString\(\s*\)/.test(decorators)) {
          expect(`${file}: ${name} ${/@MaxLength\(\d+\)/.test(decorators)}`).toBe(`${file}: ${name} true`);
        }
      }
    }
  });

  it('the problem report has a minimum, a ceiling and a trimmed text', () => {
    const text = read('modules/guest/dto/guest-problem-report.dto.ts');

    expect(text.includes('@MinLength(5)')).toBe(true);
    expect(text.includes('@MaxLength(1000)')).toBe(true);
    expect(text.includes('@MaxLength(120)')).toBe(true);
    expect(text.includes('@Transform(trimmed)')).toBe(true);
  });
});

describe('a tracking link is built in one place', () => {
  it('only tracking-url.ts knows the page, nobody writes the path by hand', () => {
    const offenders = productionFiles
      .filter((file) => !file.endsWith(path.join('links', 'tracking-url.ts')))
      .filter((file) => {
        const code = fs
          .readFileSync(file, 'utf8')
          .split('\n')
          .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
          .join('\n');

        return /demande\/status|\/guest\/tracking\/|\/tracking\/\$\{/.test(code);
      })
      .map((file) => path.relative(SRC, file));

    expect(offenders).toEqual([]);
  });

  it('the guest service and the signed-in client route both use buildTrackingUrl', () => {
    expect(read('modules/guest/guest.service.ts').includes('buildTrackingUrl(')).toBe(true);
    expect(read('modules/client-interventions/client-interventions.service.ts').includes('buildTrackingUrl(')).toBe(true);
  });

  it('the example FRONTEND_URL is the website port, not the API port', () => {
    const env = fs.readFileSync(path.join(SRC, '..', '.env.example'), 'utf8');
    const front = env.match(/^FRONTEND_URL=(.+)$/m)![1];
    const api = env.match(/^PORT=(\d+)$/m)![1];

    expect(front).toBe('http://localhost:3001');
    expect(front.endsWith(`:${api}`)).toBe(false);
  });
});

describe('every way of making a request alerts the back office', () => {
  const creators = productionFiles.filter((file) => /intervention\.create\(/.test(fs.readFileSync(file, 'utf8')));

  it('finds the three routes that create a request', () => {
    expect(creators.map((file) => path.relative(SRC, file)).sort()).toEqual([
      'modules/client-interventions/client-interventions.service.ts',
      'modules/guest/guest.service.ts',
      'modules/interventions/interventions.service.ts',
    ]);
  });

  it('each one calls staffAlerts.newRequest, after the row exists', () => {
    for (const file of creators) {
      const text = fs.readFileSync(file, 'utf8');
      const created = text.search(/intervention\.create\(/);
      const alerted = text.indexOf('staffAlerts.newRequest(');

      expect(alerted > created && created > 0).toBe(true);
    }
  });

  it('the alert service is provided and exported by the interventions module, and the other modules import it', () => {
    const interventions = read('modules/interventions/interventions.module.ts');

    expect(/providers:\s*\[[^\]]*\bStaffAlertsService\b/.test(interventions)).toBe(true);
    expect(/exports:\s*\[[^\]]*\bStaffAlertsService\b/.test(interventions)).toBe(true);
    expect(/imports:\s*\[[^\]]*\bInterventionsModule\b/.test(read('modules/guest/guest.module.ts'))).toBe(true);
    expect(/imports:\s*\[[^\]]*\bInterventionsModule\b/.test(read('modules/client-interventions/client-interventions.module.ts'))).toBe(true);
  });

  it('the guest module has what the new routes need: the picture store and the complaints', () => {
    const text = read('modules/guest/guest.module.ts');

    expect(/imports:\s*\[[^\]]*\bFilesModule\b/.test(text)).toBe(true);
    expect(/imports:\s*\[[^\]]*\bComplaintsModule\b/.test(text)).toBe(true);
  });
});

describe('the older public routes and the request route are limited too (P1-04 review)', () => {
  const routeBlock = (rel: string, route: string) => {
    const text = read(rel);
    const at = text.indexOf(route);

    return { at, before: text.slice(Math.max(0, at - 400), at + 120) };
  };

  it('feedback and issue on the older tracking link: per visitor address', () => {
    for (const [route, name] of [
      ["@Patch('track/:id/feedback')", "'track-feedback'"],
      ["@Post('track/:id/issue')", "'track-issue'"],
    ]) {
      const { at, before } = routeBlock('modules/interventions/interventions.controller.ts', route);

      expect(at > 0).toBe(true);
      expect(before.includes('RateLimitGuard')).toBe(true);
      expect(before.includes(`name: ${name}`)).toBe(true);
    }
  });

  it('a signed-in client making a request is limited, as every request now alerts the whole back office', () => {
    const { at, before } = routeBlock('modules/client-interventions/client-interventions.controller.ts', "@Post('client/interventions')");

    expect(at > 0).toBe(true);
    expect(before.includes('RateLimitGuard')).toBe(true);
    expect(before.includes("name: 'client-create'")).toBe(true);
  });

  it('the public route of the older API ignores photos typed by a visitor', () => {
    const text = read('modules/interventions/interventions.service.ts');

    expect(text.includes('const photos = userId ? sentPhotos : undefined;')).toBe(true);
  });
});

describe('the public upload and report routes are limited', () => {
  it('photos: the link is checked by a guard that runs before the upload is read, after the address limit', () => {
    const text = read('modules/guest/guest.controller.ts');
    const at = text.indexOf("@Post('interventions/:id/photos')");
    const before = text.slice(Math.max(0, at - 500), at);

    expect(before.includes('@UseGuards(RateLimitGuard, GuestTrackingLinkGuard)')).toBe(true);
    expect(text.indexOf('@UseGuards(RateLimitGuard, GuestTrackingLinkGuard)') < text.indexOf('@UseInterceptors(\n    FilesInterceptor(\'photos\'')).toBe(true);
  });

  it('photos: no text fields, as many parts as pictures, small headers', () => {
    const text = read('modules/guest/guest.controller.ts');
    const at = text.indexOf("FilesInterceptor('photos'");
    const limits = text.slice(at, at + 900);

    expect(limits.includes('fields: 0')).toBe(true);
    expect(limits.includes('parts: GuestService.MAX_PHOTOS_PER_CALL + 1')).toBe(true);
    expect(limits.includes('headerPairs: 20')).toBe(true);
  });

  it('photos: calls on one request are kept in order by a lock, and decodes are limited', () => {
    expect(read('modules/guest/guest.service.ts').includes('this.photoLock.run(')).toBe(true);
    expect(read('modules/files/files.service.ts').includes('this.guestDecodeSlots.run(')).toBe(true);
  });

  const controller = read('modules/guest/guest.controller.ts');

  const around = (route: string) => {
    const at = controller.indexOf(route);

    return { at, before: controller.slice(Math.max(0, at - 700), at) };
  };

  it('photos: per visitor address, in memory, 5 MB, images only, 5 files', () => {
    const { at, before } = around("@Post('interventions/:id/photos')");

    expect(at > 0).toBe(true);
    expect(before.includes('@UseGuards(RateLimitGuard, GuestTrackingLinkGuard)')).toBe(true);
    expect(before.includes("name: 'guest-photos'")).toBe(true);

    const upload = controller.slice(at, at + 900);

    expect(upload.includes("FilesInterceptor('photos', GuestService.MAX_PHOTOS_PER_CALL")).toBe(true);
    expect(upload.includes('memoryStorage()')).toBe(true);
    expect(upload.includes('fileSize: 5 * 1024 * 1024')).toBe(true);
    expect(upload.includes("'image/jpeg', 'image/png', 'image/webp'")).toBe(true);
    expect(controller.includes('diskStorage')).toBe(false);
  });

  it('problems: per visitor address', () => {
    const { at, before } = around("@Post('interventions/:id/problems')");

    expect(at > 0).toBe(true);
    expect(before.includes('@UseGuards(RateLimitGuard)')).toBe(true);
    expect(before.includes("name: 'guest-problems'")).toBe(true);
  });

  it('request creation stays limited too', () => {
    const { at, before } = around("@Post('interventions')");

    expect(at > 0).toBe(true);
    expect(before.includes("name: 'guest-create'")).toBe(true);
  });

  it('the service counts both per request, on top of the address limit', () => {
    const service = read('modules/guest/guest.service.ts');

    expect(service.includes('RATE_RULES.guestPhotoUploads')).toBe(true);
    expect(service.includes('RATE_RULES.guestProblemReports')).toBe(true);
    expect(service.includes('GUEST_COMPLAINT_CEILING')).toBe(true);
  });
});
