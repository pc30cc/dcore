import { readFileSync } from 'node:fs';
import { sign } from 'node:crypto';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ORIGINS_SIGNING_CONTEXT,
  checkBootstrapUrl,
  checkOrigin,
  originsDocumentSchema,
  originsPayloadSchema,
  originsSettingsSchema,
  readOriginsPayload,
  validateOrigins,
  type OriginsPayload,
} from '../../src/index.js';
import {
  OriginsDocumentError,
  OriginsSigner,
  SlotLease,
  SlotsTakenError,
  compareOrigins,
  createKeys,
  generateOriginsKeyPair,
  originsKeys,
  originsPrivateKey,
  readOriginsDocument,
  storeOriginsDocument,
  verifyOriginsDocument,
  type OriginsTrust,
} from '../../src/server/index.js';
import { dropPrefix, hasRedis, testPrefix, testRedis } from './support.js';

const FIXTURES = new URL('../../fixtures/origins/', import.meta.url);
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8'));

// RFC 8032 section 7.1, test 1: a published key pair and the signature of the empty message.
const RFC_SEED = Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex').toString('base64url');
const RFC_PUBLIC = Buffer.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex').toString('base64url');
const RFC_EMPTY_SIGNATURE =
  'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b';

const trust = fixture('trust') as { brand: string; publicKeys: { kid: string; key: string }[]; verifyAt: string };
const at = (iso: string): OriginsTrust => ({ keys: trust.publicKeys, brand: trust.brand, now: new Date(iso) });

function payload(overrides: Partial<OriginsPayload> = {}): OriginsPayload {
  return { ...(fixture('payload') as OriginsPayload), ...overrides };
}

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof OriginsDocumentError) return error.reason;
    throw error;
  }
  return 'accepted';
}

describe('the origins document: keys and signatures', () => {
  it('uses real Ed25519: the RFC 8032 seed gives its public key and its signature of the empty message', () => {
    expect(new OriginsSigner('k', RFC_SEED).publicKey).toBe(RFC_PUBLIC);
    expect(sign(null, Buffer.alloc(0), originsPrivateKey(RFC_SEED)).toString('hex')).toBe(RFC_EMPTY_SIGNATURE);
  });

  it('the shared fixture is signed by the fixture key over the context and the payload text, and decodes to payload.json', () => {
    const document = originsDocumentSchema.parse(fixture('document'));
    expect(trust.publicKeys).toEqual([{ kid: 'test-1', key: RFC_PUBLIC }]);
    expect(verifyOriginsDocument(document, at(trust.verifyAt))).toEqual(fixture('payload'));
    expect(originsPayloadSchema.parse(fixture('payload'))).toEqual(fixture('payload'));
    // Deterministic: the same key and payload give the same bytes (every API process serves the same document).
    expect(new OriginsSigner('test-1', RFC_SEED).sign(payload())).toEqual(document);
    // What is signed is the ASCII text "origins-v1." followed by the payload as sent.
    expect(ORIGINS_SIGNING_CONTEXT).toBe('origins-v1.');
    const raw = sign(null, Buffer.from(`origins-v1.${document.payload}`, 'ascii'), originsPrivateKey(RFC_SEED)).toString('base64url');
    expect(raw).toBe(document.sig);
  });

  it('refuses a document that was changed after signing', () => {
    const document = originsDocumentSchema.parse(fixture('document'));
    // Another host in the payload (re-encoded), the signature kept.
    const forged = Buffer.from(JSON.stringify(payload({ hosts: { ...payload().hosts, api: ['https://evil.example.org'] } })), 'utf8').toString('base64url');
    expect(refusal(() => verifyOriginsDocument({ ...document, payload: forged }, at(trust.verifyAt)))).toBe('bad_signature');
    // One character of the signature.
    const sig = `${document.sig.slice(0, 10)}${document.sig[10] === 'A' ? 'B' : 'A'}${document.sig.slice(11)}`;
    expect(refusal(() => verifyOriginsDocument({ ...document, sig }, at(trust.verifyAt)))).toBe('bad_signature');
    // The same signature under another key id the app also knows.
    const other = generateOriginsKeyPair();
    expect(refusal(() => verifyOriginsDocument({ ...document, kid: 'other' }, { ...at(trust.verifyAt), keys: [...trust.publicKeys, { kid: 'other', key: other.publicKey }] }))).toBe('bad_signature');
    // Shape.
    expect(refusal(() => verifyOriginsDocument({ ...document, alg: 'HS256' }, at(trust.verifyAt)))).toBe('malformed');
    expect(refusal(() => verifyOriginsDocument({ ...document, extra: 1 }, at(trust.verifyAt)))).toBe('malformed');
    expect(refusal(() => verifyOriginsDocument('nope', at(trust.verifyAt)))).toBe('malformed');
  });

  it('refuses an unknown key, another brand, an expired document and one issued in the future', () => {
    const document = fixture('document');
    expect(refusal(() => verifyOriginsDocument(document, { ...at(trust.verifyAt), keys: [] }))).toBe('unknown_key');
    expect(refusal(() => verifyOriginsDocument(document, { ...at(trust.verifyAt), brand: 'another' }))).toBe('wrong_brand');
    expect(refusal(() => verifyOriginsDocument(document, at('2026-12-09T10:00:00.000Z')))).toBe('expired');
    expect(refusal(() => verifyOriginsDocument(document, at('2026-12-09T09:59:59.999Z')))).toBe('accepted');
    // More than a day before it was issued: a clock that far behind, or a forged future date.
    expect(refusal(() => verifyOriginsDocument(document, at('2026-11-08T09:59:59.000Z')))).toBe('not_yet_valid');
    expect(refusal(() => verifyOriginsDocument(document, { ...at('2026-11-09T09:00:00.000Z'), skewMs: 0 }))).toBe('not_yet_valid');
    // A payload that is signed but not JSON of the schema.
    const signer = new OriginsSigner('test-1', RFC_SEED);
    const bad = signer.sign({ ...payload(), version: 0 });
    expect(refusal(() => verifyOriginsDocument(bad, at(trust.verifyAt)))).toBe('malformed');
  });

  it('rotates keys: an app that knows the current and the next key accepts both, an old build only its own', () => {
    const current = generateOriginsKeyPair();
    const next = generateOriginsKeyPair();
    const keys = [
      { kid: 'o1', key: current.publicKey },
      { kid: 'o2', key: next.publicKey },
    ];
    const now = new Date('2026-11-20T00:00:00.000Z');
    const before = new OriginsSigner('o1', current.privateKey).sign(payload());
    const after = new OriginsSigner('o2', next.privateKey).sign(payload({ version: 8 }));
    expect(verifyOriginsDocument(before, { keys, now }).version).toBe(7);
    expect(verifyOriginsDocument(after, { keys, now }).version).toBe(8);
    expect(refusal(() => verifyOriginsDocument(after, { keys: [keys[0]!], now }))).toBe('unknown_key');
    // The next key's id with the current key's signature is refused (ids name keys, they do not choose them).
    expect(refusal(() => verifyOriginsDocument({ ...before, kid: 'o2' }, { keys, now }))).toBe('bad_signature');
  });

  it('makes key pairs whose private half gives back the public half, and refuses malformed keys without showing them', () => {
    const pair = generateOriginsKeyPair();
    expect(pair.privateKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new OriginsSigner('o1', pair.privateKey).publicKey).toBe(pair.publicKey);
    expect(() => new OriginsSigner('o1', 'short')).toThrow(/32 bytes in base64url/);
    expect(() => new OriginsSigner('bad id!', pair.privateKey)).toThrow();
    let message = '';
    try {
      new OriginsSigner('o1', `${pair.privateKey.slice(0, 42)}_`);
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/signing key/);
    expect(message).not.toContain(pair.privateKey.slice(0, 20));
  });

  it('orders documents by version, then by when they were signed', () => {
    const a = { version: 3, issuedAt: '2026-11-09T11:00:00.000Z' };
    expect(compareOrigins(a, { version: 4, issuedAt: '2026-11-09T10:00:00.000Z' })).toBe(-1);
    expect(compareOrigins(a, { version: 3, issuedAt: '2026-11-09T10:00:00.000Z' })).toBe(1);
    expect(compareOrigins(a, { ...a })).toBe(0);
  });

  it('reads the payload of a document without trusting it (the admin panel, the worker)', () => {
    expect(readOriginsPayload(originsDocumentSchema.parse(fixture('document')))).toEqual(fixture('payload'));
  });
});

describe('the host rules', () => {
  const rules = { allowIpHosts: false };

  it('accepts https origins, normalised, with a port when not 443', () => {
    expect(checkOrigin('https://API.Example.com/', rules)).toEqual({ ok: true, value: 'https://api.example.com' });
    expect(checkOrigin(' https://api.example.com:443 ', rules)).toEqual({ ok: true, value: 'https://api.example.com' });
    expect(checkOrigin('https://api.example.com:8443', rules)).toEqual({ ok: true, value: 'https://api.example.com:8443' });
    expect(checkOrigin('https://bücher.example', rules).ok).toBe(false); // a reserved TLD
    expect(checkOrigin('https://bücher.de', rules)).toEqual({ ok: true, value: 'https://xn--bcher-kva.de' });
  });

  it('refuses anything else', () => {
    const refused = (value: string, allowIpHosts = false) => {
      const checked = checkOrigin(value, { allowIpHosts });
      return checked.ok ? 'accepted' : checked.message;
    };
    expect(refused('http://api.example.com')).toBe('must use https');
    expect(refused('wss://rt.example.com')).toBe('must use https');
    expect(refused('https://api.example.com/v1')).toMatch(/origin only/);
    expect(refused('https://api.example.com?x=1')).toMatch(/origin only/);
    expect(refused('https://api.example.com#x')).toMatch(/fragment/);
    expect(refused('https://user:pw@api.example.com')).toMatch(/user name/);
    expect(refused('https://api')).toMatch(/fully qualified/);
    expect(refused('https://localhost')).toMatch(/fully qualified/);
    for (const name of ['api.localhost', 'printer.local', 'a.test', 'a.invalid', 'svc.internal', 'x.onion', 'nas.home.arpa']) {
      expect(refused(`https://${name}`), name).toMatch(/public host name/);
    }
    expect(refused('')).toMatch(/empty/);
    expect(refused(`https://${'a'.repeat(300)}.com`)).toMatch(/at most 300/);
  });

  it('allows IP literals only when asked, and never private, local or reserved ones', () => {
    const refused = (value: string, allowIpHosts: boolean) => {
      const checked = checkOrigin(value, { allowIpHosts });
      return checked.ok ? checked.value : checked.message;
    };
    expect(refused('https://8.8.8.8', false)).toMatch(/not allowed/);
    expect(refused('https://8.8.8.8', true)).toBe('https://8.8.8.8');
    expect(refused('https://[2606:4700:4700::1111]', true)).toBe('https://[2606:4700:4700::1111]');
    for (const ip of ['10.1.2.3', '127.0.0.1', '172.20.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '192.0.2.1', '203.0.113.5', '0x7f.1']) {
      expect(refused(`https://${ip}`, true), ip).toBe('must be a public IP address');
    }
    for (const ip of ['[::1]', '[::]', '[fd00::1]', '[fe80::1]', '[ff02::1]', '[::ffff:10.0.0.1]', '[2001:db8::1]']) {
      expect(refused(`https://${ip}`, true), ip).toBe('must be a public IP address');
    }
  });

  it('checks a whole change: at least one API host, no entry twice, at most eight, pointers to each problem', () => {
    expect(validateOrigins({ hosts: { api: ['https://api.example.com'] } })).toEqual({
      ok: true,
      hosts: { api: ['https://api.example.com'], realtime: [], rtc: [], cdn: [], web: [] },
      bootstrap: [],
      allowIpHosts: false,
    });
    expect(validateOrigins({ hosts: { api: [] } })).toEqual({ ok: false, issues: [{ pointer: '/hosts/api', message: 'at least one API host is required' }] });
    const checked = validateOrigins({
      hosts: { api: ['https://api.example.com', 'https://API.example.com/'], cdn: ['http://cdn.example.com'], web: Array.from({ length: 9 }, (_, i) => `https://w${i}.example.com`) },
      bootstrap: ['https://cdn.example.com/', 'https://cdn.example.com/o.json?x', 'https://cdn.example.com/bootstrap/origins.json'],
    });
    expect(checked.ok ? [] : checked.issues.map((i) => i.pointer)).toEqual(['/hosts/api/1', '/hosts/cdn/0', '/hosts/web', '/bootstrap/0', '/bootstrap/1']);
    expect(checkBootstrapUrl('https://mirror.example.org/o/origins.json', rules)).toEqual({ ok: true, value: 'https://mirror.example.org/o/origins.json' });
  });

  it('refuses a stored value the rules refuse (the configuration load keeps its last good copy)', () => {
    const good = { version: 2, hosts: { api: ['https://api.example.com'], realtime: [], rtc: [], cdn: [], web: [] }, bootstrap: [], allowIpHosts: false };
    expect(originsSettingsSchema.parse(good)).toEqual(good);
    expect(originsSettingsSchema.safeParse({ ...good, version: 1 }).success).toBe(false);
    expect(originsSettingsSchema.safeParse({ ...good, hosts: { ...good.hosts, api: ['https://10.0.0.1'] }, allowIpHosts: true }).success).toBe(false);
  });
});

describe.skipIf(!hasRedis)('the stored document and the worker slots (redis-server)', () => {
  let redis: Redis;
  const prefix = testPrefix();
  const keys = createKeys(prefix);

  beforeAll(() => {
    redis = testRedis();
  });
  afterAll(async () => {
    await dropPrefix(redis, prefix);
    await redis.quit();
  });

  it('keeps the newest document: version first, then issuedAt, then the later process', async () => {
    const store = (version: number, issuedAtMs: number, signerStartedAtMs: number, body: string) =>
      storeOriginsDocument(redis, keys, { version, issuedAtMs, signerStartedAtMs, body });
    expect(await readOriginsDocument(redis, keys)).toBeNull();
    expect(await store(2, 1_000, 10, 'v2@1000')).toBe(true);
    expect(await store(1, 9_000, 99, 'v1@9000')).toBe(false); // an older version, however recent
    expect(await store(2, 500, 99, 'v2@500')).toBe(false); // signed earlier
    expect(await store(2, 1_000, 5, 'v2@1000 old process')).toBe(false);
    expect(await store(2, 1_000, 10, 'v2@1000 same process')).toBe(false);
    expect(await store(2, 1_000, 20, 'v2@1000 newer process')).toBe(true);
    expect(await store(2, 2_000, 1, 'v2@2000')).toBe(true);
    expect(await store(3, 100, 1, 'v3')).toBe(true);
    expect(await readOriginsDocument(redis, keys)).toEqual({ version: 3, issuedAtMs: 100, body: 'v3' });
    expect(await redis.exists(originsKeys(keys).document())).toBe(1);
    expect(originsKeys(keys).document()).toBe(`${prefix}origins:doc`);
  });

  it('gives each process the lowest free slot, never one that is held, and frees it on stop', async () => {
    const a = await SlotLease.acquire({ redis, keys, name: 'wslot', slots: 3 });
    const b = await SlotLease.acquire({ redis, keys, name: 'wslot', slots: 3 });
    const c = await SlotLease.acquire({ redis, keys, name: 'wslot', slots: 3 });
    expect([a.slot, b.slot, c.slot]).toEqual([0, 1, 2]);
    await expect(SlotLease.acquire({ redis, keys, name: 'wslot', slots: 3 })).rejects.toThrow(SlotsTakenError);
    await b.stop();
    const again = await SlotLease.acquire({ redis, keys, name: 'wslot', slots: 3 });
    expect(again.slot).toBe(1);
    expect(await redis.pttl(`${prefix}wslot:1`)).toBeGreaterThan(25_000);
    await Promise.all([a.stop(), c.stop(), again.stop()]);
    expect(await redis.exists(`${prefix}wslot:0`, `${prefix}wslot:1`, `${prefix}wslot:2`)).toBe(0);
  });

  it('takes its slot back after the lease expired while it was free, and reports a slot another process took', async () => {
    const events: string[] = [];
    const lease = await SlotLease.acquire({ redis, keys, name: 'tslot', slots: 2, ttlMs: 30_000, refreshMs: 3_600_000, onLost: () => events.push('lost') });
    // Valkey forgot the lease (a restart): the next refresh takes the same slot back.
    await redis.del(`${prefix}tslot:${lease.slot}`);
    await lease.refreshNow();
    expect(await redis.get(`${prefix}tslot:${lease.slot}`)).not.toBeNull();
    expect(events).toEqual([]);
    // Another process holds it now: the lease is lost and never refreshed again.
    await redis.set(`${prefix}tslot:${lease.slot}`, 'another', 'PX', 30_000);
    await lease.refreshNow();
    expect(events).toEqual(['lost']);
    expect(lease.isLost).toBe(true);
    await lease.stop();
    expect(await redis.get(`${prefix}tslot:${lease.slot}`)).toBe('another');
  });

  it('says once when no refresh succeeded for a whole lease', async () => {
    let clock = 0;
    let down = false;
    const events: string[] = [];
    // Valkey as the lease sees it: reachable, then not.
    const flaky = new Proxy(redis, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (down && (property === 'evalsha' || property === 'eval' || property === 'set')) return () => Promise.reject(new Error('down'));
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const lease = await SlotLease.acquire({ redis: flaky, keys, name: 'xslot', slots: 1, ttlMs: 30_000, refreshMs: 3_600_000, clock: () => clock, onExpired: () => events.push('expired') });
    down = true;
    clock = 10_000;
    await lease.refreshNow();
    expect(events).toEqual([]);
    clock = 31_000;
    await lease.refreshNow();
    await lease.refreshNow();
    expect(events).toEqual(['expired']);
    expect(lease.isLost).toBe(false);
    // Back: the lease is taken again and refreshed as before.
    down = false;
    await lease.refreshNow();
    expect(await redis.pttl(`${prefix}xslot:0`)).toBeGreaterThan(25_000);
    await lease.stop();
  });
});
