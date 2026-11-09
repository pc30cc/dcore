import { argon2, randomBytes, timingSafeEqual, type Argon2Parameters } from 'node:crypto';
import { ADMIN_PASSWORD_MAX, ADMIN_PASSWORD_MIN } from '@app/shared';

/**
 * Admin passwords: Argon2id (RFC 9106) through Node's own `crypto.argon2`
 * (OpenSSL's implementation, in Node since 24.7: no native add-on to build
 * on Alpine and nothing to fetch at install), stored as the PHC string
 * `$argon2id$v=19$m=<KiB>,t=<passes>,p=<lanes>$<salt>$<tag>` (base64 without
 * padding). The tag is compared in constant time.
 *
 * The parameters are RFC 9106's second recommendation (64 MiB, 3 passes,
 * 4 lanes); a stored hash names its own, so they can be raised later and a
 * sign-in rehashes an older one.
 */

export interface Argon2Params {
  /** KiB. */
  memory: number;
  passes: number;
  parallelism: number;
}

export const DEFAULT_ARGON2: Argon2Params = { memory: 65_536, passes: 3, parallelism: 4 };

const SALT_BYTES = 16;
const TAG_BYTES = 32;
const PHC = /^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,3}),p=(\d{1,2})\$([A-Za-z0-9+/]{16,88})\$([A-Za-z0-9+/]{16,88})$/;

if (typeof argon2 !== 'function') {
  throw new Error('crypto.argon2 is missing: Node 24.7 or later is required');
}

/** The form a password is hashed in: NFKC, so the same characters typed on another keyboard match. */
export function normalizePassword(password: string): string {
  return password.normalize('NFKC');
}

export type PasswordProblem = 'too_short' | 'too_long' | 'is_email';

/** The policy: 12 to 128 characters (code points, after NFKC) and not the e-mail address itself. */
export function passwordProblem(password: string, email?: string): PasswordProblem | null {
  const normalized = normalizePassword(password);
  const length = [...normalized].length;
  if (length < ADMIN_PASSWORD_MIN) return 'too_short';
  if (length > ADMIN_PASSWORD_MAX) return 'too_long';
  if (normalized.trim().toLowerCase() === email?.trim().toLowerCase()) return 'is_email';
  return null;
}

export const PASSWORD_PROBLEM_TEXT: Readonly<Record<PasswordProblem, string>> = {
  too_short: `The password needs at least ${ADMIN_PASSWORD_MIN} characters.`,
  too_long: `The password may have at most ${ADMIN_PASSWORD_MAX} characters.`,
  is_email: 'The password may not be the e-mail address.',
};

function derive(password: string, salt: Buffer, params: Argon2Params): Promise<Buffer> {
  const options: Argon2Parameters = {
    message: Buffer.from(normalizePassword(password), 'utf8'),
    nonce: salt,
    parallelism: params.parallelism,
    tagLength: TAG_BYTES,
    memory: params.memory,
    passes: params.passes,
  };
  return new Promise((resolve, reject) => {
    argon2('argon2id', options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

const b64 = (bytes: Buffer) => bytes.toString('base64').replace(/=+$/, '');

export async function hashPassword(password: string, params: Argon2Params = DEFAULT_ARGON2): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const tag = await derive(password, salt, params);
  return `$argon2id$v=19$m=${params.memory},t=${params.passes},p=${params.parallelism}$${b64(salt)}$${b64(tag)}`;
}

interface ParsedHash {
  params: Argon2Params;
  salt: Buffer;
  tag: Buffer;
}

function parseHash(stored: string): ParsedHash | null {
  const match = PHC.exec(stored);
  if (!match) return null;
  const [, m, t, p, salt, tag] = match;
  const params = { memory: Number(m), passes: Number(t), parallelism: Number(p) };
  // Bounds a stored value can carry: a tampered row must not make a sign-in allocate gigabytes.
  if (params.memory < 8 * params.parallelism || params.memory > 1_048_576 || params.passes < 1 || params.parallelism < 1) return null;
  return { params, salt: Buffer.from(salt!, 'base64'), tag: Buffer.from(tag!, 'base64') };
}

/** Whether `password` matches `stored`; false for a value that is not an Argon2id PHC string. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  const tag = await derive(password, parsed.salt, parsed.params);
  return tag.length === parsed.tag.length && timingSafeEqual(tag, parsed.tag);
}

/** Whether a stored hash was made with other parameters than `params` (a sign-in then stores a new one). */
export function needsRehash(stored: string, params: Argon2Params = DEFAULT_ARGON2): boolean {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  return (
    parsed.params.memory !== params.memory ||
    parsed.params.passes !== params.passes ||
    parsed.params.parallelism !== params.parallelism ||
    parsed.tag.length !== TAG_BYTES
  );
}

/** A password the server makes (a new account, a reset): 24 base64url characters, 144 bits. */
export function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

/**
 * Checks a password against no account at the same cost as a real check,
 * so an unknown e-mail answers in the same time as a wrong password.
 */
export class DummyHash {
  private value: Promise<string> | null = null;
  private readonly params: Argon2Params;

  constructor(params: Argon2Params = DEFAULT_ARGON2) {
    this.params = params;
  }

  /** Makes the dummy hash now, so the first unknown e-mail costs no more than the next ones. */
  prime(): Promise<string> {
    this.value ??= hashPassword(randomBytes(16).toString('hex'), this.params);
    return this.value;
  }

  async burn(password: string): Promise<void> {
    await verifyPassword(password, await this.prime());
  }
}
