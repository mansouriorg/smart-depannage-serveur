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
