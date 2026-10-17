import * as fs from 'fs';
import * as path from 'path';

/**
 * Wiring guard (P1-02). Two things went wrong silently before: the
 * notifications controller and socket gateway were written but never listed in
 * a module, so /notifications answered 404 and no notification reached a socket.
 * This reads the source and fails if a controller or a gateway is not registered.
 */

function listFiles(dir: string, suffix: string): string[] {
  const out: string[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) out.push(...listFiles(full, suffix));
    else if (entry.name.endsWith(suffix)) out.push(full);
  }

  return out;
}

const SRC = __dirname;
const moduleTexts = listFiles(SRC, '.module.ts').map((file) => fs.readFileSync(file, 'utf8'));

function classesIn(file: string, pattern: RegExp): string[] {
  const text = fs.readFileSync(file, 'utf8');
  return [...text.matchAll(pattern)].map((m) => m[1]);
}

function listedIn(modules: string[], key: 'controllers' | 'providers' | 'imports', name: string): boolean {
  const pattern = new RegExp(`${key}:\\s*\\[[^\\]]*\\b${name}\\b`);
  return modules.some((text) => pattern.test(text));
}

describe('every controller is registered in a module', () => {
  const controllers = listFiles(SRC, '.controller.ts').flatMap((file) =>
    classesIn(file, /export class (\w+Controller)\b/g).map((name) => ({ name, file })),
  );

  it('finds the controllers', () => {
    expect(controllers.length > 10).toBe(true);
  });

  it('none is left out', () => {
    const missing = controllers
      .filter(({ name }) => !listedIn(moduleTexts, 'controllers', name))
      .map(({ name, file }) => `${name} (${path.relative(SRC, file)})`);

    expect(missing).toEqual([]);
  });
});

describe('every socket gateway is a provider of a module', () => {
  const gateways = listFiles(SRC, '.gateway.ts').flatMap((file) =>
    classesIn(file, /export class (\w+Gateway)\b/g).map((name) => ({ name, file })),
  );

  it('finds the gateways', () => {
    expect(gateways.length >= 3).toBe(true);
  });

  it('none is left out', () => {
    const missing = gateways
      .filter(({ name }) => !listedIn(moduleTexts, 'providers', name))
      .map(({ name, file }) => `${name} (${path.relative(SRC, file)})`);

    expect(missing).toEqual([]);
  });
});

describe('services that push to sockets can reach the realtime service', () => {
  it('the messages module imports the realtime module', () => {
    const text = fs.readFileSync(path.join(SRC, 'modules/messages/messages.module.ts'), 'utf8');
    expect(/imports:\s*\[[^\]]*\bRealtimeModule\b/.test(text)).toBe(true);
  });
});

describe('the delivery outbox is wired (P1-03)', () => {
  const text = fs.readFileSync(path.join(SRC, 'modules/notifications/notifications.module.ts'), 'utf8');

  it('the notifications module provides the services NotificationsService is built from', () => {
    for (const name of ['OutboxService', 'MessageTemplatesService']) {
      expect(listedIn([text], 'providers', name)).toBe(true);
    }
  });

  it('and the two values the outbox is injected with', () => {
    expect(text.includes('provide: DELIVERY_CONFIG')).toBe(true);
    expect(text.includes('provide: DeliveryProviders')).toBe(true);
  });
});

describe('what keeps the delivery safe (P1-03 review)', () => {
  const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

  it('the rate limit service can be injected anywhere: global module that exports it', () => {
    const text = read('common/rate-limit/rate-limit.module.ts');

    expect(text.includes('@Global()')).toBe(true);
    expect(/exports:\s*\[[^\]]*\bRateLimitService\b/.test(text)).toBe(true);
  });

  it('the public artisan application is limited per visitor', () => {
    const text = read('modules/artisans/artisans.controller.ts');
    const at = text.indexOf("@Post('apply')");
    const before = text.slice(Math.max(0, at - 300), at);

    expect(at > 0).toBe(true);
    expect(before.includes('@UseGuards(RateLimitGuard)')).toBe(true);
    expect(before.includes("name: 'artisan-apply'")).toBe(true);
  });

  it('the admin delivery checks are declared before the :notificationId routes', () => {
    const text = read('modules/notifications/notifications.controller.ts');
    const detail = text.indexOf("@Get(':notificationId')");

    for (const route of ["@Post('test-delivery')", "@Get('outbox/:outboxId')"]) {
      const at = text.indexOf(route);
      expect(at > 0).toBe(true);
      expect(at < detail).toBe(true);
    }
  });

  it('the server finishes the message it is sending on shutdown', () => {
    expect(read('main.ts').includes('app.enableShutdownHooks()')).toBe(true);
  });

  it('the database is closed after the delivery worker has finished, not before', () => {
    const prisma = read('prisma/prisma.service.ts');

    expect(prisma.includes('onApplicationShutdown')).toBe(true);
    expect(/async onModuleDestroy\s*\(/.test(prisma)).toBe(false);
  });

  it('creating a request while signed in is limited too, and the admin alert SMS has its own cap', () => {
    const controller = read('modules/interventions/interventions.controller.ts');
    const at = controller.indexOf("@Post('secure')");

    expect(controller.slice(at, at + 200).includes('RateLimitGuard')).toBe(true);
    // P1-04: the alert text moved to the service every way of making a request calls.
    expect(read('modules/interventions/staff-alerts.service.ts').includes("'admin-alert-sms'")).toBe(true);
  });

  it('no phone number is written in the code', () => {
    const interventions = read('modules/interventions/interventions.service.ts');

    expect(/sendSms\(\s*['"`]\+?\d/.test(interventions)).toBe(false);
    expect(interventions.includes('21600000000')).toBe(false);
  });
});

describe('contact change is wired (P1-03, step 4)', () => {
  const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

  it('the users module provides the service and exports it to the admin dashboard', () => {
    const text = read('modules/users/users.module.ts');

    expect(/providers:\s*\[[^\]]*\bContactChangeService\b/.test(text)).toBe(true);
    expect(/exports:\s*\[[^\]]*\bContactChangeService\b/.test(text)).toBe(true);
    expect(/imports:\s*\[[^\]]*\bUsersModule\b/.test(read('modules/admin/admin.module.ts'))).toBe(true);
  });

  it('every route that changes an e-mail or a phone is rate limited, and only the e-mail link is public', () => {
    const text = read('modules/users/users.controller.ts');

    for (const route of ["@Post('me/email-change')", "@Post('email-change/confirm')", "@Post('me/phone-change')", "@Post('me/phone-change/confirm')"]) {
      const at = text.indexOf(route);
      const before = text.slice(Math.max(0, at - 260), at);

      expect(at > 0).toBe(true);
      expect(before.includes('RateLimitGuard')).toBe(true);
      expect(before.includes('@RateLimit(')).toBe(true);
      // the link in the mail is opened without a session; everything else needs one
      expect(before.includes('JwtAuthGuard')).toBe(route !== "@Post('email-change/confirm')");
    }
  });

  it('the fixed routes are declared before the :id ones', () => {
    const text = read('modules/users/users.controller.ts');

    expect(text.indexOf("@Delete('me')") < text.indexOf("@Delete(':id')")).toBe(true);
    expect(text.indexOf("@Get('profile')") < text.indexOf("@Get(':id')")).toBe(true);
    expect(text.indexOf("@Patch('profile')") < text.indexOf("@Patch(':id')")).toBe(true);
  });

  it('the activation request knows the client address, so one visitor cannot use up a number\'s quota', () => {
    const text = read('modules/guest/guest.controller.ts');
    const at = text.indexOf("@Post('account/request-activation')");

    expect(at > 0).toBe(true);
    expect(text.slice(at, at + 400).includes('@Ip()')).toBe(true);
  });

  it('the phone key is read at start-up', () => {
    expect(read('modules/users/contact-change.service.ts').includes('async onApplicationBootstrap()')).toBe(true);
  });

  it('npm run phones:backfill exists and the script is in the repository', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(SRC, '../package.json'), 'utf8'));

    expect(typeof pkg.scripts['phones:backfill']).toBe('string');
    expect(fs.existsSync(path.join(SRC, '../scripts/backfill-phone-keys.ts'))).toBe(true);
  });
});
