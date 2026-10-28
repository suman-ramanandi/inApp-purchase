import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.ts';

const validEnv = {
  DATABASE_URL: 'postgres://app:not-a-real-password@localhost:5432/inapp',
};

describe('loadConfig', () => {
  it('applies defaults for optional variables', () => {
    expect(loadConfig(validEnv)).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'info',
      DATABASE_URL: validEnv.DATABASE_URL,
    });
  });

  it('coerces PORT from a string', () => {
    expect(loadConfig({ ...validEnv, PORT: '8080' }).PORT).toBe(8080);
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() => loadConfig({ DATABASE_URL: 'mysql://u:p@localhost/db' })).toThrow(/DATABASE_URL/);
  });

  it('never includes variable values in the error message', () => {
    const secret = 'super-secret-value';
    const env = { DATABASE_URL: `mysql://u:${secret}@localhost/db`, PORT: secret };

    expect(() => loadConfig(env)).toThrow(ConfigError);
    try {
      loadConfig(env);
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });
});
