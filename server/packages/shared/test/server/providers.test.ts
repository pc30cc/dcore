import { generateKeyPairSync } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, createLocalJWKSet, exportJWK, importPKCS8, jwtVerify, type JWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pushPayload, realtimeEnvelope } from '../../src/index.js';
import {
  CentrifugoPublisher,
  FakeGoogleIdTokenVerifier,
  FakePushSender,
  FakeRealtimePublisher,
  FakeSmsSender,
  FcmSender,
  GoogleIdTokenError,
  JoseGoogleIdTokenVerifier,
  ProviderError,
  SmsError,
  fcmMessage,
  parseServiceAccount,
  type Fetch,
} from '../../src/server/index.js';

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

describe('Centrifugo publisher (against a local server)', () => {
  const received: { path: string; key: string | undefined; body: Record<string, unknown> }[] = [];
  let reply: (path: string) => { status: number; json: unknown } = () => ({ status: 200, json: { result: {} } });
  const server = createServer((request, response) => {
    void body(request).then((text) => {
      received.push({ path: request.url ?? '', key: request.headers['x-api-key'] as string | undefined, body: JSON.parse(text) as Record<string, unknown> });
      const { status, json } = reply(request.url ?? '');
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json));
    });
  });
  let publisher: CentrifugoPublisher;

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    publisher = new CentrifugoPublisher({ apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, apiKey: 'test-key' });
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const envelope = realtimeEnvelope('conversation_end', '1287390234923417613', 0, { conversationId: '1287390234923400001' });

  it('publishes with the API key and the envelope id as idempotency key', async () => {
    await publisher.publish('u:#bq3vx7k2mze4a', envelope);
    expect(received.at(-1)).toEqual({
      path: '/api/publish',
      key: 'test-key',
      body: { channel: 'u:#bq3vx7k2mze4a', data: envelope, idempotency_key: envelope.id },
    });
  });

  it('broadcasts to both members, skips history for typing, disconnects a user', async () => {
    await publisher.broadcast(['u:#bq3vx7k2mze4a', 'u:#cn5wy6l3naf5b'], envelope);
    expect(received.at(-1)?.path).toBe('/api/broadcast');
    expect(received.at(-1)?.body['channels']).toEqual(['u:#bq3vx7k2mze4a', 'u:#cn5wy6l3naf5b']);
    const typing = realtimeEnvelope('typing', '1287390234923417611', 0, { conversationId: '1', by: 'cn5wy6l3naf5b' });
    await publisher.publish('u:#bq3vx7k2mze4a', typing);
    expect(received.at(-1)?.body['skip_history']).toBe(true);
    await publisher.disconnect('bq3vx7k2mze4a');
    expect(received.at(-1)).toMatchObject({ path: '/api/disconnect', body: { user: 'bq3vx7k2mze4a' } });
  });

  it('turns refusals and outages into provider errors', async () => {
    reply = () => ({ status: 200, json: { error: { code: 102, message: 'unknown channel' } } });
    await expect(publisher.publish('u:#x', envelope)).rejects.toMatchObject({ retryable: false });
    reply = () => ({ status: 503, json: {} });
    await expect(publisher.publish('u:#x', envelope)).rejects.toMatchObject({ status: 503, retryable: true });
    reply = () => ({ status: 200, json: { result: { responses: [{}, { error: { code: 100 } }] } } });
    await expect(publisher.broadcast(['a', 'b'], envelope)).rejects.toBeInstanceOf(ProviderError);
    const down = new CentrifugoPublisher({ apiUrl: 'http://127.0.0.1:1', apiKey: 'k', timeoutMs: 500 });
    await expect(down.publish('u:#x', envelope)).rejects.toMatchObject({ retryable: true });
    reply = () => ({ status: 200, json: { result: {} } });
  });

  it('has a fake that records by channel', async () => {
    const fake = new FakeRealtimePublisher();
    await fake.broadcast(['a', 'b'], envelope);
    await fake.disconnect('bq3vx7k2mze4a');
    expect(fake.on('b')).toEqual([envelope]);
    expect(fake.disconnected).toEqual(['bq3vx7k2mze4a']);
  });
});

describe('FCM sender', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const serviceAccount = JSON.stringify({
    type: 'service_account',
    project_id: 'example-project',
    private_key_id: 'kid-1',
    private_key: pem.replaceAll('\n', '\\n'),
    client_email: 'push@example-project.iam.gserviceaccount.com',
  });

  it('reads the service account (JSON or base64) and refuses a broken one without echoing it', () => {
    const account = parseServiceAccount(serviceAccount);
    expect(account).toMatchObject({ projectId: 'example-project', clientEmail: 'push@example-project.iam.gserviceaccount.com', privateKeyId: 'kid-1' });
    expect(account?.privateKey.startsWith('-----BEGIN PRIVATE KEY-----\n')).toBe(true);
    expect(parseServiceAccount(Buffer.from(serviceAccount).toString('base64'), 'other')?.projectId).toBe('other');
    expect(parseServiceAccount(undefined)).toBeNull();
    expect(() => parseServiceAccount('{"client_email": "x"}')).toThrow(/lacks/);
    expect(() => parseServiceAccount('not json')).toThrow(/not service-account JSON/);
  });

  it('exchanges a signed assertion once, sends the message and reads the outcome', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let send: () => Response = () => Response.json({ name: 'projects/example-project/messages/1' });
    const fetchFn: Fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/token')) return Response.json({ access_token: 'ya29.test', expires_in: 3_600 });
      return send();
    };
    const sender = new FcmSender({ account: parseServiceAccount(serviceAccount)!, fetch: fetchFn, tokenUrl: 'https://oauth.test/token', apiBase: 'https://fcm.test' });
    const payload = pushPayload('match', { conversationId: '12' }, { text: { title: 'New match', body: 'You have a new match' } });

    expect(await sender.send('device-token-1', payload)).toMatchObject({ ok: true, messageId: 'projects/example-project/messages/1' });
    expect(await sender.send('device-token-2', payload)).toMatchObject({ ok: true });
    expect(calls.filter((c) => c.url.endsWith('/token'))).toHaveLength(1);

    const assertion = new URLSearchParams(calls[0]!.init.body as string).get('assertion')!;
    const { payload: claims, protectedHeader } = await jwtVerify(assertion, publicKey, { audience: 'https://oauth.test/token' });
    expect(protectedHeader).toMatchObject({ alg: 'RS256', kid: 'kid-1' });
    expect(claims).toMatchObject({ iss: 'push@example-project.iam.gserviceaccount.com', scope: 'https://www.googleapis.com/auth/firebase.messaging' });

    const sent = calls[1]!;
    expect(sent.url).toBe('https://fcm.test/v1/projects/example-project/messages:send');
    expect((sent.init.headers as Record<string, string>)['authorization']).toBe('Bearer ya29.test');
    expect(JSON.parse(sent.init.body as string)).toEqual(fcmMessage('device-token-1', payload));

    send = () => new Response('{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}', { status: 404 });
    expect(await sender.send('device-token-3', payload)).toMatchObject({ ok: false, unregistered: true, retryable: false });
    send = () => new Response('{"error":{"status":"UNAVAILABLE"}}', { status: 503, headers: { 'retry-after': '30' } });
    expect(await sender.send('device-token-4', payload)).toMatchObject({ ok: false, unregistered: false, retryable: true, retryAfterSeconds: 30 });
    send = () => new Response('{"error":{"status":"INVALID_ARGUMENT","message":"The registration token is not a valid FCM registration token device-token-5"}}', { status: 400 });
    const invalid = await sender.send('device-token-5', payload);
    expect(invalid).toMatchObject({ unregistered: true });
    expect(invalid.error).not.toContain('device-token-5');
  });

  it('builds data-only rings and private notifications as the contract says', () => {
    const ring = fcmMessage('t', pushPayload('call_incoming', { callId: '9', conversationId: '12', kind: 'video', peerName: 'Sam', expiresAt: '2026-11-06T09:15:45.000Z' }));
    expect(ring).toEqual({
      message: {
        token: 't',
        data: { type: 'call_incoming', callId: '9', conversationId: '12', kind: 'video', peerName: 'Sam', expiresAt: '2026-11-06T09:15:45.000Z' },
        android: { priority: 'HIGH', ttl: '45s', collapse_key: 'call:9' },
      },
    });
    const message = fcmMessage('t', pushPayload('message', { conversationId: '12', messageId: '34' }, { text: { title: 'New message', body: '' } }));
    expect((message['message'] as { android: { notification: Record<string, unknown> } }).android.notification).toEqual({
      title: 'New message',
      body: '',
      sound: 'default',
      channel_id: 'messages',
      tag: 'c:12',
      visibility: 'PRIVATE',
    });
  });

  it('never throws, and the fake marks dead tokens', async () => {
    const broken = new FcmSender({ account: { projectId: 'p', clientEmail: 'e', privateKey: 'not a key' }, fetch: async () => Response.json({}) });
    expect(await broken.send('t', pushPayload('account', {}, { text: { title: 'a', body: 'b' } }))).toMatchObject({ ok: false, retryable: true });
    const fake = new FakePushSender();
    fake.deadTokens.add('dead');
    expect(await fake.send('dead', pushPayload('like', { total: '1' }, { text: { title: 'a', body: 'b' } }))).toMatchObject({ unregistered: true });
    expect(await fake.send('live', pushPayload('like', { total: '1' }, { text: { title: 'a', body: 'b' } }))).toMatchObject({ ok: true });
    expect(fake.sent).toHaveLength(1);
  });
});

describe('Google ID tokens', () => {
  const AUDIENCE = '123456789-abc.apps.googleusercontent.com';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let verifier: JoseGoogleIdTokenVerifier;
  const now = new Date('2026-11-06T09:00:00Z');

  beforeAll(async () => {
    const jwk = { ...(await exportJWK(publicKey)), kid: 'g1', alg: 'RS256', use: 'sig' } as JWK;
    verifier = new JoseGoogleIdTokenVerifier({ keys: createLocalJWKSet({ keys: [jwk] }), now: () => now });
  });

  async function token(claims: Record<string, unknown>, options: { key?: typeof privateKey; iat?: number; exp?: number } = {}): Promise<string> {
    const key = await importPKCS8((options.key ?? privateKey).export({ type: 'pkcs8', format: 'pem' }).toString(), 'RS256');
    const iat = options.iat ?? Math.floor(now.getTime() / 1_000) - 10;
    return new SignJWT({ email: 'someone@example.com', email_verified: true, ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'g1' })
      .setIssuer('https://accounts.google.com')
      .setAudience(AUDIENCE)
      .setSubject('110169484474386276334')
      .setIssuedAt(iat)
      .setExpirationTime(options.exp ?? iat + 3_600)
      .sign(key);
  }

  it('accepts a token for our client with our nonce, and names the account by sub', async () => {
    const identity = await verifier.verify(await token({ nonce: 'n-1' }), { audience: AUDIENCE, nonce: 'n-1', maxAgeSeconds: 300 });
    expect(identity).toMatchObject({ sub: '110169484474386276334', email: 'someone@example.com', emailVerified: true });
  });

  it('refuses another audience, another nonce, an old, expired or foreign-signed token', async () => {
    const reason = async (promise: Promise<unknown>) => {
      try {
        await promise;
        return undefined;
      } catch (error) {
        return (error as GoogleIdTokenError).reason;
      }
    };
    expect(await reason(verifier.verify(await token({}), { audience: 'other.apps.googleusercontent.com' }))).toBe('audience');
    expect(await reason(verifier.verify(await token({ nonce: 'n-1' }), { audience: AUDIENCE, nonce: 'n-2' }))).toBe('nonce');
    expect(await reason(verifier.verify(await token({}), { audience: AUDIENCE, nonce: 'n-2' }))).toBe('nonce');
    const iat = Math.floor(now.getTime() / 1_000) - 1_000;
    expect(await reason(verifier.verify(await token({}, { iat }), { audience: AUDIENCE, maxAgeSeconds: 300 }))).toBe('too_old');
    expect(await reason(verifier.verify(await token({}, { iat: iat - 7_200, exp: iat - 3_600 }), { audience: AUDIENCE }))).toBe('expired');
    expect(await reason(verifier.verify(await token({}, { key: other.privateKey }), { audience: AUDIENCE }))).toBe('signature');
    expect(await reason(verifier.verify('not.a.token', { audience: AUDIENCE }))).toBe('malformed');
  });

  it('has a fake with the same checks', async () => {
    const fake = new FakeGoogleIdTokenVerifier();
    const t = fake.mint({ sub: '42', audience: AUDIENCE, nonce: 'n' });
    expect((await fake.verify(t, { audience: AUDIENCE, nonce: 'n' })).sub).toBe('42');
    await expect(fake.verify(t, { audience: AUDIENCE, nonce: 'x' })).rejects.toBeInstanceOf(GoogleIdTokenError);
    await expect(fake.verify('forged', { audience: AUDIENCE })).rejects.toMatchObject({ reason: 'signature' });
  });
});

describe('SMS fake', () => {
  it('keeps the codes it was given and fails on demand', async () => {
    const sms = new FakeSmsSender('kavenegar');
    await sms.send({ phone: '+989121234567', code: '123456', appName: 'Example', locale: 'fa', channel: 'sms' });
    expect(sms.codeFor('+989121234567')).toBe('123456');
    sms.fail = 'unavailable';
    await expect(sms.send({ phone: '+989121234567', code: '1', appName: 'x', locale: 'fa', channel: 'sms' })).rejects.toBeInstanceOf(SmsError);
  });
});
