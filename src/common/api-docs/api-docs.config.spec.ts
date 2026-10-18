import * as fs from 'fs';
import * as path from 'path';
import { apiDocsEnabled } from './api-docs.config';

const read = (...parts: string[]) => fs.readFileSync(path.join(__dirname, '..', '..', '..', ...parts), 'utf8');

describe('apiDocsEnabled (P1-09)', () => {
  it('is on outside production, unless API_DOCS=false', () => {
    expect(apiDocsEnabled({})).toBe(true);
    expect(apiDocsEnabled({ NODE_ENV: 'development' })).toBe(true);
    expect(apiDocsEnabled({ NODE_ENV: 'test' })).toBe(true);
    expect(apiDocsEnabled({ NODE_ENV: 'development', API_DOCS: 'false' })).toBe(false);
    expect(apiDocsEnabled({ API_DOCS: ' FALSE ' })).toBe(false);
  });

  it('is off in production, unless API_DOCS=true was set on purpose', () => {
    expect(apiDocsEnabled({ NODE_ENV: 'production' })).toBe(false);
    expect(apiDocsEnabled({ NODE_ENV: 'Production' })).toBe(false);
    expect(apiDocsEnabled({ NODE_ENV: 'production', API_DOCS: '' })).toBe(false);
    expect(apiDocsEnabled({ NODE_ENV: 'production', API_DOCS: 'yes' })).toBe(false);
    expect(apiDocsEnabled({ NODE_ENV: 'production', API_DOCS: '1' })).toBe(false);
    expect(apiDocsEnabled({ NODE_ENV: 'production', API_DOCS: 'true' })).toBe(true);
    expect(apiDocsEnabled({ NODE_ENV: ' production ', API_DOCS: ' True ' })).toBe(true);
  });

  it('a server whose NODE_ENV was forgotten counts as a development one (main.ts warns about it at start)', () => {
    expect(apiDocsEnabled({ NODE_ENV: '' })).toBe(true);
    expect(apiDocsEnabled({ NODE_ENV: undefined })).toBe(true);
  });

  it('ignores values that are not text', () => {
    expect(apiDocsEnabled({ NODE_ENV: 'production', API_DOCS: true })).toBe(true);
    expect(apiDocsEnabled({ NODE_ENV: 'production', API_DOCS: undefined })).toBe(false);
    expect(apiDocsEnabled({ API_DOCS: null })).toBe(true);
  });
});

describe('the documentation wiring (P1-09)', () => {
  it('the config file imports nothing, so tests run without the documentation library', () => {
    expect(read('src', 'common', 'api-docs', 'api-docs.config.ts')).not.toMatch(/^\s*import\s/m);
  });

  it('main.ts serves the page only when apiDocsEnabled says yes (not "no"), after the global prefix', () => {
    const main = read('src', 'main.ts');
    const call = main.indexOf('setupApiDocs(app)');

    expect(call).toBeGreaterThan(-1);
    expect(main.split('setupApiDocs(app)')).toHaveLength(2);
    expect(main).toMatch(/if \(apiDocsEnabled\(process\.env\)\) \{\s*setupApiDocs\(app\);\s*\}/);
    expect(main).not.toMatch(/!\s*apiDocsEnabled/);
    expect(call).toBeGreaterThan(main.indexOf("app.setGlobalPrefix('api')"));
  });

  it('the Nest CLI plugin reads the DTOs, and the library is a dependency', () => {
    const cli = JSON.parse(read('nest-cli.json'));
    const pkg = JSON.parse(read('package.json'));
    const plugins = (cli.compilerOptions.plugins ?? []) as Array<string | { name: string }>;

    expect(plugins.map((plugin) => (typeof plugin === 'string' ? plugin : plugin.name))).toContain('@nestjs/swagger');
    expect(pkg.dependencies['@nestjs/swagger']).toBeDefined();
  });
});
