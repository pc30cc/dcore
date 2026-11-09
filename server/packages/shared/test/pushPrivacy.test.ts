import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { pushDataSchema, pushPayload, pushTypes, type PushType } from '../src/index.js';

/**
 * No push names a person (docs: push rules): the contract's data keys hold
 * only ids of things (a call, a conversation, a message, a request, a
 * ticket, a campaign), never of a person; the fixtures the Android tests
 * decode are valid payloads of their types and carry no e-mail address,
 * phone number or person id; and a payload refuses any key the contract
 * does not list.
 */

const FIXTURES = fileURLToPath(new URL('../fixtures/push', import.meta.url));
const PERSON_KEY = /user|uid|public|email|mail|phone|msisdn|caller|callee|sender|peerId|token|device/i;
const EMAIL = /[^\s@"]+@[^\s@"]+\.[a-z]{2,}/i;
// A phone number: a + and digits, or 10-13 digits in a row (ids are 19 digits, counts short).
const PHONE = /\+\d|(?<![0-9])\d{10,13}(?![0-9])|\b\d{3}[ .-]\d{3}[ .-]\d{4}\b/;

describe('push payloads name nobody (fixture scan)', () => {
  it('every push type has a fixture, and every fixture is a valid payload of its type', () => {
    const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.json'));
    expect(files.map((f) => f.replace(/\.json$/, '')).sort()).toEqual(Object.keys(pushTypes).sort());
    for (const file of files) {
      const data = JSON.parse(readFileSync(`${FIXTURES}/${file}`, 'utf8')) as Record<string, unknown>;
      const parsed = pushDataSchema.parse(data) as Record<string, string>;
      expect(parsed['type'], file).toBe(file.replace(/\.json$/, '') as PushType);
      for (const value of Object.values(data)) expect(typeof value, `${file}: FCM data values are strings`).toBe('string');
      for (const [key, value] of Object.entries(data)) {
        const text = String(value);
        expect(text, `${file}: ${key} holds an e-mail address`).not.toMatch(EMAIL);
        // A signed link's expiry is a number in its query: a link is checked without its query.
        const plain = key.endsWith('Url') ? text.split('?')[0]! : text;
        expect(plain, `${file}: ${key} holds a phone number`).not.toMatch(PHONE);
      }
      for (const key of Object.keys(data)) expect(key, `${file}: a key naming a person`).not.toMatch(PERSON_KEY);
    }
  });

  it('no type of the contract has a key that could carry a person', () => {
    for (const [type, spec] of Object.entries(pushTypes)) {
      for (const key of Object.keys(spec.data.shape)) {
        expect(key, `${type}.${key}`).not.toMatch(PERSON_KEY);
      }
    }
  });

  it('refuses a key the contract does not list, so nothing extra can leak into a push', () => {
    expect(() => pushPayload('message', { conversationId: '12', messageId: '34', userId: '56' } as never, { text: { title: 'New message', body: '' } })).toThrow();
    expect(() => pushPayload('call_incoming', { callId: '1', conversationId: '2', kind: 'audio', peerName: 'Sam', expiresAt: '2026-11-06T09:15:45.000Z', callerId: '9' } as never)).toThrow();
    expect(() => pushPayload('like', { total: '1', from: 'abcdefghijklm' } as never, { text: { title: 'a', body: 'b' } })).toThrow();
  });

  it('keeps the lock screen private for every push that can name someone or carry text', () => {
    for (const type of ['message', 'match', 'request', 'call_missed'] as const) expect(pushTypes[type].visibility, type).toBe('private');
    // Rings and their stops are data only: the app draws them, with a public version of its own.
    for (const type of ['call_incoming', 'call_cancel'] as const) expect(pushTypes[type].kind, type).toBe('data');
  });
});
