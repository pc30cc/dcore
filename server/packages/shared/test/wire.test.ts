import { describe, expect, it } from 'vitest';
import {
  ID_EPOCH_MS,
  composeId,
  idFloor,
  idParts,
  idTime,
  locationUpdateSchema,
  otpPrefixCap,
  parseAppConfigValue,
  problem,
  problemSchemaFor,
  pushPayload,
  realtimeEnvelope,
  smsProvidersFor,
  userChannel,
} from '../src/index.js';

describe('ids', () => {
  it('matches the SQL layout', () => {
    const id = composeId({ ms: ID_EPOCH_MS + 1_000, generator: 5, sequence: 7 });
    // (1000 << 22) | (5 << 12) | 7, as id_floor/id_ms compute it in SQL.
    expect(id).toBe((1_000n << 22n) | (5n << 12n) | 7n);
    expect(idParts(id)).toEqual({ ms: ID_EPOCH_MS + 1_000, generator: 5, sequence: 7 });
    expect(idTime(id.toString()).getTime()).toBe(ID_EPOCH_MS + 1_000);
    expect(idFloor(ID_EPOCH_MS + 1_000)).toBe(1_000n << 22n);
    expect(idFloor(0)).toBe(0n);
  });

  it('refuses parts out of range', () => {
    expect(() => composeId({ ms: ID_EPOCH_MS - 1, generator: 0, sequence: 0 })).toThrow(RangeError);
    expect(() => composeId({ ms: ID_EPOCH_MS, generator: 1024, sequence: 0 })).toThrow(RangeError);
    expect(() => composeId({ ms: ID_EPOCH_MS, generator: 0, sequence: 4096 })).toThrow(RangeError);
    expect(() => idParts(0n)).toThrow(RangeError);
  });
});

describe('problems with extension members', () => {
  it('writes the members at the top level and validates them', () => {
    const doc = problem('otp_invalid', { requestId: 'r', extensions: { attemptsLeft: 2 } });
    expect(doc).toMatchObject({ code: 'otp_invalid', status: 400, attemptsLeft: 2 });
    expect(problemSchemaFor('otp_invalid').parse(doc)).toEqual(doc);
    expect(() => problemSchemaFor('otp_invalid').parse({ ...doc, extra: 1 })).toThrow();
  });

  it('never lets an extension replace a standard member', () => {
    expect(() => problem('maintenance', { extensions: { status: 200 } })).toThrow(TypeError);
  });
});

describe('push payloads', () => {
  it('builds a notification with its tag, channel and TTL', () => {
    const push = pushPayload('message', { conversationId: '12', messageId: '34' }, { text: { title: 'New message', body: '' } });
    expect(push).toMatchObject({
      kind: 'notification',
      channel: 'messages',
      tag: 'c:12',
      ttlSeconds: 86_400,
      visibility: 'private',
      data: { type: 'message', conversationId: '12', messageId: '34' },
    });
  });

  it('builds a data-only ring collapsed per call', () => {
    const push = pushPayload('call_incoming', {
      callId: '9',
      conversationId: '12',
      kind: 'audio',
      peerName: 'Sam',
      expiresAt: '2026-11-06T09:15:45.000Z',
    });
    expect(push).toMatchObject({ kind: 'data', priority: 'high', ttlSeconds: 45, collapseKey: 'call:9' });
    expect(push.title).toBeUndefined();
  });

  it('refuses keys the contract does not list, text on a data push, and a campaign without a TTL', () => {
    expect(() => pushPayload('like', { total: '3', phone: '+98' } as never, { text: { title: 'x', body: 'y' } })).toThrow();
    expect(() => pushPayload('call_cancel', { callId: '9', reason: 'declined' }, { text: { title: 'x', body: 'y' } })).toThrow(TypeError);
    expect(() => pushPayload('offer', { campaignId: '1', deeplink: '/store' }, { text: { title: 'x', body: 'y' } })).toThrow(RangeError);
    expect(pushPayload('offer', { campaignId: '1', deeplink: '/store' }, { text: { title: 'x', body: 'y' }, ttlSeconds: 3_600 }).ttlSeconds).toBe(3_600);
  });
});

describe('realtime envelopes', () => {
  it('builds an envelope and strips what the contract does not have', () => {
    const envelope = realtimeEnvelope('conversation_end', '1287390234923417613', Date.UTC(2026, 10, 6), {
      conversationId: '1287390234923400001',
      reason: 'block',
    } as never);
    expect(envelope).toEqual({
      t: 'conversation_end',
      v: 1,
      id: '1287390234923417613',
      at: '2026-11-06T00:00:00.000Z',
      d: { conversationId: '1287390234923400001' },
    });
  });

  it('refuses a payload that misses a field', () => {
    expect(() => realtimeEnvelope('typing', '1', 0, { conversationId: '1' } as never)).toThrow();
  });

  it('names the personal channel by public id only', () => {
    expect(userChannel('bq3vx7k2mze4a')).toBe('u:#bq3vx7k2mze4a');
    expect(() => userChannel('1287390234923417613')).toThrow(TypeError);
  });
});

describe('location updates', () => {
  it('takes a position, or a city alone', () => {
    expect(locationUpdateSchema.safeParse({ lat: 35.7, lng: 51.4, source: 'gps' }).success).toBe(true);
    expect(locationUpdateSchema.safeParse({ source: 'city', cityId: 112931 }).success).toBe(true);
    expect(locationUpdateSchema.safeParse({ source: 'city' }).success).toBe(false);
    expect(locationUpdateSchema.safeParse({ source: 'gps', lat: 35.7 }).success).toBe(false);
    expect(locationUpdateSchema.safeParse({ source: 'gps', lat: 95, lng: 0 }).success).toBe(false);
  });
});

describe('app_config helpers', () => {
  const routing = parseAppConfigValue('auth.sms_routing', {
    routes: [
      { prefix: '+98', providers: ['kavenegar', 'smsir'] },
      { prefix: '+9891', providers: ['smsir'] },
    ],
    default: ['telnyx'],
  });

  it('routes a number by its longest prefix, else by default', () => {
    expect(smsProvidersFor(routing, '+989351234567')).toEqual(['kavenegar', 'smsir']);
    expect(smsProvidersFor(routing, '+989121234567')).toEqual(['smsir']);
    expect(smsProvidersFor(routing, '+905321234567')).toEqual(['telnyx']);
    expect(smsProvidersFor({ ...routing, default: [] }, '+15551234567')).toEqual([]);
  });

  it('caps a prefix by its longest listed prefix', () => {
    const caps = parseAppConfigValue('auth.otp_caps', {
      resend_seconds: 60,
      phone_daily: 5,
      ip_hourly: 10,
      install_daily: 5,
      verify_ip_hourly: 30,
      prefix_hourly: { '+98': 5000, default: 200 },
    });
    expect(otpPrefixCap(caps, '+989121234567')).toEqual({ prefix: '+98', cap: 5000 });
    expect(otpPrefixCap(caps, '+15551234567')).toEqual({ prefix: 'default', cap: 200 });
  });

  it('refuses a bad value with the key in the message', () => {
    expect(() => parseAppConfigValue('auth.otp', { length: 3, ttl_seconds: 300, max_attempts: 5 })).toThrow(/auth\.otp/);
    expect(() => parseAppConfigValue('auth.sms_routing', { routes: [{ prefix: '98', providers: ['fake'] }], default: [] })).toThrow();
  });
});
