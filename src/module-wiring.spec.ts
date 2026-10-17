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
    expect(read('modules/interventions/interventions.service.ts').includes("'admin-alert-sms'")).toBe(true);
  });

  it('no phone number is written in the code', () => {
    const interventions = read('modules/interventions/interventions.service.ts');

    expect(/sendSms\(\s*['"`]\+?\d/.test(interventions)).toBe(false);
    expect(interventions.includes('21600000000')).toBe(false);
  });
});
