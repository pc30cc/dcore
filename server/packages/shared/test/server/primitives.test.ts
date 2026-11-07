import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DataSealer,
  KeyedHasher,
  PublicIdCodec,
  SealError,
  createPublicIds,
  createServerSecrets,
  fingerprint,
  hashDomains,
  parseKeyRing,
} from '../../src/server/index.js';
import { PUBLIC_UID_PATTERN } from '../../src/index.js';

const key = () => randomBytes(32).toString('base64url');

describe('public ids', () => {
  const ids = createPublicIds(key(), key());

  it('round-trips ids and looks like the contract says', () => {
    for (const id of [1n, 2n, 112314686237569028n, (1n << 63n) - 1n]) {
      const uid = ids.user.encode(id);
      expect(uid).toMatch(PUBLIC_UID_PATTERN);
      expect(ids.user.decode(uid)).toBe(id);
      expect(ids.user.decodeId(uid)).toBe(id.toString());
    }
  });

  it('is a permutation that hides order and differs per key and domain', () => {
    const a = ids.user.encode(1000n);
    const b = ids.user.encode(1001n);
    expect(a).not.toBe(b);
    // Neighbouring ids share no long prefix.
    expect(a.slice(0, 6)).not.toBe(b.slice(0, 6));
    expect(ids.billing.encode(1000n)).not.toBe(a);
    expect(ids.billing.decode(a)).not.toBe(1000n);
    const seen = new Set<string>();
    for (let i = 1n; i <= 2_000n; i += 1n) seen.add(ids.user.encode(i));
    expect(seen.size).toBe(2_000);
  });

  it('refuses what is not a public id', () => {
    expect(ids.user.decode('')).toBeNull();
    expect(ids.user.decode('aaaaaaaaaaaa')).toBeNull();
    expect(ids.user.decode('AAAAAAAAAAAAA')).toBeNull();
    expect(ids.user.decode('1287390234923')).toBeNull();
    // A first character above `p` would need a 65th bit.
    expect(ids.user.decode('zzzzzzzzzzzzz')).toBeNull();
    expect(() => ids.user.encode(0n)).toThrow(RangeError);
    expect(() => ids.user.encode(1n << 63n)).toThrow(RangeError);
  });

  it('rejects about half of random strings (values above 63 bits)', () => {
    let valid = 0;
    const alphabet = 'abcdefghijklmnop';
    for (let i = 0; i < 2_000; i += 1) {
      const s = alphabet[i % 16]! + randomBytes(12).toString('base64url').replace(/[^a-z2-7]/g, 'a').slice(0, 12).padEnd(12, 'a');
      if (ids.user.decode(s) !== null) valid += 1;
    }
    expect(valid).toBeGreaterThan(800);
    expect(valid).toBeLessThan(1_200);
  });

  it('needs two different keys of 32 bytes', () => {
    const same = key();
    expect(() => createPublicIds(same, same)).toThrow();
    expect(() => new PublicIdCodec(new Uint8Array(16), 'x')).toThrow(RangeError);
  });
});

describe('keyed hashes', () => {
  const ring = new Map([
    [1, randomBytes(32)],
    [2, randomBytes(32)],
  ]);
  const hasher = new KeyedHasher(ring, 2);

  it('hashes per domain and pepper, and verifies in constant time', () => {
    const phone = hasher.hash(hashDomains.phone, '+989121234567');
    expect(phone.kid).toBe(2);
    expect(phone.hash).toHaveLength(32);
    expect(hasher.hash(hashDomains.google, '+989121234567').hash.equals(phone.hash)).toBe(false);
    expect(hasher.hash(hashDomains.phone, '+989121234567', 1).hash.equals(phone.hash)).toBe(false);
    expect(hasher.verify(hashDomains.phone, '+989121234567', phone)).toBe(true);
    expect(hasher.verify(hashDomains.phone, '+989121234568', phone)).toBe(false);
    expect(hasher.verify(hashDomains.phone, '+989121234567', { kid: 9, hash: phone.hash })).toBe(false);
  });

  it('lists the hash under every pepper, current first', () => {
    const all = hasher.hashAll(hashDomains.device, 'ab'.repeat(32));
    expect(all.map((h) => h.kid)).toEqual([2, 1]);
    expect(hasher.hex(hashDomains.device, 'ab'.repeat(32))).toBe(all[0]!.hash.toString('hex'));
  });

  it('reads key rings strictly and never shows a key', () => {
    expect(() => parseKeyRing('{"1":"short"}', 'HASH_PEPPERS')).toThrow(/32 bytes/);
    expect(() => parseKeyRing('[]', 'HASH_PEPPERS')).toThrow();
    expect(() => parseKeyRing('{"0":"' + key() + '"}', 'HASH_PEPPERS')).toThrow(/1-255/);
    const secret = key();
    try {
      parseKeyRing(`{"1":"${secret}x"}`, 'DATA_KEYS');
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
    expect(fingerprint('abc')).toMatch(/^[0-9a-f]{16}$/);
    expect(Object.keys(hasher.fingerprints())).toEqual(['1', '2']);
  });
});

describe('sealed values', () => {
  const masters = new Map([
    [1, randomBytes(32)],
    [3, randomBytes(32)],
  ]);
  const sealer = new DataSealer(masters, 3);

  it('opens what it sealed, in the documented layout', () => {
    const sealed = sealer.seal('+989121234567', 'auth_identities.subject_enc');
    expect(sealed[0]).toBe(3);
    expect(sealed.length).toBe(1 + 12 + '+989121234567'.length + 16);
    expect(sealer.openText(sealed, 'auth_identities.subject_enc')).toBe('+989121234567');
    expect(DataSealer.keyIdOf(sealed)).toBe(3);
    // Random nonces: the same value seals differently each time.
    expect(sealer.seal('+989121234567', 'auth_identities.subject_enc').equals(sealed)).toBe(false);
  });

  it('keeps opening values sealed under an older key', () => {
    const old = new DataSealer(masters, 1).seal('totp-secret', 'admin_users.totp_secret_enc');
    expect(sealer.openText(old, 'admin_users.totp_secret_enc')).toBe('totp-secret');
  });

  it('refuses tampering, another purpose and an unknown key', () => {
    const sealed = sealer.seal('secret', 'providers.sms');
    const flipped = Buffer.from(sealed);
    flipped[14] = (flipped[14] ?? 0) ^ 1;
    expect(() => sealer.open(flipped, 'providers.sms')).toThrow(SealError);
    expect(() => sealer.open(sealed, 'providers.fcm')).toThrow(SealError);
    const unknown = Buffer.from(sealed);
    unknown[0] = 7;
    expect(() => sealer.open(unknown, 'providers.sms')).toThrow(SealError);
    expect(() => sealer.open(Buffer.alloc(10), 'providers.sms')).toThrow(SealError);
  });

  it('is built from the environment and names a missing current key', () => {
    const peppers = JSON.stringify({ 1: key() });
    const keys = JSON.stringify({ 1: key() });
    const secrets = createServerSecrets({ hashPeppers: peppers, hashPepperKid: 1, dataKeys: keys, dataKeyId: 1 });
    expect(secrets.hasher.currentKid).toBe(1);
    expect(() => createServerSecrets({ hashPeppers: peppers, hashPepperKid: 2, dataKeys: keys, dataKeyId: 1 })).toThrow(/HASH_PEPPER_KID/);
  });
});
