/**
 * Creates the first owner of the admin panel:
 *
 *   pnpm --filter @app/api admin:create --email owner@example.com --name "Owner" [--force-reset]
 *   node dist/scripts/admin-create.js --email owner@example.com --name "Owner"   (in the API image)
 *
 * Reads DATABASE_URL (and DATABASE_TARGET), DATA_KEYS and DATA_KEY_ID (the TOTP secret is sealed
 * like every stored secret), BRAND and BRANDS_DIR (the name authenticator
 * apps show), and ADMIN_BOOTSTRAP_PASSWORD when set (otherwise a password is
 * made). Prints the password it made and the TOTP enrolment URI once; nothing
 * else keeps them in clear. With REDIS_URL (and REDIS_KEY_PREFIX) set, the
 * access tokens of sessions a reset revokes stop at once.
 *
 * Refuses while an enabled owner exists, unless --force-reset (see
 * src/admin/bootstrap.ts). Exit codes: 0 done, 64 usage, 65 refused, 1 error.
 */
import { loadBrand } from '@app/config';
import { activeBrandAppName, createPool } from '@app/db';
import { DataSealer, DenyList, createKeys, parseKeyRing } from '@app/shared/server';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { BootstrapError, bootstrapOwner } from '../admin/bootstrap.js';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message: string, code: number): never {
  process.stderr.write(`admin-create: ${message}\n`);
  process.exit(code);
}

const env = z
  .object({
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL'),
    DATABASE_TARGET: z.enum(['postgres', 'pgbouncer']).default('postgres'),
    DATA_KEYS: z.string().min(1),
    DATA_KEY_ID: z.coerce.number().int().min(1).max(255).default(1),
    BRAND: z.string().optional(),
    BRANDS_DIR: z.string().optional(),
    ADMIN_BOOTSTRAP_PASSWORD: z.string().min(1).optional(),
    REDIS_URL: z.string().regex(/^rediss?:\/\//).optional(),
    REDIS_KEY_PREFIX: z.string().default('app:'),
    AUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
    AUTH_CLOCK_SKEW_SECONDS: z.coerce.number().int().min(0).max(300).default(30),
  })
  .safeParse(process.env);
if (!env.success) fail(`environment: ${env.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`, 64);

const email = argument('--email');
const name = argument('--name');
if (!email || !name || process.argv.includes('--help')) {
  fail('usage: admin-create --email <e-mail> --name <display name> [--force-reset]', 64);
}

let sealer: DataSealer;
try {
  sealer = new DataSealer(parseKeyRing(env.data.DATA_KEYS, 'DATA_KEYS'), env.data.DATA_KEY_ID);
} catch (error) {
  fail(error instanceof Error ? error.message : 'DATA_KEYS is not a key ring', 64);
}

const pool = createPool({ connectionString: env.data.DATABASE_URL, target: env.data.DATABASE_TARGET, applicationName: 'admin-create', max: 1 });
try {
  const brand = loadBrand({ brandId: env.data.BRAND, brandsDir: env.data.BRANDS_DIR });
  const issuer = (await activeBrandAppName(pool)) ?? brand.appName;
  const result = await bootstrapOwner({
    pool,
    sealer,
    email,
    displayName: name,
    password: env.data.ADMIN_BOOTSTRAP_PASSWORD,
    forceReset: process.argv.includes('--force-reset'),
    issuer,
  });
  if (result.revokedSessions.length > 0 && env.data.REDIS_URL) {
    const redis = new Redis(env.data.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 2_000 });
    try {
      await redis.connect();
      const deny = new DenyList({
        redis,
        keys: createKeys(env.data.REDIS_KEY_PREFIX),
        accessTokenTtlSeconds: env.data.AUTH_ACCESS_TOKEN_TTL_SECONDS,
        clockSkewSeconds: env.data.AUTH_CLOCK_SKEW_SECONDS,
      });
      for (const sid of result.revokedSessions) await deny.revokeSession(sid);
    } catch (error) {
      process.stderr.write(`admin-create: the revoked sessions' access tokens run out on their own (Valkey: ${error instanceof Error ? error.message : 'unreachable'})\n`);
    } finally {
      redis.disconnect();
    }
  }
  process.stdout.write(
    [
      `${result.created ? 'Owner created' : 'Owner reset'}: ${result.email} (admin id ${result.adminId})`,
      ...(result.generatedPassword ? [`Password (shown once; change it in the panel): ${result.generatedPassword}`] : []),
      ...(result.revokedSessions.length > 0 ? [`Signed out of ${result.revokedSessions.length} session(s).`] : []),
      '',
      'TOTP, shown once: add it to an authenticator app (scan the URI as a QR code, or type the secret),',
      'then sign in to the panel with the e-mail and password and give the first code.',
      result.otpauthUri,
      `Secret: ${result.secret}`,
      '',
    ].join('\n'),
  );
} catch (error) {
  if (error instanceof BootstrapError) fail(error.message, error.exitCode);
  fail(error instanceof Error ? error.message : String(error), 1);
} finally {
  await pool.end();
}
