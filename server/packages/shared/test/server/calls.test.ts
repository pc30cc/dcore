import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { userChannel } from '../../src/api/realtime.js';
import {
  CALL_RING_MS,
  DataSealer,
  EMPTY_RTC_SETTINGS,
  FakeRealtimePublisher,
  PARTICIPANT_IDENTITY,
  TURN_SECRET_PURPOSE,
  acceptCall,
  callIdentities,
  callKeys,
  callLinePreview,
  callLineTitle,
  callAudience,
  callView,
  cancelCall,
  checkClientWsUrl,
  clampTurnCredentialTtl,
  completeCall,
  createKeys,
  createPublicIds,
  declineCall,
  endCallsWithConversations,
  decodeCallLineBody,
  endPairCall,
  encodeCallLineBody,
  formatCallDuration,
  giveBackRing,
  hangUpCall,
  issueTurnUsername,
  liveCallFields,
  markJoined,
  mergeRtcSettings,
  missCall,
  mintTurnCredential,
  normalizeClientWsUrl,
  normalizeTurnCountries,
  participantIdentity,
  participantNetwork,
  parseLiveCall,
  placeCall,
  readCall,
  relayServes,
  ringPushStep,
  rtcSettingsOf,
  sideOfIdentity,
  stampRang,
  takeCalleeRing,
  takeCallerRing,
  turnPassword,
  turnReuseFloorSeconds,
  turnSecretFingerprint,
  turnUsernameExpiry,
  withTurnUsername,
  type LiveCall,
  type PlaceInput,
} from '../../src/server/index.js';
import { dropPrefix, hasRedis, testPrefix, testRedis } from './support.js';

const T0 = Date.UTC(2026, 10, 8, 12, 0, 0);
let seq = 1287390234923430000n;
const nextId = () => String((seq += 1n));

describe('TURN credentials', () => {
  it('match a known vector: <expiry>:r<16 hex> and base64(HMAC-SHA1(secret, username))', () => {
    // Computed with `openssl dgst -sha1 -hmac <secret> -binary | base64`.
    expect(turnPassword('shared-relay-secret-0123456789', '1762606800:r0011223344556677')).toBe('TNfuIzqxZM+AQh2hwC3EUc4gB9A=');
    const minted = mintTurnCredential({
      sharedSecret: 'shared-relay-secret-0123456789',
      ttlSeconds: 21_600,
      now: (1_762_606_800 - 21_600) * 1_000,
      nonce: Buffer.from('0011223344556677', 'hex'),
    });
    expect(minted).toEqual({ username: '1762606800:r0011223344556677', credential: 'TNfuIzqxZM+AQh2hwC3EUc4gB9A=', expiresAtMs: 1_762_606_800_000 });
  });

  it('name nothing: a random username each time, the lifetime of the setting', () => {
    const a = mintTurnCredential({ sharedSecret: 'x'.repeat(20), ttlSeconds: 600, now: T0 });
    const b = mintTurnCredential({ sharedSecret: 'x'.repeat(20), ttlSeconds: 600, now: T0 });
    expect(a.username).toMatch(/^[0-9]{10}:r[0-9a-f]{16}$/);
    expect(a.username).not.toBe(b.username);
    expect(Number(a.username.split(':')[0])).toBe(T0 / 1_000 + 600);
  });

  it('fingerprint the secret as 12 hex of its SHA-256 (comparable with sha256sum on the relay)', () => {
    expect(turnSecretFingerprint('shared-relay-secret-0123456789')).toBe('c10e8a6e9490');
  });
});

describe('participant identities', () => {
  const secret = 'identity-secret-0123456789abcdef';
  const call = { id: '1287390234923430001', callerId: '1287390234923400101', calleeId: '1287390234923400102' };

  it('are u:<16 hex of HMAC-SHA256(secret, call-ref:<call>:<user>)>, never the user id', () => {
    // Computed with `openssl dgst -sha256 -hmac <secret>`.
    expect(participantIdentity(secret, call.id, call.callerId)).toBe('u:713f39d258a4c4a7');
    const ids = callIdentities(secret, call);
    for (const identity of [ids.caller, ids.callee]) {
      expect(identity).toMatch(PARTICIPANT_IDENTITY);
      expect(identity).not.toContain(call.callerId.slice(-6));
      expect(identity).not.toContain(call.calleeId.slice(-6));
    }
    expect(ids.caller).not.toBe(ids.callee);
    expect(participantIdentity(secret, '1287390234923430002', call.callerId)).not.toBe(ids.caller);
  });

  it('resolve back to a side only for the two people of the call', () => {
    const ids = callIdentities(secret, call);
    expect(sideOfIdentity(secret, call, ids.caller)).toBe('caller');
    expect(sideOfIdentity(secret, call, ids.callee)).toBe('callee');
    expect(sideOfIdentity(secret, call, participantIdentity(secret, call.id, '42'))).toBeNull();
    expect(sideOfIdentity(secret, call, 'u:zz')).toBeNull();
  });
});

describe('the call network', () => {
  it('reduces wsUrl to an origin (https becomes wss; a path would double into /rtc/rtc)', () => {
    expect(normalizeClientWsUrl('https://rtc.example.com/rtc/')).toBe('wss://rtc.example.com');
    expect(normalizeClientWsUrl('wss://rtc.example.com:7443/rtc?x=1')).toBe('wss://rtc.example.com:7443');
    expect(normalizeClientWsUrl('http://localhost:7880')).toBe('ws://localhost:7880');
    expect(normalizeClientWsUrl('rtc.example.com')).toBeNull();
    expect(normalizeClientWsUrl('ftp://rtc.example.com')).toBeNull();
    expect(normalizeClientWsUrl('wss://user:pass@rtc.example.com')).toBeNull();
  });

  it('gives clients a signalling URL only as wss:// on a public host name', () => {
    expect(checkClientWsUrl('https://rtc.example.com/')).toEqual({ ok: true, value: 'wss://rtc.example.com' });
    expect(checkClientWsUrl('wss://rtc.example.com:7443')).toEqual({ ok: true, value: 'wss://rtc.example.com:7443' });
    for (const bad of ['ws://rtc.example.com', 'http://rtc.example.com', 'wss://10.0.0.5', 'wss://203.0.113.9', 'wss://[2001:db8::1]', 'wss://rtc.local', 'wss://localhost', 'wss://user:pw@rtc.example.com', 'rtc.example.com']) {
      expect(checkClientWsUrl(bad).ok, bad).toBe(false);
    }
    const sealer = new DataSealer(new Map([[1, Buffer.alloc(32, 7)]]), 1);
    expect(() => mergeRtcSettings({}, { wsUrl: 'http://10.0.0.5' }, sealer)).toThrow(/wss:\/\//);
    // A stored value that breaks the rules (written by hand, or before the rule) is not used: the brand's host is.
    expect(rtcSettingsOf({ wsUrl: 'ws://10.0.0.5' }, sealer).wsUrl).toBeNull();
    expect(rtcSettingsOf({ wsUrl: 'wss://rtc.example.com' }, sealer).wsUrl).toBe('wss://rtc.example.com');
  });

  it('keeps countries as two-letter codes or *, and the lifetime inside 600..86400 s', () => {
    expect(normalizeTurnCountries([' ir', 'IR', 'xx1', '*', 7])).toEqual(['IR', '*']);
    expect(clampTurnCredentialTtl(30)).toBe(600);
    expect(clampTurnCredentialTtl(10 ** 9)).toBe(86_400);
    expect(clampTurnCredentialTtl('nope')).toBe(21_600);
  });

  it('hands the relay only to a participant whose country is listed (an unknown country never)', () => {
    expect(relayServes(['IR'], 'IR')).toBe(true);
    expect(relayServes(['IR'], 'DE')).toBe(false);
    expect(relayServes(['IR'], null)).toBe(false);
    expect(relayServes([], 'IR')).toBe(false);
    expect(relayServes(['*'], null)).toBe(true);
    const settings = {
      ...EMPTY_RTC_SETTINGS,
      relay: { urls: ['turn:198.51.100.7:3478?transport=udp'], secret: 'shared-relay-secret-0123456789', secretStored: true, countries: ['IR'], credentialTtlSeconds: 21_600 },
    };
    const listed = participantNetwork(settings, 'IR', T0);
    expect(listed.relayed).toBe(true);
    expect(listed.turn?.urls).toEqual(['turn:198.51.100.7:3478?transport=udp']);
    expect(listed.turn?.username).toMatch(/^[0-9]+:r[0-9a-f]{16}$/);
    expect(listed.turn?.credential).toBe(turnPassword('shared-relay-secret-0123456789', listed.turn?.username ?? ''));
    expect(participantNetwork(settings, 'DE', T0)).toEqual({ turn: null, relayed: false, warnings: [] });
    expect(participantNetwork(settings, null, T0)).toEqual({ turn: null, relayed: false, warnings: [] });
    // Listed but nothing to give: the participant is told the network may block the call.
    expect(participantNetwork({ ...settings, relay: { ...settings.relay, secret: null } }, 'IR', T0)).toEqual({ turn: null, relayed: false, warnings: ['turn_missing'] });
  });

  it('never mints a relay credential that outlives the call, and keeps the kept one until its renewal margin', () => {
    const settings = {
      ...EMPTY_RTC_SETTINGS,
      relay: { urls: ['turn:198.51.100.7:3478'], secret: 'shared-relay-secret-0123456789', secretStored: true, countries: ['IR'], credentialTtlSeconds: 21_600 },
    };
    const t0s = Math.floor(T0 / 1_000);
    // Far from the guard: the setting's six hours.
    expect(turnUsernameExpiry(participantNetwork(settings, 'IR', T0, { notAfterMs: T0 + 12 * 3_600_000 }).turn?.username)).toBe(t0s + 21_600);
    // Two hours before the guard: two hours; a minute at least, however close.
    expect(turnUsernameExpiry(participantNetwork(settings, 'IR', T0, { notAfterMs: T0 + 2 * 3_600_000 }).turn?.username)).toBe(t0s + 7_200);
    expect(turnUsernameExpiry(participantNetwork(settings, 'IR', T0, { notAfterMs: T0 + 1_000 }).turn?.username)).toBe(t0s + 60);
    // A kept username is handed again while 30 minutes (at most half the lifetime) are left of it, or up to the guard.
    expect(turnReuseFloorSeconds(settings, T0)).toBe(t0s + 1_800);
    expect(turnReuseFloorSeconds({ ...settings, relay: { ...settings.relay, credentialTtlSeconds: 600 } }, T0)).toBe(t0s + 300);
    expect(turnReuseFloorSeconds(settings, T0, T0 + 600_000)).toBe(t0s + 600);
    expect(turnUsernameExpiry('1700000000:r0123456789abcdef')).toBe(1_700_000_000);
    expect(turnUsernameExpiry('1700000000:x')).toBeNull();
    // Handed again, a username keeps its password under the current secret.
    const network = participantNetwork(settings, 'IR', T0);
    const kept = withTurnUsername(settings, network, '1700000000:r0123456789abcdef');
    expect(kept.turn).toEqual({ urls: ['turn:198.51.100.7:3478'], username: '1700000000:r0123456789abcdef', credential: turnPassword('shared-relay-secret-0123456789', '1700000000:r0123456789abcdef') });
  });

  it('merges a patch onto the stored row, seals the secret and checks the merged value', () => {
    const sealer = new DataSealer(new Map([[1, Buffer.alloc(32, 7)]]), 1);
    const first = mergeRtcSettings({ keptKey: 1 }, { turnUrls: ['turn:198.51.100.7:3478'], sharedSecret: 'shared-relay-secret-0123456789', countries: ['ir'] }, sealer);
    expect(first.value['keptKey']).toBe(1);
    expect(first.changed.sort()).toEqual(['turn.countries', 'turn.sharedSecret', 'turn.urls']);
    const stored = first.value['turn'] as Record<string, unknown>;
    expect(JSON.stringify(first.value)).not.toContain('shared-relay-secret');
    expect(sealer.openText(Buffer.from(String(stored['secret']), 'base64'), TURN_SECRET_PURPOSE)).toBe('shared-relay-secret-0123456789');
    const opened = rtcSettingsOf(first.value, sealer);
    expect(opened.relay).toMatchObject({ urls: ['turn:198.51.100.7:3478'], secret: 'shared-relay-secret-0123456789', countries: ['IR'], credentialTtlSeconds: 21_600 });
    // A URL-only patch is judged with the secret already stored.
    expect(mergeRtcSettings(first.value, { turnUrls: ['turns:198.51.100.7:5349?transport=tcp'] }, sealer).changed).toEqual(['turn.urls']);
    // Refused: a bare hostname, a URL without a secret, LiveKit's own host, a bad country, a lifetime out of range.
    expect(() => mergeRtcSettings({}, { turnUrls: ['relay.example.com'] }, sealer)).toThrow(/Not a TURN server URL/);
    expect(() => mergeRtcSettings({}, { turnUrls: ['turn:198.51.100.7:3478'] }, sealer)).toThrow(/shared secret/);
    expect(() => mergeRtcSettings(first.value, { wsUrl: 'wss://rtc.example.com', turnUrls: ['turn:rtc.example.com:3478'] }, sealer)).toThrow(/LiveKit/);
    expect(() => mergeRtcSettings(first.value, { countries: ['ABC'] }, sealer)).toThrow(/two-letter/);
    expect(() => mergeRtcSettings(first.value, { credentialTtlSeconds: 60 }, sealer)).toThrow(/between/);
    // Removing the secret while URLs remain is refused; removing both is fine.
    expect(() => mergeRtcSettings(first.value, { sharedSecret: '' }, sealer)).toThrow(/shared secret/);
    const removed = mergeRtcSettings(first.value, { sharedSecret: '', turnUrls: [] }, sealer);
    expect((removed.value['turn'] as Record<string, unknown>)['secret']).toBeUndefined();
    expect(removed.changed.sort()).toEqual(['turn.sharedSecret', 'turn.urls']);
    // A secret sealed under a key this process does not hold is no secret (the relay is withheld).
    const other = new DataSealer(new Map([[1, Buffer.alloc(32, 9)]]), 1);
    expect(rtcSettingsOf(first.value, other).relay.secret).toBeNull();
  });
});

describe('the call line', () => {
  it('carries the outcome, the talk time and when it was placed, and titles it per side', () => {
    const body = encodeCallLineBody({ kind: 'video', outcome: 'completed', durationSeconds: 125.4, placedMs: T0 });
    expect(decodeCallLineBody(body)).toEqual({ kind: 'video', outcome: 'completed', durationSeconds: 125, placedMs: T0 });
    expect(decodeCallLineBody(encodeCallLineBody({ kind: 'audio', outcome: 'missed', durationSeconds: 30, placedMs: T0 }))?.durationSeconds).toBe(0);
    expect(decodeCallLineBody('not json')).toBeNull();
    const titles = (['completed', 'missed', 'cancelled', 'declined', 'failed'] as const).map((outcome) => [
      outcome,
      callLineTitle({ kind: 'audio', outcome }, 'caller'),
      callLineTitle({ kind: 'audio', outcome }, 'callee'),
    ]);
    expect(titles).toEqual([
      ['completed', 'voice', 'voice'],
      ['missed', 'no_answer', 'missed_voice'],
      ['cancelled', 'cancelled', 'missed_voice'],
      ['declined', 'declined', 'declined'],
      ['failed', 'failed', 'failed'],
    ]);
    expect(callLineTitle({ kind: 'video', outcome: 'missed' }, 'callee')).toBe('missed_video');
    expect(formatCallDuration(0)).toBe('0:00');
    expect(formatCallDuration(65)).toBe('1:05');
    expect(formatCallDuration(3_725)).toBe('1:02:05');
    expect(callLinePreview({ kind: 'video', outcome: 'completed', durationSeconds: 65, placedMs: T0 }, 'caller', 'en')).toBe('Video call · 1:05');
    expect(callLinePreview({ kind: 'audio', outcome: 'missed', durationSeconds: 0, placedMs: T0 }, 'callee', 'fa')).toBe('تماس صوتی از دست رفته');
    expect(callLinePreview({ kind: 'audio', outcome: 'missed', durationSeconds: 0, placedMs: T0 }, 'caller', 'tr')).toBe('Yanıt yok');
  });
});

describe.skipIf(!hasRedis)('live calls in Valkey (prefixed keys)', () => {
  let redis: Redis;
  const prefix = testPrefix();
  const keys = createKeys(prefix);
  const ctx = () => ({ redis, keys, mintId: nextId });

  beforeAll(() => {
    redis = testRedis();
  });
  afterAll(async () => {
    await dropPrefix(redis, prefix);
    await redis.quit();
  });

  let people = 1287390234923400000n;
  const person = () => String((people += 1n));
  const placeInput = (callerId: string, calleeId: string, now = T0, extra: Partial<PlaceInput> = {}): PlaceInput => ({
    id: nextId(),
    matchId: nextId(),
    callerId,
    calleeId,
    kind: 'audio',
    now,
    maxLive: null,
    shadow: false,
    fakeRingMs: 10_000,
    ...extra,
  });
  const read = async (id: string): Promise<LiveCall> => {
    const call = await readCall(redis, keys, id);
    if (!call) throw new Error(`no call ${id}`);
    return call;
  };

  it('stores the full prefixed name of the call in busy:<uid>, and holds both people while it rings', async () => {
    const [a, b, c] = [person(), person(), person()];
    const input = placeInput(a, b);
    expect(await placeCall(redis, keys, input)).toBe('placed');
    expect(await redis.get(callKeys(keys).busy(a))).toBe(`${prefix}call:${input.id}`);
    expect(await redis.get(callKeys(keys).busy(b))).toBe(`${prefix}call:${input.id}`);
    // The caller is busy for anybody else; a callee in a call rings nobody (and is never told).
    expect(await placeCall(redis, keys, placeInput(a, c, T0 + 1_000))).toBe('caller_busy');
    const toBusy = placeInput(c, b, T0 + 1_000);
    expect(await placeCall(redis, keys, toBusy)).toBe('callee_busy');
    const fake = await read(toBusy.id);
    expect(fake.fake).toBe('busy');
    expect(fake.ringMs).toBe(10_000);
    // The busy callee's line is untouched: busy:<b> still names the first call.
    expect(await redis.get(callKeys(keys).busy(b))).toBe(`${prefix}call:${input.id}`);
    // A ring that ran out holds nobody, even before anything marked it missed.
    expect(await placeCall(redis, keys, placeInput(a, c, T0 + CALL_RING_MS + 1))).toBe('placed');
  });

  it('lets exactly one of many simultaneous calls sharing a person ring', async () => {
    const shared = person();
    const callers = Array.from({ length: 40 }, () => person());
    const verdicts = await Promise.all(callers.map((caller) => placeCall(redis, keys, placeInput(caller, shared))));
    expect(verdicts.filter((v) => v === 'placed')).toHaveLength(1);
    expect(verdicts.filter((v) => v === 'callee_busy')).toHaveLength(39);
    // Two people calling each other at the same moment: one rings, the other is told it is already in a call.
    const [x, y] = [person(), person()];
    const both = await Promise.all([placeCall(redis, keys, placeInput(x, y)), placeCall(redis, keys, placeInput(y, x))]);
    expect(both.sort()).toEqual(['caller_busy', 'placed']);
  });

  it('counts the live cap inside the placement, and a call whose hash expired holds no slot', async () => {
    const live = callKeys(keys).live();
    await redis.del(live);
    const pairs = Array.from({ length: 12 }, () => [person(), person()] as const);
    const verdicts = await Promise.all(pairs.map(([a, b]) => placeCall(redis, keys, placeInput(a, b, T0, { maxLive: 5 }))));
    expect(verdicts.filter((v) => v === 'placed')).toHaveLength(5);
    expect(verdicts.filter((v) => v === 'limit_reached')).toHaveLength(7);
    // A ghost (a lost job, the hash gone) is trimmed by score when its expiry passes.
    await redis.zadd(live, T0 - 1, 'ghost');
    const later = placeInput(person(), person(), T0 + 13 * 3_600_000, { maxLive: 5 });
    expect(await placeCall(redis, keys, later)).toBe('placed');
    expect(await redis.zscore(live, 'ghost')).toBeNull();
  });

  it('lets the first answer win, and a decline racing an answer lose cleanly', async () => {
    const [a, b] = [person(), person()];
    const input = placeInput(a, b);
    await placeCall(redis, keys, input);
    const call = await read(input.id);
    const answers = await Promise.all(Array.from({ length: 10 }, (_, i) => acceptCall(ctx(), call, `90${i}`, T0 + 2_000)));
    const won = answers.filter((x) => x !== null);
    expect(won).toHaveLength(1);
    expect(won[0]?.state).toBe('connecting');
    expect(await declineCall(ctx(), call, T0 + 2_001)).toBeNull();

    const [c, d] = [person(), person()];
    const other = placeInput(c, d);
    await placeCall(redis, keys, other);
    const ringing = await read(other.id);
    const [answer, decline] = await Promise.all([acceptCall(ctx(), ringing, '1', T0 + 3_000), declineCall(ctx(), ringing, T0 + 3_000)]);
    expect([answer, decline].filter((x) => x !== null)).toHaveLength(1);
  });

  it('refuses an answer once the ring ran out, and misses a call once and only once', async () => {
    const [a, b] = [person(), person()];
    const input = placeInput(a, b);
    await placeCall(redis, keys, input);
    const call = await read(input.id);
    expect(await acceptCall(ctx(), call, '1', T0 + CALL_RING_MS)).toBeNull();
    expect(await missCall(ctx(), call, T0 + CALL_RING_MS - 1)).toBeNull();
    const misses = await Promise.all(Array.from({ length: 8 }, () => missCall(ctx(), call, T0 + CALL_RING_MS + 10)));
    expect(misses.filter((x) => x !== null)).toHaveLength(1);
    const missed = await read(input.id);
    expect(missed).toMatchObject({ state: 'missed', outcome: 'missed', endedBy: 'system', endReason: 'ring_timeout' });
    expect(missed.lineId).toMatch(/^[1-9][0-9]+$/);
    // Both people are free again, and the hash is a tombstone.
    expect(await redis.get(callKeys(keys).busy(a))).toBeNull();
    expect(await redis.get(callKeys(keys).busy(b))).toBeNull();
    expect(await redis.ttl(callKeys(keys).call(input.id))).toBeLessThanOrEqual(600);
  });

  it('stamps rang once, while it rings, and never for a call that rings nobody', async () => {
    const [a, b, c] = [person(), person(), person()];
    const input = placeInput(a, b);
    await placeCall(redis, keys, input);
    const first = await stampRang(redis, keys, input.id, T0 + 500, false);
    expect(first.verdict).toBe('stamped');
    expect((await stampRang(redis, keys, input.id, T0 + 900, true)).verdict).toBe('already');
    const stamped = await read(input.id);
    expect(stamped.rangMs).toBe(T0 + 500);
    expect(stamped.rangShown).toBe(false);
    // Hidden from the caller (the callee does not show online), kept for the callee.
    expect(callView(stamped, a).rangAt).toBeUndefined();
    expect(callView(stamped, b).rangAt).toBe(new Date(T0 + 500).toISOString());
    expect(callAudience(stamped, 'rang')).toEqual(['callee']);
    expect((await stampRang(redis, keys, input.id, T0 + CALL_RING_MS, true)).verdict).toBe('over');
    const busy = placeInput(c, b);
    expect(await placeCall(redis, keys, busy)).toBe('callee_busy');
    expect((await stampRang(redis, keys, busy.id, T0 + 1_000, true)).verdict).toBe('not_ringing');
  });

  it('shows a busy callee to the caller exactly like an unanswered call', async () => {
    const [a, b, c] = [person(), person(), person()];
    await placeCall(redis, keys, placeInput(a, b));
    const toBusy = placeInput(c, b, T0, { fakeRingMs: 9_000 });
    const unanswered = placeInput(person(), person());
    expect(await placeCall(redis, keys, toBusy)).toBe('callee_busy');
    expect(await placeCall(redis, keys, unanswered)).toBe('placed');
    const fake = await read(toBusy.id);
    const real = await read(unanswered.id);
    const shape = (call: LiveCall, viewer: string) => {
      const view = callView(call, viewer);
      return { ...view, id: 'x', conversationId: 'x' };
    };
    expect(shape(fake, c)).toEqual(shape(real, real.callerId));
    expect(callAudience(fake, 'placed')).toEqual(['caller']);
    const fakeEnd = await missCall(ctx(), fake, T0 + 9_001);
    const realEnd = await missCall(ctx(), real, T0 + CALL_RING_MS + 1);
    expect(fakeEnd?.endReason).toBe('callee_busy');
    const ended = (call: LiveCall | null, viewer: string) => {
      const view = callView(call!, viewer);
      return { ...view, id: 'x', conversationId: 'x', endedAt: 'x' };
    };
    expect(ended(fakeEnd, c)).toEqual(ended(realEnd, real.callerId));
    expect(callView(fakeEnd!, c).endReason).toBe('ring_timeout');
    // The busy callee hears of it only at the end: a missed call.
    expect(callAudience(fakeEnd!, 'ended')).toEqual(['caller', 'callee']);
  });

  it('becomes active once both identities are in the room, and completes or fails at the end', async () => {
    const secret = 'identity-secret-0123456789abcdef';
    const [a, b] = [person(), person()];
    const input = placeInput(a, b);
    await placeCall(redis, keys, input);
    const answered = await acceptCall(ctx(), await read(input.id), '7', T0 + 2_000);
    expect(answered?.answeredMs).toBe(T0 + 2_000);
    const ids = callIdentities(secret, input);
    expect((await markJoined(redis, keys, input.id, ids.callee, ids, T0 + 3_000)).verdict).toBe('joined');
    const both = await markJoined(redis, keys, input.id, ids.caller, ids, T0 + 4_000);
    expect(both.verdict).toBe('activated');
    expect(both.call?.activeMs).toBe(T0 + 4_000);
    const done = await completeCall(ctx(), both.call!, 'callee', 'hangup', T0 + 64_000);
    expect(done).toMatchObject({ state: 'ended', outcome: 'completed', endedBy: 'callee', endReason: 'hangup' });
    expect(callView(done!, a).durationSeconds).toBe(62);

    // Answered, but the two were never in the room together: failed, no talk time.
    const [c, d] = [person(), person()];
    const other = placeInput(c, d);
    await placeCall(redis, keys, other);
    const connecting = await acceptCall(ctx(), await read(other.id), '8', T0 + 1_000);
    const hung = await hangUpCall(ctx(), connecting!, 'caller', T0 + 20_000);
    expect(hung).toMatchObject({ outcome: 'failed', endReason: 'hangup', endedBy: 'caller' });
    expect(callView(hung!, c).durationSeconds).toBe(0);
  });

  it('cancels before the answer, and a terminal move frees only the busy keys that still name the call', async () => {
    const [a, b, c] = [person(), person(), person()];
    const input = placeInput(a, b);
    await placeCall(redis, keys, input);
    const first = await read(input.id);
    // The ring ran out unmarked; the callee placed another call meanwhile.
    const next = placeInput(b, c, T0 + CALL_RING_MS + 5);
    expect(await placeCall(redis, keys, next)).toBe('placed');
    const cancelled = await cancelCall(ctx(), first, T0 + CALL_RING_MS + 6);
    expect(cancelled).toMatchObject({ state: 'cancelled', outcome: 'cancelled', endedBy: 'caller' });
    expect(await redis.get(callKeys(keys).busy(b))).toBe(`${prefix}call:${next.id}`);
    expect(await redis.get(callKeys(keys).busy(a))).toBeNull();
  });

  it('keeps a stop behind its ring, and the stop goes to the rung devices except the one that answered', async () => {
    const [a, b] = [person(), person()];
    const input = placeInput(a, b);
    await placeCall(redis, keys, input);
    expect(await ringPushStep(redis, keys, input.id, 'begin', T0 + 10)).toEqual({ step: 'go' });
    // The stop arrives while the ring is on its way: it waits.
    expect(await ringPushStep(redis, keys, input.id, 'stop', T0 + 20)).toEqual({ step: 'wait', sinceMs: T0 + 10 });
    await acceptCall(ctx(), await read(input.id), '2', T0 + 30);
    const rung = [
      { d: '1', t: 'token-one' },
      { d: '2', t: 'token-two' },
    ];
    expect(await ringPushStep(redis, keys, input.id, 'done', T0 + 40, rung)).toEqual({ step: 'done', state: 'connecting' });
    expect(await ringPushStep(redis, keys, input.id, 'stop', T0 + 50)).toEqual({ step: 'send', rung, answeredDevice: '2', known: true });
    expect(await ringPushStep(redis, keys, input.id, 'stop', T0 + 60)).toEqual({ step: 'none' });

    // A stop before the ring started: the ring never starts.
    const [c, d] = [person(), person()];
    const other = placeInput(c, d);
    await placeCall(redis, keys, other);
    expect(await ringPushStep(redis, keys, other.id, 'stop', T0 + 5)).toEqual({ step: 'none' });
    expect(await ringPushStep(redis, keys, other.id, 'begin', T0 + 6)).toEqual({ step: 'skip', reason: 'stopped' });
    // A ring is never sent for a call that already stopped ringing.
    const [e, f] = [person(), person()];
    const third = placeInput(e, f);
    await placeCall(redis, keys, third);
    await declineCall(ctx(), await read(third.id), T0 + 1);
    expect(await ringPushStep(redis, keys, third.id, 'begin', T0 + 2)).toEqual({ step: 'skip', reason: 'ended' });
  });

  it('limits the caller to 10 placements a minute and the callee to 6 rings, with the give-back', async () => {
    const [a, b] = [person(), person()];
    const caller = await Promise.all(Array.from({ length: 12 }, () => takeCallerRing(redis, keys, a, T0)));
    expect(caller.filter((r) => r.allowed)).toHaveLength(10);
    expect(caller.find((r) => !r.allowed)?.retryAfterSeconds).toBe(60);
    const rings = [];
    for (let i = 0; i < 6; i += 1) rings.push(await takeCalleeRing(redis, keys, b, T0 + 30_000));
    expect(rings.every((r) => r.allowed)).toBe(true);
    expect((await takeCalleeRing(redis, keys, b, T0 + 30_000)).allowed).toBe(false);
    // An attempt that never rang gives its ring back.
    await giveBackRing(redis, rings[0]!);
    const again = await takeCalleeRing(redis, keys, b, T0 + 30_000);
    expect(again).toMatchObject({ allowed: true, retryAfterSeconds: 30 });
    // The next minute starts again.
    expect((await takeCalleeRing(redis, keys, b, T0 + 60_000)).allowed).toBe(true);
  });

  it('ends the live call of a pair whose conversation ended, and only that one', async () => {
    const [a, b] = [person(), person()];
    const input = placeInput(a, b);
    await placeCall(redis, keys, input);
    expect(await endPairCall(ctx(), { id: nextId(), lo: a, hi: b }, T0 + 1)).toBeNull();
    const ended = await endPairCall(ctx(), { id: input.matchId, lo: a, hi: b }, T0 + 2);
    expect(ended).toMatchObject({ state: 'cancelled', outcome: 'cancelled', endedBy: 'system' });
    expect(await redis.get(callKeys(keys).busy(a))).toBeNull();
    const answered = placeInput(person(), person());
    await placeCall(redis, keys, answered);
    await acceptCall(ctx(), await read(answered.id), '1', T0 + 3);
    expect(await endPairCall(ctx(), { id: answered.matchId, lo: answered.callerId, hi: answered.calleeId }, T0 + 4)).toMatchObject({ state: 'ended', outcome: 'failed', endReason: 'hangup' });
  });

  it('ends at once the calls of conversations that just ended, tells both people and queues what follows, and never throws', async () => {
    const publicIds = createPublicIds(Buffer.alloc(32, 7).toString('base64url'), Buffer.alloc(32, 9).toString('base64url'));
    const realtime = new FakeRealtimePublisher();
    const queued: { name: string; id: string }[] = [];
    const warnings: string[] = [];
    const effects = {
      realtime,
      publicIds,
      nextId,
      jobs: { add: async (name: string, id: string) => void queued.push({ name, id }) },
      log: { warn: (_: object, msg: string) => void warnings.push(msg), error: (_: object, msg: string) => void warnings.push(msg) },
    };
    const ringing = placeInput(person(), person());
    const answered = placeInput(person(), person());
    const untouched = placeInput(person(), person());
    for (const input of [ringing, answered, untouched]) expect(await placeCall(redis, keys, input)).toBe('placed');
    await acceptCall(ctx(), await read(answered.id), '1', T0 + 1);
    const ref = (input: PlaceInput) => ({ matchId: input.matchId, lo: input.callerId, hi: input.calleeId });
    const quiet = { matchId: nextId(), lo: person(), hi: person() };
    expect(await endCallsWithConversations(ctx(), effects, [ref(ringing), ref(answered), quiet], T0 + 2)).toBe(2);
    expect(await read(ringing.id)).toMatchObject({ state: 'cancelled', endedBy: 'system' });
    expect(await read(answered.id)).toMatchObject({ state: 'ended', endedBy: 'system', endReason: 'hangup' });
    expect((await read(untouched.id)).state).toBe('ringing');
    // The rung phones of the ringing call stop; both calls are finalized; each person hears their call end.
    expect(queued.filter((j) => j.name === 'ring-stop').map((j) => j.id)).toEqual([`ring-stop.${ringing.id}`]);
    expect(queued.filter((j) => j.name === 'finalize').map((j) => j.id).sort()).toEqual([`finalize.${ringing.id}`, `finalize.${answered.id}`].sort());
    for (const uid of [ringing.callerId, ringing.calleeId, answered.callerId, answered.calleeId]) {
      expect(realtime.on(userChannel(publicIds.user.encode(uid))).some((e) => e.t === 'call'), uid).toBe(true);
    }
    // Again (a retried request): nothing left to end.
    expect(await endCallsWithConversations(ctx(), effects, [ref(ringing), ref(answered)], T0 + 3)).toBe(0);
    // A Valkey failure is logged, not thrown: the call ends at its next check instead.
    const broken = { ...ctx(), redis: { get: async () => Promise.reject(new Error('connection lost')) } as unknown as Redis };
    expect(await endCallsWithConversations(broken, effects, [ref(untouched)], T0 + 4)).toBe(0);
    expect(warnings).toHaveLength(1);
    expect((await read(untouched.id)).state).toBe('ringing');
  });

  it('keeps one relay username per participant of a call, renews it only near its expiry, and none once the call is gone', async () => {
    const [a, b] = [person(), person()];
    const input = placeInput(a, b);
    expect(await placeCall(redis, keys, input)).toBe('placed');
    const t0s = Math.floor(T0 / 1_000);
    const first = `${t0s + 21_600}:r${'1'.repeat(16)}`;
    expect(await issueTurnUsername(redis, keys, input.id, 'callee', first, t0s + 1_800)).toBe(first);
    // Thirty more asks, each with a newly minted candidate: the kept one every time.
    for (let i = 0; i < 30; i += 1) {
      expect(await issueTurnUsername(redis, keys, input.id, 'callee', `${t0s + 21_600 + i}:r${String(i).padStart(16, '0')}`, t0s + 1_800 + i)).toBe(first);
    }
    // The caller has a username of their own.
    const caller = `${t0s + 21_600}:r${'2'.repeat(16)}`;
    expect(await issueTurnUsername(redis, keys, input.id, 'caller', caller, t0s + 1_800)).toBe(caller);
    expect((await read(input.id)).relayed).toBe(true);
    // Less than the margin left: the new one replaces it, and is kept from then on.
    const renewed = `${t0s + 40_000}:r${'3'.repeat(16)}`;
    expect(await issueTurnUsername(redis, keys, input.id, 'callee', renewed, t0s + 21_600 + 1)).toBe(renewed);
    expect(await issueTurnUsername(redis, keys, input.id, 'callee', `${t0s + 41_000}:r${'4'.repeat(16)}`, t0s + 21_700)).toBe(renewed);
    expect(await redis.hget(callKeys(keys).call(input.id), 'tce')).toBe(renewed);
    expect(await redis.hget(callKeys(keys).call(input.id), 'tcr')).toBe(caller);
    // The hash gone: no username, and nothing written back.
    await redis.del(callKeys(keys).call(input.id));
    expect(await issueTurnUsername(redis, keys, input.id, 'callee', first, t0s)).toBeNull();
    expect(await redis.exists(callKeys(keys).call(input.id))).toBe(0);
  });

  it('places nothing in a conversation that ended after it was checked (its tombstone)', async () => {
    const [a, b] = [person(), person()];
    const input = placeInput(a, b);
    await redis.set(keys.matchEnded(input.matchId), 1, 'EX', 60);
    expect(await placeCall(redis, keys, input)).toBe('ended');
    expect(await redis.exists(callKeys(keys).call(input.id), callKeys(keys).busy(a), callKeys(keys).busy(b))).toBe(0);
    expect(await redis.zscore(callKeys(keys).live(), input.id)).toBeNull();
  });

  it('reads back what it wrote, and refuses a second call under the same id', async () => {
    const [a, b] = [person(), person()];
    const input = placeInput(a, b, T0, { shadow: true });
    expect(await placeCall(redis, keys, input)).toBe('shadow');
    expect(await placeCall(redis, keys, input)).toBe('exists');
    const call = await read(input.id);
    expect(call.fake).toBe('shadow');
    expect(callAudience(call, 'placed')).toEqual(['caller']);
    expect(parseLiveCall(liveCallFields(call))).toEqual(call);
    // A shadow call never reaches the callee, not even at its end.
    const ended = await missCall(ctx(), call, T0 + 20_000);
    expect(callAudience(ended!, 'ended')).toEqual(['caller']);
  });
});
