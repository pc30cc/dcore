import { OWNER_ROLE, expandGrants, grantCovers, grantsAllow, permissions } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ARGON2, generatePassword, hashPassword, needsRehash, passwordProblem, verifyPassword } from '../src/admin/password.js';
import { clearedRefreshCookie, newAdminRefreshToken, parseAdminRefreshToken, readCookie, refreshCookie } from '../src/admin/session.js';
import { base32Decode, base32Encode, checkTotp, hotp, otpauthUri, totpAt, totpStep } from '../src/admin/totp.js';
import { CHEAP_ARGON2 } from './adminSupport.js';

/**
 * The building blocks of admin sign-in, without infrastructure: TOTP against
 * RFC 6238's own test vectors, base32 against RFC 4648's, Argon2id hashes,
 * the password policy, the permission grants and the refresh cookie.
 */

// RFC 6238 Appendix B: the SHA-1 seed is the ASCII "12345678901234567890".
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const RFC_VECTORS: [seconds: number, code: string][] = [
  [59, '94287082'],
  [1_111_111_109, '07081804'],
  [1_111_111_111, '14050471'],
  [1_234_567_890, '89005924'],
  [2_000_000_000, '69279037'],
  [20_000_000_000, '65353130'],
];

describe('TOTP (RFC 6238, SHA-1, 30 s)', () => {
  it('matches the RFC test vectors (8 digits) and their 6-digit form', () => {
    for (const [seconds, expected] of RFC_VECTORS) {
      expect(hotp(RFC_SECRET, totpStep(seconds * 1_000), 8), String(seconds)).toBe(expected);
      expect(totpAt(RFC_SECRET, seconds * 1_000)).toBe(expected.slice(2));
    }
  });

  it('accepts one step either side of now, never further', () => {
    const now = 1_700_000_015_000;
    const step = totpStep(now);
    for (const delta of [-1, 0, 1]) {
      const result = checkTotp(RFC_SECRET, hotp(RFC_SECRET, step + delta), now, null);
      expect(result, `delta ${delta}`).toEqual({ ok: true, step: step + delta });
    }
    for (const delta of [-3, -2, 2, 3]) expect(checkTotp(RFC_SECRET, hotp(RFC_SECRET, step + delta), now, null).ok, `delta ${delta}`).toBe(false);
  });

  it('refuses the step that signed in last, and earlier ones, as a replay', () => {
    const now = 1_700_000_015_000;
    const step = totpStep(now);
    const current = hotp(RFC_SECRET, step);
    expect(checkTotp(RFC_SECRET, current, now, step - 1)).toEqual({ ok: true, step });
    expect(checkTotp(RFC_SECRET, current, now, step)).toEqual({ ok: false, replayed: true });
    expect(checkTotp(RFC_SECRET, hotp(RFC_SECRET, step - 1), now, step)).toEqual({ ok: false, replayed: true });
    expect(checkTotp(RFC_SECRET, hotp(RFC_SECRET, step + 1), now, step)).toEqual({ ok: true, step: step + 1 });
  });

  it('writes base32 as RFC 4648 does (no padding) and reads it back', () => {
    const vectors: [string, string][] = [['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']];
    for (const [plain, encoded] of vectors) {
      expect(base32Encode(Buffer.from(plain))).toBe(encoded);
      expect(base32Decode(encoded).toString()).toBe(plain);
    }
    expect(base32Encode(RFC_SECRET)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(() => base32Decode('A1')).toThrow(TypeError);
  });

  it('builds the otpauth URI authenticator apps read, with the issuer it is given', () => {
    const uri = otpauthUri('Some App', 'ops@example.com', RFC_SECRET);
    expect(uri).toBe('otpauth://totp/Some%20App:ops%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Some%20App&algorithm=SHA1&digits=6&period=30');
  });
});

describe('admin passwords (Argon2id)', () => {
  it('stores a PHC string with the parameters and checks it in both directions', async () => {
    const hash = await hashPassword('correct horse battery staple', CHEAP_ARGON2);
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=1024,t=1,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('correct horse battery stapl', hash)).toBe(false);
    expect(await verifyPassword('correct horse battery staple', hash.replace('$argon2id$', '$argon2i$'))).toBe(false);
    // Two hashes of one password differ (a fresh salt each time).
    expect(await hashPassword('correct horse battery staple', CHEAP_ARGON2)).not.toBe(hash);
  });

  it('hashes with RFC 9106 second recommendation by default and says when a hash is older', async () => {
    expect(DEFAULT_ARGON2).toEqual({ memory: 65_536, passes: 3, parallelism: 4 });
    const cheap = await hashPassword('correct horse battery staple', CHEAP_ARGON2);
    expect(needsRehash(cheap)).toBe(true);
    expect(needsRehash(cheap, CHEAP_ARGON2)).toBe(false);
    const real = await hashPassword('correct horse battery staple');
    expect(real.startsWith('$argon2id$v=19$m=65536,t=3,p=4$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', real)).toBe(true);
  });

  it('refuses a stored value whose parameters a sign-in should never run', async () => {
    const hash = await hashPassword('correct horse battery staple', CHEAP_ARGON2);
    expect(await verifyPassword('correct horse battery staple', hash.replace('m=1024', 'm=9999999'))).toBe(false);
  });

  it('holds the policy: 12 to 128 characters after NFKC, not the e-mail', () => {
    expect(passwordProblem('elevenchars')).toBe('too_short');
    expect(passwordProblem('twelve chars')).toBeNull();
    expect(passwordProblem('x'.repeat(129))).toBe('too_long');
    expect(passwordProblem('Ops@Example.com', 'ops@example.com')).toBe('is_email');
    // Code points, not UTF-16 units: twelve emoji are twelve characters.
    expect(passwordProblem('😀'.repeat(11))).toBe('too_short');
    expect(passwordProblem('😀'.repeat(12))).toBeNull();
    // NFKC: full-width letters count as the letters they stand for.
    expect(passwordProblem('ｏｐｓ@ｅｘａｍｐｌｅ.ｃｏｍ', 'ops@example.com')).toBe('is_email');
    expect(passwordProblem(generatePassword())).toBeNull();
  });

  it('matches the same password typed in another Unicode form', async () => {
    const hash = await hashPassword('ｃｏｒｒｅｃｔ horse battery', CHEAP_ARGON2);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
  });
});

describe('admin permissions', () => {
  it('covers a permission by itself, its area and *, but a restricted one only by itself and *', () => {
    expect(grantCovers('*', 'admins.manage')).toBe(true);
    expect(grantCovers('users.*', 'users.ban')).toBe(true);
    expect(grantCovers('users.ban', 'users.ban')).toBe(true);
    expect(grantCovers('users.ban', 'users.warn')).toBe(false);
    expect(grantCovers('users.*', 'users.test_account')).toBe(false);
    expect(grantCovers('config.*', 'config.providers')).toBe(false);
    expect(grantCovers('config.*', 'config.write')).toBe(true);
    expect(grantCovers('admins.*', 'admins.manage')).toBe(false);
    expect(grantCovers('admins.manage', 'admins.manage')).toBe(true);
    expect(grantCovers('user.*', 'users.read')).toBe(false);
    expect(grantsAllow(['dashboard.read', 'billing.*'], 'billing.write')).toBe(true);
    expect(grantsAllow(['dashboard.read'], 'billing.read')).toBe(false);
  });

  it('expands the seeded grants as the contract reads them', () => {
    expect(expandGrants(['*'])).toEqual(permissions);
    expect(OWNER_ROLE).toBe('superadmin');
    // The seeded admin role (config.*, users.*) gets neither provider secrets, test accounts nor admin accounts.
    const admin = expandGrants(['users.*', 'moderation.*', 'reports.*', 'appeals.*', 'content.*', 'billing.read', 'config.*', 'campaigns.*', 'support.*', 'dashboard.read', 'audit.read']);
    expect(admin).toContain('config.write');
    expect(admin).toContain('users.ban');
    expect(admin).not.toContain('config.providers');
    expect(admin).not.toContain('users.test_account');
    expect(admin).not.toContain('admins.read');
    expect(admin).not.toContain('billing.write');
    expect(expandGrants(['dashboard.read'])).toEqual(['dashboard.read']);
  });
});

describe('the admin refresh cookie', () => {
  it('is HttpOnly, Secure, SameSite=Strict and only sent to the auth routes', () => {
    const token = newAdminRefreshToken('123456789').token;
    const cookie = refreshCookie(token, 43_200);
    expect(cookie).toBe(`__Secure-admin_refresh=${token}; Path=/v1/admin/auth; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`);
    expect(clearedRefreshCookie()).toBe('__Secure-admin_refresh=; Path=/v1/admin/auth; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
  });

  it('reads its token back from a Cookie header, and nothing else', () => {
    const token = newAdminRefreshToken('987').token;
    expect(readCookie(`a=1; __Secure-admin_refresh=${token}; b=2`, '__Secure-admin_refresh')).toBe(token);
    expect(parseAdminRefreshToken(token)?.sessionId).toBe('987');
    expect(parseAdminRefreshToken('rt1.987.' + 'a'.repeat(43))).toBeNull();
    expect(readCookie(undefined, '__Secure-admin_refresh')).toBeNull();
  });
});
