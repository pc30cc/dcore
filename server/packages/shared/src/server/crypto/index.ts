import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Keyed hashes and sealed values.
 *
 * Keyed hashes (HMAC-SHA256 under a pepper) are what sign-in, bans and
 * device lookups search by: a database dump yields no phone number, Google
 * account or device id, and no way to test a guess. Each hash is stored with
 * the id of the pepper that made it (`hash_kid`), so peppers can be added;
 * a lookup tries the current pepper first and the older ones after.
 *
 * Sealed values (AES-256-GCM) keep what must be read back: phone numbers,
 * TOTP secrets, provider credentials. The stored form is
 * `kid (1 byte) || nonce (12) || ciphertext || tag (16)`, as migration 0002
 * documents. The key of a value is derived from the master key `kid`
 * (`DATA_KEYS`) and the value's purpose with HKDF-SHA256, and the purpose is
 * also the GCM additional data: a value sealed for one column does not open
 * as another's, and no purpose key reveals the master key.
 */

export type KeyId = number;

/** `{"1": "<base64url, 32 bytes>"}` as the environment carries it. */
export function parseKeyRing(json: string, name: string): Map<KeyId, Buffer> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`${name} must be a JSON object of key id to base64url key`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object of key id to base64url key`);
  }
  const ring = new Map<KeyId, Buffer>();
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    const kid = Number(id);
    if (!Number.isInteger(kid) || kid < 1 || kid > 255) throw new Error(`${name}: key id "${id}" must be 1-255`);
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${name}: key ${id} must be base64url`);
    const key = Buffer.from(value, 'base64url');
    if (key.length !== 32) throw new Error(`${name}: key ${id} must be 32 bytes`);
    ring.set(kid, key);
  }
  if (ring.size === 0) throw new Error(`${name} holds no key`);
  return ring;
}

/** A short name for a secret that logs and the admin panel can show: never the secret. */
export function fingerprint(secret: Uint8Array | string): string {
  return createHash('sha256').update('fingerprint:').update(secret).digest('hex').slice(0, 16);
}

export function sha256(value: Uint8Array | string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Random bytes as base64url (no padding): tokens, nonces, challenge ids. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time equality of two byte strings of any length. */
export function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** What a keyed hash is of; the label keeps hashes of different things apart. */
export const hashDomains = {
  /** auth_identities.subject_hash (provider 1) and device_bans kind 2: the E.164 number. */
  phone: '1',
  /** auth_identities.subject_hash (provider 2) and device_bans kind 3: Google's `sub`. */
  google: '2',
  /** devices.fingerprint_hash and device_bans kind 1: the app's device key. */
  device: 'device',
  /** An OTP code, bound to its challenge. */
  otp: 'otp',
} as const;
export type HashDomain = (typeof hashDomains)[keyof typeof hashDomains];

export interface KeyedHash {
  kid: KeyId;
  hash: Buffer;
}

export class KeyedHasher {
  private readonly peppers: ReadonlyMap<KeyId, Buffer>;
  readonly currentKid: KeyId;

  constructor(peppers: ReadonlyMap<KeyId, Buffer>, currentKid: KeyId) {
    if (!peppers.has(currentKid)) throw new Error(`HASH_PEPPER_KID ${currentKid} is not in HASH_PEPPERS`);
    this.peppers = peppers;
    this.currentKid = currentKid;
  }

  /** HMAC-SHA256(pepper[kid], domain || ':' || value): the form 0002 documents for subject_hash. */
  hash(domain: HashDomain, value: string, kid: KeyId = this.currentKid): KeyedHash {
    const pepper = this.peppers.get(kid);
    if (!pepper) throw new Error(`no pepper ${kid}`);
    return { kid, hash: createHmac('sha256', pepper).update(`${domain}:${value}`).digest() };
  }

  /** The hash under every pepper, current first: what a lookup during a pepper change searches for. */
  hashAll(domain: HashDomain, value: string): KeyedHash[] {
    const kids = [this.currentKid, ...[...this.peppers.keys()].filter((kid) => kid !== this.currentKid)];
    return kids.map((kid) => this.hash(domain, value, kid));
  }

  /** The current hash as lowercase hex, for Valkey key names (`otp:<phoneHash>`). */
  hex(domain: HashDomain, value: string): string {
    return this.hash(domain, value).hash.toString('hex');
  }

  /** Checks a value against a stored hash made under `kid`, in constant time. */
  verify(domain: HashDomain, value: string, stored: KeyedHash): boolean {
    if (!this.peppers.has(stored.kid)) return false;
    return safeEqual(this.hash(domain, value, stored.kid).hash, stored.hash);
  }

  fingerprints(): Record<string, string> {
    return Object.fromEntries([...this.peppers].map(([kid, key]) => [String(kid), fingerprint(key)]));
  }
}

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class SealError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SealError';
  }
}

export class DataSealer {
  private readonly masters: ReadonlyMap<KeyId, Buffer>;
  readonly currentKid: KeyId;
  private readonly derived = new Map<string, Buffer>();

  constructor(masters: ReadonlyMap<KeyId, Buffer>, currentKid: KeyId) {
    if (!masters.has(currentKid)) throw new Error(`DATA_KEY_ID ${currentKid} is not in DATA_KEYS`);
    this.masters = masters;
    this.currentKid = currentKid;
  }

  private key(kid: KeyId, purpose: string): Buffer {
    const cacheKey = `${kid}:${purpose}`;
    let key = this.derived.get(cacheKey);
    if (key === undefined) {
      const master = this.masters.get(kid);
      if (!master) throw new SealError(`no data key ${kid}`);
      key = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), `seal:${purpose}`, 32));
      this.derived.set(cacheKey, key);
    }
    return key;
  }

  /** Seals `plaintext` for `purpose` (e.g. `auth_identities.subject_enc`) under the current key. */
  seal(plaintext: Uint8Array | string, purpose: string): Buffer {
    if (purpose.length === 0) throw new TypeError('a sealed value needs a purpose');
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key(this.currentKid, purpose), nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(purpose));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([Buffer.from([this.currentKid]), nonce, body, cipher.getAuthTag()]);
  }

  /** Opens a sealed value; throws {@link SealError} when it was tampered with, sealed for another purpose or under an unknown key. */
  open(sealed: Uint8Array, purpose: string): Buffer {
    const value = Buffer.from(sealed);
    if (value.length < 1 + NONCE_BYTES + TAG_BYTES) throw new SealError('sealed value too short');
    const kid = value[0] ?? 0;
    const nonce = value.subarray(1, 1 + NONCE_BYTES);
    const tag = value.subarray(value.length - TAG_BYTES);
    const body = value.subarray(1 + NONCE_BYTES, value.length - TAG_BYTES);
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key(kid, purpose), nonce, { authTagLength: TAG_BYTES });
      decipher.setAAD(Buffer.from(purpose));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]);
    } catch (error) {
      if (error instanceof SealError) throw error;
      throw new SealError('sealed value does not open', { cause: error });
    }
  }

  openText(sealed: Uint8Array, purpose: string): string {
    return this.open(sealed, purpose).toString('utf8');
  }

  /** The key id a sealed value was made under (to find values to re-seal after a key change). */
  static keyIdOf(sealed: Uint8Array): KeyId {
    if (sealed.length === 0) throw new SealError('empty sealed value');
    return sealed[0] ?? 0;
  }

  fingerprints(): Record<string, string> {
    return Object.fromEntries([...this.masters].map(([kid, key]) => [String(kid), fingerprint(key)]));
  }
}

export interface ServerSecrets {
  hasher: KeyedHasher;
  sealer: DataSealer;
}

/** The hasher and sealer from `HASH_PEPPERS`/`HASH_PEPPER_KID` and `DATA_KEYS`/`DATA_KEY_ID`. */
export function createServerSecrets(env: {
  hashPeppers: string;
  hashPepperKid: number;
  dataKeys: string;
  dataKeyId: number;
}): ServerSecrets {
  return {
    hasher: new KeyedHasher(parseKeyRing(env.hashPeppers, 'HASH_PEPPERS'), env.hashPepperKid),
    sealer: new DataSealer(parseKeyRing(env.dataKeys, 'DATA_KEYS'), env.dataKeyId),
  };
}
