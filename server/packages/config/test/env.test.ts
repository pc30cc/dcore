import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ConfigError,
  baseEnvShape,
  databaseEnvShape,
  envBoolean,
  envInt,
  envList,
  envUrl,
  parseEnv,
  redisEnvShape,
} from '../src/index.js';

describe('parseEnv', () => {
  const schema = z.object({
    ...baseEnvShape,
    PORT: envInt(8080, { min: 1, max: 65_535 }),
    FLAG: envBoolean(false),
    ORIGINS: envList(),
    SECRET: z.string().min(32),
  });

  it('applies defaults and treats empty values as unset', () => {
    const env = parseEnv(schema, { PORT: '', SECRET: 's'.repeat(32) });
    expect(env).toMatchObject({ NODE_ENV: 'development', LOG_LEVEL: 'info', LOG_PRETTY: false, PORT: 8080, FLAG: false, ORIGINS: [] });
  });

  it('parses booleans, integers and lists', () => {
    const env = parseEnv(schema, { PORT: '9000', FLAG: 'YES', ORIGINS: ' https://a.test , ,https://b.test', SECRET: 's'.repeat(32) });
    expect(env.PORT).toBe(9000);
    expect(env.FLAG).toBe(true);
    expect(env.ORIGINS).toEqual(['https://a.test', 'https://b.test']);
  });

  it('names every bad variable without echoing its value', () => {
    let error: unknown;
    try {
      parseEnv(schema, { PORT: '70000', FLAG: 'maybe', SECRET: 'hunter2-is-not-long-enough' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const configError = error as ConfigError;
    expect(configError.issues.map((issue) => issue.variable).sort()).toEqual(['FLAG', 'PORT', 'SECRET']);
    expect(configError.message).not.toContain('hunter2');
    expect(configError.message).not.toContain('maybe');
  });

  it('checks URL schemes', () => {
    const urls = z.object({ ...databaseEnvShape, ...redisEnvShape });
    expect(() => parseEnv(urls, { DATABASE_URL: 'mysql://x/y', REDIS_URL: 'redis://localhost:6379' })).toThrow(ConfigError);
    const ok = parseEnv(urls, { DATABASE_URL: 'postgres://u:p@localhost:5432/db', REDIS_URL: 'rediss://cache:6380/1' });
    expect(ok).toMatchObject({ DATABASE_TARGET: 'postgres', DATABASE_POOL_MAX: 10, REDIS_KEY_PREFIX: 'app:' });
    expect(envUrl(['https']).safeParse('http://insecure.test').success).toBe(false);
  });
});
