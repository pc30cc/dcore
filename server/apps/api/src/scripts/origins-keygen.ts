/**
 * Makes a key pair for the signed origins document:
 *
 *   pnpm --filter @app/api origins:keygen [--kid o2]
 *   node dist/scripts/origins-keygen.js [--kid o2]        (in the API image)
 *
 * Prints the private key for the API's environment (ORIGINS_SIGNING_KEY,
 * with ORIGINS_SIGNING_KID) and the public key for brand.json
 * (`origins.publicKeys`), which the app is built with. The private key goes
 * into the deployment's secrets only: never into a file in the repository,
 * never into the app.
 *
 * Rotation: make the next pair with a new id, add its public key to
 * brand.json next to the current one (at most two), release the app with
 * both, then switch the API to the new private key and id; a later release
 * drops the old public key.
 */
import { generateOriginsKeyPair } from '@app/shared/server';
import { originsKeyIdSchema } from '@app/shared';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const kidResult = originsKeyIdSchema.safeParse(argument('--kid') ?? 'o1');
if (!kidResult.success) {
  process.stderr.write('origins-keygen: --kid must be 1-32 letters, digits, ".", "_" or "-"\n');
  process.exit(64);
}
const kid = kidResult.data;
const { privateKey, publicKey } = generateOriginsKeyPair();

process.stdout.write(
  [
    '# The API environment (a secret: never commit it, never put it in the app)',
    `ORIGINS_SIGNING_KID=${kid}`,
    `ORIGINS_SIGNING_KEY=${privateKey}`,
    '',
    '# brand.json, origins.publicKeys (public: compiled into the app)',
    JSON.stringify({ kid, key: publicKey }),
    '',
  ].join('\n'),
);
