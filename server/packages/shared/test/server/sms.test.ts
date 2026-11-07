import { describe, expect, it } from 'vitest';
import {
  FakeSmsSender,
  KavenegarSender,
  SmsError,
  SmsIrSender,
  SmsRouter,
  SmsRoutingError,
  TelnyxSender,
  nationalIr,
  type Fetch,
  type OtpMessage,
} from '../../src/server/index.js';

/** A fetch that records the request and answers with `reply`. */
function stub(reply: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: Fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return reply(url, init ?? {});
  };
  return { fetch, calls };
}

const bodyText = (call: { init: RequestInit } | undefined): string => (typeof call?.init.body === 'string' ? call.init.body : '');
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const message = (phone: string, channel: 'sms' | 'call' = 'sms'): OtpMessage => ({ phone, code: '482913', appName: '', locale: 'fa', channel });

describe('national form for +98 gateways', () => {
  it('turns +98 mobile numbers into 09…, and nothing else', () => {
    expect(nationalIr('+989121234567')).toBe('09121234567');
    expect(nationalIr('+982188776655')).toBeNull();
    expect(nationalIr('+905321234567')).toBeNull();
  });
});

describe('Kavenegar', () => {
  it('sends the verify lookup with the template and the code, the key only in the path', async () => {
    const { fetch, calls } = stub(() => json(200, { return: { status: 200, message: 'ok' }, entries: [{ messageid: 8792343 }] }));
    const sender = new KavenegarSender({ apiKey: 'AbCdEf0123456789', template: 'signin', fetch, baseUrl: 'https://kv.test' });
    const receipt = await sender.send(message('+989121234567'));
    expect(receipt).toEqual({ provider: 'kavenegar', messageId: '8792343' });
    expect(calls[0]?.url).toBe('https://kv.test/v1/AbCdEf0123456789/verify/lookup.json');
    expect(Object.fromEntries(new URLSearchParams(bodyText(calls[0])))).toEqual({ receptor: '09121234567', token: '482913', template: 'signin' });
    await sender.send(message('+989121234567', 'call'));
    expect(new URLSearchParams(bodyText(calls[1])).get('type')).toBe('call');
  });

  it('classifies failures: 411 refused, credit and key problems hand over, errors never carry the key', async () => {
    const answers = [411, 418, 403, 500];
    const { fetch } = stub(() => {
      const status = answers.shift() ?? 500;
      return json(status, { return: { status, message: 'x' }, entries: null });
    });
    const sender = new KavenegarSender({ apiKey: 'AbCdEf0123456789', template: 'signin', fetch });
    const kinds: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const error = await sender.send(message('+989121234567')).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SmsError);
      expect(String((error as Error).message)).not.toContain('AbCdEf0123456789');
      kinds.push((error as SmsError).kind);
    }
    expect(kinds).toEqual(['rejected', 'unavailable', 'unavailable', 'unavailable']);
  });

  it('hands numbers outside +98 to the next provider, and a timeout too', async () => {
    const { fetch } = stub(() => {
      throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    });
    const sender = new KavenegarSender({ apiKey: 'AbCdEf0123456789', template: 'signin', fetch });
    await expect(sender.send(message('+905321234567'))).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(sender.send(message('+989121234567'))).rejects.toMatchObject({ kind: 'unavailable', message: 'kavenegar: timed out' });
  });
});

describe('sms.ir', () => {
  it('posts the template id and the code parameter with the key header', async () => {
    const { fetch, calls } = stub(() => json(200, { status: 1, message: 'ok', data: { messageId: 991, cost: 1 } }));
    const sender = new SmsIrSender({ apiKey: 'key-0123456789', templateId: 123456, fetch, baseUrl: 'https://si.test' });
    expect(await sender.send(message('+989121234567'))).toEqual({ provider: 'smsir', messageId: '991' });
    expect(calls[0]?.url).toBe('https://si.test/v1/send/verify');
    expect((calls[0]?.init.headers as Record<string, string>)['x-api-key']).toBe('key-0123456789');
    expect(JSON.parse(bodyText(calls[0]))).toEqual({ mobile: '09121234567', templateId: 123456, parameters: [{ name: 'CODE', value: '482913' }] });
  });

  it('hands every failure over, has no voice channel', async () => {
    const { fetch } = stub(() => json(400, { status: 102, message: 'x', data: null }));
    const sender = new SmsIrSender({ apiKey: 'key-0123456789', templateId: 1, fetch });
    await expect(sender.send(message('+989121234567'))).rejects.toMatchObject({ kind: 'unavailable' });
    expect(sender.channels).toEqual(['sms']);
  });
});

describe('Telnyx Verify', () => {
  it('sends our own code through the verify profile, SMS or call', async () => {
    const { fetch, calls } = stub(() => json(200, { data: { id: '12ade33a-21c0-473b-b055-b3c836e1c292', type: 'sms', status: 'pending' } }));
    const sender = new TelnyxSender({ apiKey: 'KEY0123456789abcdef', verifyProfileId: '4900017a-e7c8-e79e-0a7c-0d98f49b09cc', timeoutSeconds: 300, fetch, baseUrl: 'https://tx.test' });
    expect(await sender.send(message('+14155550123'))).toEqual({ provider: 'telnyx', messageId: '12ade33a-21c0-473b-b055-b3c836e1c292' });
    expect(calls[0]?.url).toBe('https://tx.test/v2/verifications/sms');
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe('Bearer KEY0123456789abcdef');
    expect(JSON.parse(bodyText(calls[0]))).toEqual({
      phone_number: '+14155550123',
      verify_profile_id: '4900017a-e7c8-e79e-0a7c-0d98f49b09cc',
      custom_code: '482913',
      timeout_secs: 300,
    });
    await sender.send(message('+14155550123', 'call'));
    expect(calls[1]?.url).toBe('https://tx.test/v2/verifications/call');
  });

  it('refuses a number it points at, hands over everything else', async () => {
    const answers = [
      json(422, { errors: [{ code: '10002', title: 'Invalid phone number', source: { pointer: '/phone_number' } }] }),
      json(401, { errors: [{ code: '10009', title: 'Authentication failed' }] }),
      json(503, {}),
    ];
    const { fetch } = stub(() => answers.shift() ?? json(500, {}));
    const sender = new TelnyxSender({ apiKey: 'KEY0123456789abcdef', verifyProfileId: '4900017a-e7c8-e79e-0a7c-0d98f49b09cc', fetch });
    const kinds = [];
    for (let i = 0; i < 3; i += 1) kinds.push(((await sender.send(message('+14155550123')).catch((e: unknown) => e)) as SmsError).kind);
    expect(kinds).toEqual(['rejected', 'unavailable', 'unavailable']);
  });
});

describe('SMS routing', () => {
  it('fails over in order, skips providers that are not configured, and remembers an outage', async () => {
    let now = 0;
    const a = new FakeSmsSender('kavenegar');
    const b = new FakeSmsSender('smsir');
    a.fail = 'unavailable';
    const router = new SmsRouter([a, b], { coolDownMs: 1_000, now: () => now });
    const first = await router.send(['telnyx', 'kavenegar', 'smsir'], message('+989121234567'));
    expect(first).toMatchObject({ provider: 'smsir', channel: 'sms', failedOver: ['kavenegar'] });
    a.fail = null;
    // Cooling down: kavenegar is skipped while smsir works.
    expect((await router.send(['kavenegar', 'smsir'], message('+989121234567'))).provider).toBe('smsir');
    now = 2_000;
    expect((await router.send(['kavenegar', 'smsir'], message('+989121234567'))).provider).toBe('kavenegar');
  });

  it('uses the development stand-in only when none of the number\'s providers is configured', async () => {
    const stand = new FakeSmsSender('fake');
    const real = new FakeSmsSender('telnyx');
    const router = new SmsRouter([real, stand], { fallback: stand });
    expect((await router.send(['kavenegar', 'smsir'], message('+989121234567'))).provider).toBe('fake');
    expect((await router.send(['telnyx'], message('+14155550123'))).provider).toBe('telnyx');
    real.fail = 'unavailable';
    await expect(router.send(['telnyx'], message('+14155550123'))).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('stops at a refusal, reports nobody able to send, and calls before falling back to SMS', async () => {
    const a = new FakeSmsSender('kavenegar');
    const b = new FakeSmsSender('smsir');
    const router = new SmsRouter([a, b]);
    a.fail = 'rejected';
    await expect(router.send(['kavenegar', 'smsir'], message('+989121234567'))).rejects.toMatchObject({ kind: 'rejected' });
    expect(b.sent).toHaveLength(0);
    a.fail = 'unavailable';
    b.fail = 'unavailable';
    const error = await router.send(['kavenegar', 'smsir'], message('+989121234567')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SmsRoutingError);
    expect((error as SmsRoutingError).kind).toBe('unavailable');
    await expect(new SmsRouter([]).send(['telnyx'], message('+14155550123'))).rejects.toMatchObject({ kind: 'unavailable' });

    const caller = new FakeSmsSender('telnyx');
    const textOnly = new SmsIrSender({ apiKey: 'key-0123456789', templateId: 1, fetch: async () => json(200, { status: 1, data: { messageId: 1 } }) });
    const mixed = new SmsRouter([textOnly, caller]);
    expect(await mixed.send(['smsir', 'telnyx'], message('+989121234567', 'call'))).toMatchObject({ provider: 'telnyx', channel: 'call' });
    caller.fail = 'unavailable';
    expect(await mixed.send(['smsir', 'telnyx'], message('+989121234567', 'call'))).toMatchObject({ provider: 'smsir', channel: 'sms' });
  });
});
