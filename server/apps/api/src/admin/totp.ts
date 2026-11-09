import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238 over RFC 4226 HOTP): HMAC-SHA-1, 6 digits, 30-second
 * steps, accepted one step either side of now. Only steps after the last
 * one that signed in are accepted, so a code (or an older one) never works
 * twice. Secrets are 20 random bytes (RFC 4226's recommended length), given
 * to the authenticator app as base32 (RFC 4648, no padding).
 */

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_WINDOW = 1;
export const TOTP_SECRET_BYTES = 20;
/** The sealing purpose of `admin_users.totp_secret_enc` (AES-256-GCM under DATA_KEYS). */
export const TOTP_SECRET_PURPOSE = 'admin_users.totp_secret_enc';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/=+$/, '').toUpperCase();
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const value = BASE32.indexOf(ch);
    if (value < 0) throw new TypeError('not base32');
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES);
}

/** The time step of `atMs`. */
export function totpStep(atMs: number): number {
  return Math.floor(atMs / 1_000 / TOTP_PERIOD_SECONDS);
}

/** The HOTP value of `counter` (RFC 4226 §5.3), `digits` long. */
export function hotp(secret: Uint8Array, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function totpAt(secret: Uint8Array, atMs: number, digits = TOTP_DIGITS): string {
  return hotp(secret, totpStep(atMs), digits);
}

export type TotpCheck = { ok: true; step: number } | { ok: false; replayed: boolean };

/**
 * Checks `code` against the steps around `nowMs`. A code that matches a
 * step at or before `lastStep` is refused as a replay. Every step of the
 * window is compared (constant time each), whatever matched first.
 */
export function checkTotp(secret: Uint8Array, code: string, nowMs: number, lastStep: number | null): TotpCheck {
  const given = Buffer.from(code.padStart(TOTP_DIGITS, ' ').slice(0, TOTP_DIGITS), 'utf8');
  const now = totpStep(nowMs);
  let matched: number | null = null;
  for (let delta = -TOTP_WINDOW; delta <= TOTP_WINDOW; delta += 1) {
    const step = now + delta;
    if (step < 0) continue;
    const expected = Buffer.from(hotp(secret, step), 'utf8');
    if (timingSafeEqual(expected, given) && (matched === null || step > matched)) matched = step;
  }
  if (matched === null) return { ok: false, replayed: false };
  if (lastStep !== null && matched <= lastStep) return { ok: false, replayed: true };
  return { ok: true, step: matched };
}

/** The `otpauth://` URI authenticator apps read from a QR code (Key Uri Format). */
export function otpauthUri(issuer: string, account: string, secret: Uint8Array): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString().replaceAll('+', '%20')}`;
}
