import { z } from 'zod';

export type Env = Readonly<Record<string, string | undefined>>;

export interface ConfigIssue {
  variable: string;
  message: string;
}

/**
 * Thrown when the environment does not match the schema. The message names
 * each variable and what is wrong with it, never the value: values may be
 * secrets and error messages end up in logs.
 */
export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(
      `Invalid configuration:\n${issues.map((issue) => `  - ${issue.variable}: ${issue.message}`).join('\n')}`,
    );
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/**
 * Parses the environment with a zod schema. An empty value (`FOO=` in a .env
 * file) counts as unset, so defaults apply to it.
 */
export function parseEnv<S extends z.ZodType>(schema: S, env: Env = process.env): z.output<S> {
  const input: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== '') input[key] = value;
  }
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new ConfigError(
    result.error.issues.map((issue) => ({
      variable: issue.path.length > 0 ? issue.path.map(String).join('.') : '(environment)',
      // zod's messages describe the expectation; for enums and literals they
      // may quote allowed values, never the received one.
      message: issue.message,
    })),
  );
}

const TRUE = new Set(['true', '1', 'yes', 'on']);
const FALSE = new Set(['false', '0', 'no', 'off']);

/** `true`/`false` (also 1/0, yes/no, on/off). */
export function envBoolean(defaultValue: boolean) {
  return z
    .string()
    .trim()
    .toLowerCase()
    .refine((value) => TRUE.has(value) || FALSE.has(value), 'must be true or false')
    .transform((value) => TRUE.has(value))
    .prefault(defaultValue ? 'true' : 'false');
}

export interface IntOptions {
  min?: number;
  max?: number;
}

/** An integer with bounds, e.g. a port or a timeout in milliseconds. */
export function envInt(defaultValue: number | undefined, { min = 0, max = Number.MAX_SAFE_INTEGER }: IntOptions = {}) {
  const base = z
    .string()
    .trim()
    .regex(/^-?\d+$/, 'must be an integer')
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));
  return defaultValue === undefined ? base : base.prefault(String(defaultValue));
}

/** A comma-separated list; blanks are dropped. */
export function envList(defaultValue: readonly string[] = []) {
  return z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    )
    .prefault(defaultValue.join(','));
}

/** A URL whose scheme is one of `protocols` (without the colon). */
export function envUrl(protocols: readonly string[]) {
  const pattern = new RegExp(`^(${protocols.map((p) => p.replace(/[^a-z0-9+.-]/g, '')).join('|')})$`);
  return z.url({ protocol: pattern, error: `must be a ${protocols.join(' or ')} URL` });
}

export const nodeEnvSchema = z.enum(['development', 'test', 'production']).default('development');
export const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info');

/** Variables every server process reads. */
export const baseEnvShape = {
  NODE_ENV: nodeEnvSchema,
  LOG_LEVEL: logLevelSchema,
  /** Human-readable logs for a terminal; keep it off in production (JSON lines). */
  LOG_PRETTY: envBoolean(false),
};

/** Variables of a process that talks to PostgreSQL through the pool. */
export const databaseEnvShape = {
  DATABASE_URL: envUrl(['postgres', 'postgresql']),
  /**
   * `postgres`: a direct connection (or PgBouncer in session mode), which gets
   * its timeouts as startup parameters. `pgbouncer`: PgBouncer in transaction
   * mode, which refuses those parameters; the timeouts then come from the
   * role (`ALTER ROLE ... SET`) or from PgBouncer.
   */
  DATABASE_TARGET: z.enum(['postgres', 'pgbouncer']).default('postgres'),
  DATABASE_POOL_MAX: envInt(10, { min: 1, max: 200 }),
  DATABASE_STATEMENT_TIMEOUT_MS: envInt(5_000, { min: 0, max: 600_000 }),
  DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: envInt(10_000, { min: 0, max: 600_000 }),
  DATABASE_CONNECT_TIMEOUT_MS: envInt(3_000, { min: 100, max: 60_000 }),
};

/** Variables of a process that talks to Redis or Valkey. */
export const redisEnvShape = {
  REDIS_URL: envUrl(['redis', 'rediss']),
  /** Prefixes every key, so several environments can share one instance safely. */
  REDIS_KEY_PREFIX: z
    .string()
    .regex(/^[a-z0-9][a-z0-9:_-]{0,31}:$/, 'must be lowercase and end with ":"')
    .default('app:'),
};
