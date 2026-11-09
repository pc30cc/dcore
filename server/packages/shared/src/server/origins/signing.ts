import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import {
  ORIGINS_ALGORITHM,
  originsDocumentSchema,
  originsKeyIdSchema,
  originsSigningInput,
  readOriginsPayload,
  type OriginsDocument,
  type OriginsPayload,
} from '../../api/origins.js';

/**
 * Ed25519 keys and signatures of the origins document. Keys travel as raw
 * bytes in base64url: the private key as its 32-byte seed
 * (`ORIGINS_SIGNING_KEY`), the public key as its 32 bytes (brand.json
 * `origins.publicKeys`, compiled into the app). Ed25519 signatures are
 * deterministic: the same key and payload always give the same document.
 */

// DER of PKCS #8 and SPKI around a raw Ed25519 key (RFC 8410).
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const RAW_KEY = /^[A-Za-z0-9_-]{43}$/;

export class OriginsKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OriginsKeyError';
  }
}

function raw32(text: string, what: string): Buffer {
  const value = text.trim();
  if (!RAW_KEY.test(value)) throw new OriginsKeyError(`${what} must be 32 bytes in base64url (43 characters)`);
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== value) throw new OriginsKeyError(`${what} must be 32 bytes in base64url (43 characters)`);
  return bytes;
}

/** The private key of a 32-byte seed (base64url). The message never contains the key. */
export function originsPrivateKey(seed: string): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw32(seed, 'the signing key')]), format: 'der', type: 'pkcs8' });
}

/** A public key from its 32 bytes (base64url). */
export function originsPublicKey(publicKey: string): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw32(publicKey, 'the public key')]), format: 'der', type: 'spki' });
}

/** The 32 public bytes (base64url) of a key. */
export function rawPublicKey(key: KeyObject): string {
  const der = (key.type === 'private' ? createPublicKey(key) : key).export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - 32).toString('base64url');
}

/** A fresh key pair: the seed for `ORIGINS_SIGNING_KEY` and the public key for brand.json. */
export function generateOriginsKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey } = generateKeyPairSync('ed25519');
  const der = privateKey.export({ format: 'der', type: 'pkcs8' });
  return { privateKey: der.subarray(der.length - 32).toString('base64url'), publicKey: rawPublicKey(privateKey) };
}

export class OriginsSigner {
  readonly kid: string;
  /** The public key apps verify with (base64url, 32 bytes). */
  readonly publicKey: string;
  private readonly key: KeyObject;

  constructor(kid: string, seed: string) {
    this.kid = originsKeyIdSchema.parse(kid);
    this.key = originsPrivateKey(seed);
    this.publicKey = rawPublicKey(this.key);
  }

  sign(payload: OriginsPayload): OriginsDocument {
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const sig = sign(null, originsSigningInput(encoded), this.key).toString('base64url');
    return { alg: ORIGINS_ALGORITHM, kid: this.kid, payload: encoded, sig };
  }
}

export type OriginsRefusal = 'malformed' | 'unknown_key' | 'bad_signature' | 'wrong_brand' | 'not_yet_valid' | 'expired';

export class OriginsDocumentError extends Error {
  readonly reason: OriginsRefusal;

  constructor(reason: OriginsRefusal, message: string) {
    super(message);
    this.name = 'OriginsDocumentError';
    this.reason = reason;
  }
}

export interface OriginsTrust {
  /** The accepted public keys by id (base64url): the one in use and, during a rotation, the next. */
  keys: readonly { kid: string; key: string }[];
  /** The brand the document must name. */
  brand?: string | undefined;
  now?: Date | undefined;
  /** How far `issuedAt` may lie ahead of `now` (a clock running behind). */
  skewMs?: number | undefined;
}

/**
 * Checks a document the way an app does: its shape, a known key id, the
 * signature over the text as received, then the payload (its schema, the
 * brand, `issuedAt` not in the future beyond the skew, `expiresAt` not
 * passed). Throws {@link OriginsDocumentError} with the reason.
 */
export function verifyOriginsDocument(input: unknown, trust: OriginsTrust): OriginsPayload {
  const parsed = originsDocumentSchema.safeParse(input);
  if (!parsed.success) throw new OriginsDocumentError('malformed', 'not an origins document');
  const document = parsed.data;
  const entry = trust.keys.find((key) => key.kid === document.kid);
  if (!entry) throw new OriginsDocumentError('unknown_key', `no trusted key named "${document.kid}"`);
  let valid: boolean;
  try {
    valid = verify(null, originsSigningInput(document.payload), originsPublicKey(entry.key), Buffer.from(document.sig, 'base64url'));
  } catch {
    valid = false;
  }
  if (!valid) throw new OriginsDocumentError('bad_signature', 'the signature does not match');
  let payload: OriginsPayload;
  try {
    payload = readOriginsPayload(document);
  } catch (error) {
    throw new OriginsDocumentError('malformed', error instanceof z.ZodError ? 'the payload does not match its schema' : 'the payload is not JSON');
  }
  if (trust.brand !== undefined && payload.brand !== trust.brand) throw new OriginsDocumentError('wrong_brand', 'the document is for another brand');
  const now = (trust.now ?? new Date()).getTime();
  const issuedAt = Date.parse(payload.issuedAt);
  const expiresAt = Date.parse(payload.expiresAt);
  if (expiresAt <= issuedAt) throw new OriginsDocumentError('malformed', 'the document expires before it was issued');
  if (issuedAt > now + (trust.skewMs ?? 24 * 3_600_000)) throw new OriginsDocumentError('not_yet_valid', 'the document was issued in the future');
  if (expiresAt <= now) throw new OriginsDocumentError('expired', 'the document has expired');
  return payload;
}

/** Orders two documents as apps do: by version, then by when they were issued. */
export function compareOrigins(a: Pick<OriginsPayload, 'version' | 'issuedAt'>, b: Pick<OriginsPayload, 'version' | 'issuedAt'>): number {
  if (a.version !== b.version) return a.version < b.version ? -1 : 1;
  const ta = Date.parse(a.issuedAt);
  const tb = Date.parse(b.issuedAt);
  return ta === tb ? 0 : ta < tb ? -1 : 1;
}
