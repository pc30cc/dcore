import { SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiApp } from '../src/app.js';
import { TokenError, createAccessTokens } from '../src/auth/tokens.js';
import { ISSUER, ed25519Pem, testApp, testConfig, testSecret } from './support.js';

afterEach(() => {
  vi.useRealTimers();
});

const hsConfig = (secret = testSecret()) => testConfig({ AUTH_JWT_SECRET: secret }).auth;

async function reason(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(TokenError);
  return (error as TokenError).reason;
}

describe('access tokens', () => {
  it('round-trips user and admin tokens with HS256', async () => {
    const tokens = await createAccessTokens(hsConfig());
    const user = await tokens.issue({ kind: 'app', subject: 'u_1', sessionId: 's_1', roles: ['ignored'] });
    const principal = await tokens.verify(user.token);
    expect(principal).toMatchObject({ kind: 'app', subject: 'u_1', sessionId: 's_1', roles: [] });
    expect(principal.expiresAt.getTime()).toBe(user.expiresAt.getTime());

    const admin = await tokens.verify((await tokens.issue({ kind: 'admin', subject: 'a_1', sessionId: 's_2', roles: ['moderator'] })).token);
    expect(admin).toMatchObject({ kind: 'admin', roles: ['moderator'] });
  });

  it('round-trips with EdDSA and keeps accepting the previous key during a rotation', async () => {
    const oldKey = ed25519Pem();
    const newKey = ed25519Pem();
    const before = await createAccessTokens(
      testConfig({ AUTH_JWT_ALG: 'EdDSA', AUTH_JWT_KID: 'k1', AUTH_JWT_PRIVATE_KEY: oldKey.privateKey, AUTH_JWT_PUBLIC_KEY: oldKey.publicKey }).auth,
    );
    const issuedBefore = await before.issue({ kind: 'app', subject: 'u_1', sessionId: 's_1' });

    const after = await createAccessTokens(
      testConfig({
        AUTH_JWT_ALG: 'EdDSA',
        AUTH_JWT_KID: 'k2',
        AUTH_JWT_PRIVATE_KEY: newKey.privateKey,
        AUTH_JWT_PUBLIC_KEY: newKey.publicKey,
        AUTH_JWT_PREVIOUS_KID: 'k1',
        AUTH_JWT_PREVIOUS_PUBLIC_KEY: oldKey.publicKey.replaceAll('\n', '\\n'),
      }).auth,
    );
    expect((await after.verify(issuedBefore.token)).subject).toBe('u_1');
    expect((await after.verify((await after.issue({ kind: 'app', subject: 'u_2', sessionId: 's' })).token)).subject).toBe('u_2');
  });

  it('reports expiry separately from other failures', async () => {
    const tokens = await createAccessTokens({ ...hsConfig(), clockSkewSeconds: 0 });
    const { token } = await tokens.issue({ kind: 'app', subject: 'u_1', sessionId: 's_1' });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 16 * 60 * 1_000);
    expect(await reason(tokens.verify(token))).toBe('expired');
  });

  it('refuses tampered tokens, other issuers, unknown keys and other algorithms', async () => {
    const secret = testSecret();
    const tokens = await createAccessTokens(hsConfig(secret));
    const { token } = await tokens.issue({ kind: 'app', subject: 'u_1', sessionId: 's_1' });
    const [header, payload, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload ?? '', 'base64url').toString()), sub: 'u_2' })).toString('base64url');
    expect(await reason(tokens.verify(`${header}.${forged}.${signature}`))).toBe('invalid');

    const otherIssuer = await createAccessTokens({ ...hsConfig(secret), issuer: 'https://elsewhere.invalid' });
    expect(await reason(otherIssuer.verify(token))).toBe('invalid');

    const otherKid = await createAccessTokens({ ...hsConfig(secret), current: { kid: 'k9', secret } });
    expect(await reason(otherKid.verify(token))).toBe('invalid');

    const keys = ed25519Pem();
    const eddsa = await createAccessTokens(
      testConfig({ AUTH_JWT_ALG: 'EdDSA', AUTH_JWT_PRIVATE_KEY: keys.privateKey, AUTH_JWT_PUBLIC_KEY: keys.publicKey }).auth,
    );
    expect(await reason(eddsa.verify(token))).toBe('invalid');

    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'at+jwt', kid: 'k1' })).toString('base64url')}.${payload}.`;
    expect(await reason(tokens.verify(unsigned))).toBe('invalid');
  });

  it('refuses tokens of another type or without a session', async () => {
    const secret = testSecret();
    const tokens = await createAccessTokens(hsConfig(secret));
    const key = new Uint8Array(Buffer.from(secret, 'base64url'));
    const idToken = await new SignJWT({ sid: 's_1' })
      .setProtectedHeader({ alg: 'HS256', kid: 'k1', typ: 'JWT' })
      .setIssuer(ISSUER).setSubject('u_1').setAudience('app').setIssuedAt().setExpirationTime('5m').setJti('j')
      .sign(key);
    expect(await reason(tokens.verify(idToken))).toBe('invalid');
    const noSession = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', kid: 'k1', typ: 'at+jwt' })
      .setIssuer(ISSUER).setSubject('u_1').setAudience('app').setIssuedAt().setExpirationTime('5m').setJti('j')
      .sign(key);
    expect(await reason(tokens.verify(noSession))).toBe('invalid');
  });
});

describe('auth plugin', () => {
  let app: ApiApp;
  afterEach(async () => {
    await app?.close();
  });

  async function started(): Promise<ApiApp> {
    app = await testApp();
    app.get('/test/me', { preHandler: app.requireUser }, async (request) => ({ subject: request.principal?.subject }));
    app.get('/test/admin', { preHandler: app.requireAdmin('moderator') }, async (request) => ({ roles: request.principal?.roles }));
    await app.ready();
    return app;
  }

  it('asks for a token when there is none', async () => {
    const res = await (await started()).inject({ method: 'GET', url: '/test/me' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(res.json()).toMatchObject({ code: 'unauthorized' });
  });

  it('lets a user token through and refuses malformed or expired ones', async () => {
    const instance = await started();
    const { token } = await instance.tokens.issue({ kind: 'app', subject: 'u_7', sessionId: 's_7' });
    const ok = await instance.inject({ method: 'GET', url: '/test/me', headers: { authorization: `Bearer ${token}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ subject: 'u_7' });

    const malformed = await instance.inject({ method: 'GET', url: '/test/me', headers: { authorization: 'Basic abc' } });
    expect(malformed.statusCode).toBe(401);
    expect(malformed.headers['www-authenticate']).toBe('Bearer error="invalid_token"');

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60 * 60 * 1_000);
    const expired = await instance.inject({ method: 'GET', url: '/test/me', headers: { authorization: `Bearer ${token}` } });
    expect(expired.statusCode).toBe(401);
    expect(expired.json()).toMatchObject({ code: 'token_expired' });
  });

  it('keeps user and admin tokens apart and checks admin roles', async () => {
    const instance = await started();
    const user = (await instance.tokens.issue({ kind: 'app', subject: 'u_1', sessionId: 's' })).token;
    const support = (await instance.tokens.issue({ kind: 'admin', subject: 'a_1', sessionId: 's', roles: ['support'] })).token;
    const moderator = (await instance.tokens.issue({ kind: 'admin', subject: 'a_2', sessionId: 's', roles: ['moderator'] })).token;
    const call = (url: string, token: string) => instance.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

    // Valkey is unreachable here: the deny list cannot be read, so admin tokens are refused (they fail
    // closed) while user tokens go on.
    expect((await call('/test/admin', moderator)).statusCode).toBe(401);
    expect((await call('/test/me', user)).statusCode).toBe(200);
    // With a readable deny list that names neither session:
    instance.denyList.check = async () => 'allowed';

    expect((await call('/test/admin', user)).statusCode).toBe(401);
    expect((await call('/test/me', moderator)).statusCode).toBe(401);
    const forbidden = await call('/test/admin', support);
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ code: 'forbidden' });
    const allowed = await call('/test/admin', moderator);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toEqual({ roles: ['moderator'] });
  });
});
