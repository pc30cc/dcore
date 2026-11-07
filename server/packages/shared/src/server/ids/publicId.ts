import { createHmac } from 'node:crypto';

/**
 * Public ids: a user id is never sent raw. The wire names a user by
 * `base32(Feistel64_k(id))`, 13 lowercase characters: a keyed 4-round
 * Feistel permutation of the 64-bit id with HMAC-SHA256 as the round
 * function. It is reversible without a lookup, hides the sign-up time and
 * cannot be guessed. Two keys, two codecs: k1 makes the `publicUid` (JWT
 * `sub`, realtime channel), k2 the billing reference stores carry back
 * (Play `obfuscatedAccountId`, Bazaar developer payload). Neither value is
 * stored, so the keys can never be rotated.
 */

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const DECODE = new Map([...ALPHABET].map((char, index) => [char, BigInt(index)]));
const ROUNDS = 4;
const MASK32 = 0xffff_ffffn;
const MAX_ID = (1n << 63n) - 1n;
export const PUBLIC_ID_LENGTH = 13;

export class PublicIdCodec {
  private readonly key: Buffer;
  private readonly domain: string;

  /** `key`: 32 bytes. `domain` separates codecs that might one day share a key. */
  constructor(key: Uint8Array, domain: string) {
    if (key.length < 32) throw new RangeError('a public id key must be at least 32 bytes');
    this.key = Buffer.from(key);
    this.domain = domain;
  }

  private round(round: number, half: bigint): bigint {
    const input = Buffer.alloc(5);
    input.writeUInt8(round, 0);
    input.writeUInt32BE(Number(half), 1);
    const mac = createHmac('sha256', this.key).update(this.domain).update(input).digest();
    return BigInt(mac.readUInt32BE(0));
  }

  private permute(value: bigint): bigint {
    let left = (value >> 32n) & MASK32;
    let right = value & MASK32;
    for (let r = 0; r < ROUNDS; r += 1) {
      const next = left ^ this.round(r, right);
      left = right;
      right = next;
    }
    return (left << 32n) | right;
  }

  private unpermute(value: bigint): bigint {
    let left = (value >> 32n) & MASK32;
    let right = value & MASK32;
    for (let r = ROUNDS - 1; r >= 0; r -= 1) {
      const previous = right ^ this.round(r, left);
      right = left;
      left = previous;
    }
    return (left << 32n) | right;
  }

  /** The public form of an id (a positive 63-bit integer). */
  encode(id: bigint | string): string {
    const value = typeof id === 'bigint' ? id : BigInt(id);
    if (value <= 0n || value > MAX_ID) throw new RangeError('not an application id');
    let permuted = this.permute(value);
    const chars: string[] = [];
    for (let i = 0; i < PUBLIC_ID_LENGTH; i += 1) {
      chars.push(ALPHABET[Number(permuted & 31n)] ?? 'a');
      permuted >>= 5n;
    }
    return chars.reverse().join('');
  }

  /**
   * The id behind a public form, or null for anything that is not one: the
   * wrong length or alphabet, more than 64 bits, or a value whose inverse is
   * not a positive 63-bit id (about half of all random strings).
   */
  decode(publicId: string): bigint | null {
    if (publicId.length !== PUBLIC_ID_LENGTH) return null;
    let value = 0n;
    for (const char of publicId) {
      const digit = DECODE.get(char);
      if (digit === undefined) return null;
      value = (value << 5n) | digit;
    }
    // 13 characters hold 65 bits; the top one must be zero.
    if (value >> 64n !== 0n) return null;
    const id = this.unpermute(value);
    return id > 0n && id <= MAX_ID ? id : null;
  }

  /** `decode` as a decimal string, for the database driver. */
  decodeId(publicId: string): string | null {
    const id = this.decode(publicId);
    return id === null ? null : id.toString();
  }
}

export interface PublicIds {
  /** `publicUid`: the user on the wire. */
  user: PublicIdCodec;
  /** `billingRef`: what store purchases are bound to. */
  billing: PublicIdCodec;
}

/** Both codecs from `ID_PUBLIC_KEY` and `ID_BILLING_KEY` (base64url, 32 bytes each, never rotated). */
export function createPublicIds(publicKey: string, billingKey: string): PublicIds {
  const k1 = Buffer.from(publicKey, 'base64url');
  const k2 = Buffer.from(billingKey, 'base64url');
  if (k1.equals(k2)) throw new Error('ID_PUBLIC_KEY and ID_BILLING_KEY must differ');
  return { user: new PublicIdCodec(k1, 'uid'), billing: new PublicIdCodec(k2, 'billing') };
}
