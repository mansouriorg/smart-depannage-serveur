import { parseTrustProxy, validateEnv } from './env';

describe('validateEnv', () => {
  const valid = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32),
    FRONTEND_URL: 'https://www.example.tn',
  };

  it('accepts a complete configuration', () => {
    expect(validateEnv({ ...valid })).toEqual(valid);
  });

  it.each(['DATABASE_URL', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'FRONTEND_URL'])(
    'refuses to start without %s',
    (name) => {
      const env: Record<string, unknown> = { ...valid };
      delete env[name];

      expect(() => validateEnv(env)).toThrow(name);
    },
  );

  it('treats blank values as missing', () => {
    expect(() => validateEnv({ ...valid, JWT_ACCESS_SECRET: '   ' })).toThrow(
      'JWT_ACCESS_SECRET',
    );
  });

  it('refuses the placeholder secrets that used to be built in', () => {
    expect(() =>
      validateEnv({ ...valid, JWT_ACCESS_SECRET: 'dev_access_secret_change_me' }),
    ).toThrow('placeholder');
    expect(() =>
      validateEnv({ ...valid, JWT_REFRESH_SECRET: 'dev_refresh_secret_change_me' }),
    ).toThrow('placeholder');
  });

  it('refuses identical access and refresh secrets', () => {
    expect(() =>
      validateEnv({ ...valid, JWT_REFRESH_SECRET: valid.JWT_ACCESS_SECRET }),
    ).toThrow('two different values');
  });

  it('requires 32 characters in production but only 16 in development', () => {
    const shortSecrets = {
      ...valid,
      JWT_ACCESS_SECRET: 'x'.repeat(20),
      JWT_REFRESH_SECRET: 'y'.repeat(20),
    };

    expect(() => validateEnv({ ...shortSecrets, NODE_ENV: 'production' })).toThrow(
      '32 characters',
    );
    expect(() => validateEnv({ ...shortSecrets, NODE_ENV: 'development' })).not.toThrow();
    expect(() =>
      validateEnv({ ...valid, JWT_ACCESS_SECRET: 'tooshort', NODE_ENV: 'development' }),
    ).toThrow('16 characters');
  });

  it('rejects a FRONTEND_URL that is not an http(s) URL', () => {
    expect(() => validateEnv({ ...valid, FRONTEND_URL: 'not a url' })).toThrow(
      'FRONTEND_URL',
    );
    expect(() => validateEnv({ ...valid, FRONTEND_URL: 'ftp://example.tn' })).toThrow(
      'http',
    );
  });

  it('reports every problem in one error', () => {
    let message = '';

    try {
      validateEnv({});
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('JWT_ACCESS_SECRET');
    expect(message).toContain('JWT_REFRESH_SECRET');
    expect(message).toContain('FRONTEND_URL');
  });
});

describe('parseTrustProxy', () => {
  it.each([undefined, '', '  ', 'false', 'FALSE', '0'])(
    'does not trust any proxy for %p',
    (value) => {
      expect(parseTrustProxy(value)).toBeUndefined();
    },
  );

  it('reads a hop count', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy(' 2 ')).toBe(2);
  });

  it('reads true', () => {
    expect(parseTrustProxy('true')).toBe(true);
  });

  it('passes subnet lists through', () => {
    expect(parseTrustProxy('loopback, 10.0.0.0/8')).toBe('loopback, 10.0.0.0/8');
  });
});
