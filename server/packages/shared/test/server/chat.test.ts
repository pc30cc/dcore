import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { messagesPageSchema, receiptsSchema, sendMessageSchema } from '../../src/api/chat.js';
import { composeId, idTime } from '../../src/ids.js';
import {
  CentrifugoPresence,
  FakePresence,
  VIS_HI,
  VIS_LO,
  cacheChatState,
  cacheMatchState,
  endConversations,
  matchStateFence,
  MATCH_STATE_FENCE_SECONDS,
  readOpenChatState,
  chatKeys,
  createKeys,
  createPublicIds,
  dropConversationVisibility,
  encodeCallLineBody,
  largestIdAt,
  listEffectOf,
  messageEntryFields,
  messageOf,
  messagePushDue,
  moveReceipts,
  noteMessage,
  onlineOf,
  parseMessageEntry,
  previewOf,
  readChatState,
  readConversationTails,
  receiptAllowed,
  seedConversationTails,
  sendMessage,
  sidesVisible,
  storeConversationList,
  StreamEntryError,
  typingAllowed,
  useCounter,
  type ChatState,
  type StoredMessage,
} from '../../src/server/index.js';
import { dropPrefix, hasRedis, testPrefix, testRedis } from './support.js';

const ids = createPublicIds(Buffer.alloc(32, 7).toString('base64url'), Buffer.alloc(32, 9).toString('base64url'));

function idAt(ms: number, seq = 0): string {
  return composeId({ ms, generator: 3, sequence: seq }).toString();
}

describe('chat wire schemas', () => {
  it('refuse a send that does not say what it needs for its kind', () => {
    const clientId = '6f1c3a52-9f4e-4b7a-8d2e-3c9b1a7e5d40';
    expect(sendMessageSchema.safeParse({ clientId, kind: 'text', body: 'hi' }).success).toBe(true);
    expect(sendMessageSchema.safeParse({ clientId, kind: 'text', body: '   ' }).success).toBe(false);
    expect(sendMessageSchema.safeParse({ clientId, kind: 'text', body: 'a\u0000b' }).success).toBe(false);
    expect(sendMessageSchema.safeParse({ clientId, kind: 'reaction', body: '❤️' }).success).toBe(false);
    expect(sendMessageSchema.safeParse({ clientId, kind: 'reaction', body: '', refId: '12' }).success).toBe(true);
    expect(sendMessageSchema.safeParse({ clientId, kind: 'unsend', refId: '12', body: 'x' }).success).toBe(false);
    expect(sendMessageSchema.safeParse({ clientId: 'not-a-uuid', kind: 'text', body: 'hi' }).success).toBe(false);
    expect(receiptsSchema.safeParse({}).success).toBe(false);
  });
});

describe('wb:msg entries', () => {
  it('read what the send writes, and refuse what the table would refuse', () => {
    const m: StoredMessage = { id: '1001', matchId: '77', senderId: '5', refId: null, kind: 1, flags: 4, body: 'hello' };
    const flat = messageEntryFields(m);
    const fields: Record<string, string> = {};
    for (let i = 0; i < flat.length; i += 2) fields[flat[i]!] = flat[i + 1]!;
    expect(parseMessageEntry(fields)).toEqual(m);
    // An unsend has no body field at all; a removed reaction has an empty one.
    const unsend = messageEntryFields({ ...m, kind: 8, refId: '1000', body: null });
    expect(unsend).not.toContain('b');
    const reaction = { ...fields, k: '7', r: '1000', b: '' };
    expect(parseMessageEntry(reaction).body).toBe('');
    expect(() => parseMessageEntry({ ...fields, b: 'a\u0000' })).toThrow(StreamEntryError);
    expect(() => parseMessageEntry({ ...fields, k: '9' })).toThrow(StreamEntryError);
    expect(() => parseMessageEntry({ ...fields, k: '7' })).toThrow(StreamEntryError); // a reaction names its message
    const { b: _b, ...noBody } = fields;
    expect(() => parseMessageEntry(noBody)).toThrow(StreamEntryError);
  });

  it('render a message as both people read it: no hidden text, a call line as its call', () => {
    const at = Date.UTC(2026, 10, 6, 9, 14, 3, 120);
    const sender = '123456789';
    const text = messageOf({ publicIds: ids }, { id: idAt(at), matchId: '77', senderId: sender, refId: null, kind: 1, flags: 0, body: 'hi' }, { clientId: 'c-1' });
    expect(text).toEqual({ id: idAt(at), conversationId: '77', senderId: ids.user.encode(sender), clientId: 'c-1', kind: 'text', body: 'hi', at: '2026-11-06T09:14:03.120Z' });
    const hidden = messageOf({ publicIds: ids }, { id: idAt(at), matchId: '77', senderId: sender, refId: null, kind: 1, flags: 2, body: 'gone' });
    expect(hidden.body).toBeUndefined();
    const body = encodeCallLineBody({ kind: 'video', outcome: 'completed', durationSeconds: 75, placedMs: at - 80_000 });
    const line = messageOf({ publicIds: ids }, { id: idAt(at), matchId: '77', senderId: sender, refId: '555', kind: 5, flags: 0, body });
    expect(line.body).toBeUndefined();
    expect(line.call).toEqual({ callId: '555', kind: 'video', outcome: 'completed', placedAt: new Date(at - 80_000).toISOString(), durationSeconds: 75, caller: ids.user.encode(sender) });
    expect(previewOf({ kind: 1, body: 'x'.repeat(100) })).toHaveLength(64);
    expect(listEffectOf(7)).toBe('reaction');
    expect(listEffectOf(8)).toBe('unsend');
    expect(listEffectOf(5)).toBe('news');
    expect(messagesPageSchema.safeParse({ items: [text], hasMore: false, syncCursor: text.id, readCursors: {} }).success).toBe(true);
  });

  it('bound pointers at the largest id that can exist now', () => {
    const now = Date.now();
    expect(BigInt(largestIdAt(now)) > BigInt(idAt(now, 4000))).toBe(true);
    expect(idTime(largestIdAt(now)).getTime()).toBe(now);
  });
});

describe('presence', () => {
  it('asks Centrifugo once for a page of people and reads its batch answer', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const presence = new CentrifugoPresence({
      apiUrl: 'http://centrifugo.test/',
      apiKey: 'k'.repeat(16),
      fetch: async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') });
        return new Response(JSON.stringify({ replies: [{ presence_stats: { num_clients: 2, num_users: 1 } }, { presence_stats: { num_clients: 0, num_users: 0 } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const a = ids.user.encode('11');
    const b = ids.user.encode('12');
    const online = await presence.online([a, b]);
    expect([...online]).toEqual([
      [a, true],
      [b, false],
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://centrifugo.test/api/batch');
    expect(calls[0]!.body).toEqual({ commands: [{ presence_stats: { channel: `u:#${a}` } }, { presence_stats: { channel: `u:#${b}` } }], parallel: true });
  });
});

describe.skipIf(!hasRedis)('chat state in Valkey (with a key prefix)', () => {
  let redis: Redis;
  const prefix = testPrefix();
  const keys = createKeys(prefix);
  const c = chatKeys(keys);
  let seq = 0;

  beforeAll(() => {
    redis = testRedis();
  });

  afterAll(async () => {
    await dropPrefix(redis, prefix);
    await redis.quit();
  });

  function conversation(over: Partial<ChatState> = {}): ChatState {
    seq += 1;
    const lo = String(1_000 + seq * 10);
    const hi = String(1_000 + seq * 10 + 1);
    return { id: String(900_000 + seq), lo, hi, state: 1, flags: 3, source: 1, createdMs: Date.now() - 60_000, vis: VIS_LO | VIS_HI, ...over };
  }

  function message(s: ChatState, sender: string, over: Partial<StoredMessage> = {}): StoredMessage {
    seq += 1;
    return { id: idAt(Date.now(), seq % 4000), matchId: s.id, senderId: sender, refId: null, kind: 1, flags: 0, body: `m${seq}`, ...over };
  }

  async function entries(): Promise<Record<string, string>[]> {
    const raw = (await redis.xrange(keys.stream('msg'), '-', '+')) as [string, string[]][];
    return raw.map(([, flat]) => {
      const fields: Record<string, string> = {};
      for (let i = 0; i < flat.length; i += 2) fields[flat[i]!] = flat[i + 1]!;
      return fields;
    });
  }

  it('appends once, answers a retry with the first record, and moves the list state', async () => {
    const s = conversation();
    await cacheChatState(redis, keys, s);
    await storeConversationList(redis, keys, s.lo, [{ id: s.id, score: s.createdMs }]);
    const m = message(s, s.lo);
    const first = await sendMessage(redis, keys, s.lo, s.hi, { message: m, clientId: 'c1', deliver: true });
    expect(first.outcome).toBe('sent');
    const again = await sendMessage(redis, keys, s.lo, s.hi, { message: { ...m, id: idAt(Date.now(), 4001), body: 'changed' }, clientId: 'c1', deliver: true });
    expect(again).toEqual({ outcome: 'replay', record: { i: m.id, m: m.matchId, k: 1, f: 0, b: m.body } });
    expect((await entries()).filter((e) => e['m'] === s.id)).toHaveLength(1);
    // The recipient counts it, the sender does not; the newest message and the order moved.
    expect(await redis.hget(c.unread(s.hi), s.id)).toBe('1');
    expect(await redis.hget(c.unread(s.lo), s.id)).toBeNull();
    expect(await redis.hget(c.lastMessage(s.id), 'id')).toBe(m.id);
    expect(Number(await redis.zscore(keys.conversationList(s.lo), s.id))).toBe(idTime(m.id).getTime());
    expect(await redis.get(keys.conversationVersion(s.hi))).not.toBeNull();
  });

  it('refuses an ended conversation (its tombstone), a stranger, and asks for an expired state', async () => {
    const s = conversation();
    await cacheChatState(redis, keys, s);
    expect((await sendMessage(redis, keys, s.lo, s.hi, { message: message(s, '42'), clientId: 'c2', deliver: true })).outcome).toBe('notmember');
    await redis.set(keys.matchEnded(s.id), 1, 'EX', 60);
    expect((await sendMessage(redis, keys, s.lo, s.hi, { message: message(s, s.lo), clientId: 'c3', deliver: true })).outcome).toBe('ended');
    const t = conversation();
    expect((await sendMessage(redis, keys, t.lo, t.hi, { message: message(t, t.lo), clientId: 'c4', deliver: true })).outcome).toBe('nostate');
    expect((await entries()).filter((e) => e['m'] === s.id || e['m'] === t.id)).toHaveLength(0);
  });

  it('keeps the newest message by id, leaves reactions out of the list, and makes an unsend of the newest its preview', async () => {
    const s = conversation();
    await cacheChatState(redis, keys, s);
    const newer = message(s, s.hi);
    const older = { ...message(s, s.lo), id: idAt(Date.now() - 10_000) };
    await sendMessage(redis, keys, s.lo, s.hi, { message: newer, clientId: 'n1', deliver: true });
    await sendMessage(redis, keys, s.lo, s.hi, { message: older, clientId: 'n2', deliver: true });
    expect(await redis.hget(c.lastMessage(s.id), 'id')).toBe(newer.id);
    const reaction = message(s, s.lo, { kind: 7, refId: newer.id, body: '❤️' });
    await sendMessage(redis, keys, s.lo, s.hi, { message: reaction, clientId: 'n3', deliver: true });
    expect(await redis.hget(c.lastMessage(s.id), 'id')).toBe(newer.id);
    expect(await redis.hget(c.unread(s.hi), s.id)).toBe('1'); // only the older text, not the reaction
    const unsend = message(s, s.hi, { kind: 8, refId: newer.id, body: null });
    await sendMessage(redis, keys, s.lo, s.hi, { message: unsend, clientId: 'n4', deliver: true });
    expect(await redis.hgetall(c.lastMessage(s.id))).toMatchObject({ id: unsend.id, k: '8', r: newer.id, p: '' });
  });

  it('keeps a hidden sender on their own side: nobody else counts or is told', async () => {
    const s = conversation({ vis: VIS_HI });
    await cacheChatState(redis, keys, s);
    expect(sidesVisible(s, 'lo')).toEqual({ mine: false, peer: true });
    await sendMessage(redis, keys, s.lo, s.hi, { message: message(s, s.lo), clientId: 's1', deliver: false });
    expect(await redis.hget(c.unread(s.hi), s.id)).toBeNull();
    expect(await redis.zscore(keys.conversationList(s.hi), s.id)).toBeNull();
    expect(await redis.zscore(keys.conversationList(s.lo), s.id)).not.toBeNull();
  });

  it('moves read and delivered pointers only forward, clamps them, clears unread at the newest, flags the flush', async () => {
    const s = conversation();
    await cacheChatState(redis, keys, s);
    const m1 = message(s, s.lo);
    const m2 = message(s, s.lo);
    await sendMessage(redis, keys, s.lo, s.hi, { message: m1, clientId: 'r1', deliver: true });
    await sendMessage(redis, keys, s.lo, s.hi, { message: m2, clientId: 'r2', deliver: true });
    expect(await redis.hget(c.unread(s.hi), s.id)).toBe('2');
    const maxId = largestIdAt(Date.now() + 5_000);
    const read1 = await moveReceipts(redis, keys, { matchId: s.id, readerId: s.hi, side: 'hi', readUpTo: m1.id, maxId });
    expect(read1).toEqual({ readMoved: m1.id, deliveredMoved: null, read: m1.id, delivered: m1.id });
    expect(await redis.hget(c.unread(s.hi), s.id)).toBe('2'); // the newest is not read yet
    expect(await redis.sismember(c.readDirty(), s.id)).toBe(1);
    const back = await moveReceipts(redis, keys, { matchId: s.id, readerId: s.hi, side: 'hi', readUpTo: '1', deliveredUpTo: '1', maxId });
    expect(back.readMoved).toBeNull();
    expect(back.deliveredMoved).toBeNull();
    const far = await moveReceipts(redis, keys, { matchId: s.id, readerId: s.hi, side: 'hi', readUpTo: '922337203685477580', maxId });
    expect(far.readMoved).toBe(maxId);
    // Kept as 0 (with the hash's lifetime), so a list rebuilt from the database before the flush keeps it.
    expect(await redis.hget(c.unread(s.hi), s.id)).toBe('0');
    expect(await redis.ttl(c.unread(s.hi))).toBeGreaterThan(0);
    expect(await redis.get(c.viewing(s.hi))).toBe(s.id);
    const tails = await readConversationTails(redis, keys, s.hi, [s.id]);
    expect(tails.get(s.id)).toMatchObject({ unread: 0, unreadKept: true, read: { hi: maxId, lo: null }, delivered: { hi: maxId } });
  });

  it('notes a message written elsewhere only while the conversation lives, and never over a newer preview', async () => {
    const s = conversation();
    const newer = message(s, s.hi);
    await noteMessage(redis, keys, { message: newer, lo: s.lo, hi: s.hi, unreadFor: 'lo' });
    const older = { ...message(s, s.lo, { kind: 6, refId: null, body: 'note' }), id: idAt(Date.now() - 60_000) };
    expect(await noteMessage(redis, keys, { message: older, lo: s.lo, hi: s.hi, unreadFor: 'hi' })).toBe(false);
    expect(await redis.hget(c.lastMessage(s.id), 'id')).toBe(newer.id);
    expect(await redis.hget(c.unread(s.lo), s.id)).toBe('1');
    await redis.set(keys.matchEnded(s.id), 1, 'EX', 60);
    expect(await noteMessage(redis, keys, { message: message(s, s.hi), lo: s.lo, hi: s.hi, unreadFor: 'lo' })).toBe(false);
    expect(await redis.hget(c.unread(s.lo), s.id)).toBe('1');
  });

  it('seeds the list state only where Valkey holds none', async () => {
    const s = conversation();
    const kept = message(s, s.lo);
    await noteMessage(redis, keys, { message: kept, lo: s.lo, hi: s.hi, unreadFor: null });
    const t = conversation();
    await seedConversationTails(redis, keys, [
      { matchId: s.id, last: { ...kept, id: '5', body: 'old' }, loReadId: '0', hiReadId: '3' },
      { matchId: t.id, last: null, loReadId: '0', hiReadId: '0' },
    ]);
    const tails = await readConversationTails(redis, keys, s.lo, [s.id, t.id]);
    expect(tails.get(s.id)?.last?.id).toBe(kept.id);
    expect(tails.get(s.id)?.read).toEqual({ lo: null, hi: '3' });
    expect(tails.get(t.id)?.last?.id).toBe('0');
  });

  it('keeps visibility with the state and drops it when a person changes', async () => {
    const s = conversation({ vis: VIS_LO });
    expect(await cacheChatState(redis, keys, s)).toBe('cached');
    await storeConversationList(redis, keys, s.lo, [{ id: s.id, score: 1 }]);
    expect((await readChatState(redis, keys, s.id))?.vis).toBe(VIS_LO);
    expect(await dropConversationVisibility(redis, keys, s.lo)).toBe(1);
    const after = await readChatState(redis, keys, s.id);
    expect(after?.vis).toBeNull();
    expect(after?.lo).toBe(s.lo);
    // A state read before the change (the old visibility) is not cached again for a moment.
    expect(await cacheChatState(redis, keys, { ...s, vis: 3 })).toBe('fenced');
    expect((await readChatState(redis, keys, s.id))?.vis).toBeNull();
    const fence = await redis.ttl(matchStateFence(keys, s.id));
    expect(fence).toBeGreaterThan(0);
    expect(fence).toBeLessThanOrEqual(MATCH_STATE_FENCE_SECONDS);
    await redis.del(matchStateFence(keys, s.id));
    expect(await cacheChatState(redis, keys, { ...s, vis: VIS_HI })).toBe('cached');
    expect((await readChatState(redis, keys, s.id))?.vis).toBe(VIS_HI);
  });

  it('never caches the state of a conversation that ended, and reads its end with any copy left', async () => {
    const s = conversation({ vis: 3 });
    expect(await cacheChatState(redis, keys, s)).toBe('cached');
    expect(await readOpenChatState(redis, keys, s.id)).toEqual({ ended: false, state: s });
    await endConversations({ redis, cache: redis, keys }, [{ matchId: s.id, lo: s.lo, hi: s.hi }]);
    // A state read from PostgreSQL just before the end: refused, nothing written.
    expect(await cacheChatState(redis, keys, s)).toBe('ended');
    expect(await cacheMatchState(redis, keys, s)).toBe('ended');
    expect(await redis.exists(keys.matchState(s.id))).toBe(0);
    // A copy that is still there (written before the tombstone existed) reads as ended.
    await redis.hset(keys.matchState(s.id), { lo: s.lo, hi: s.hi, st: 1, fl: 3, src: 1, at: s.createdMs, vis: 3 });
    expect(await readOpenChatState(redis, keys, s.id)).toEqual({ ended: true, state: null });
  });

  it('gates typing, receipts and message pushes in Valkey', async () => {
    expect(await typingAllowed(redis, keys, '77')).toBe(true);
    expect(await typingAllowed(redis, keys, '77')).toBe(false);
    expect(await receiptAllowed(redis, keys, '77', '9', 'r')).toBe(true);
    expect(await receiptAllowed(redis, keys, '77', '9', 'r')).toBe(false);
    expect(await receiptAllowed(redis, keys, '77', '9', 'd')).toBe(true);
    await redis.set(c.viewing('78'), '9', 'EX', 30);
    expect(await messagePushDue(redis, keys, '9', '78')).toBe(false);
    expect(await messagePushDue(redis, keys, '9', '79')).toBe(true);
    expect(await messagePushDue(redis, keys, '9', '79')).toBe(false);
    expect(await useCounter(redis, keys.quota('dm', '77', 'x'), 1, 60)).toEqual({ allowed: true, used: 1 });
    expect((await useCounter(redis, keys.quota('dm', '77', 'x'), 1, 60)).allowed).toBe(false);
  });

  it('asks presence once per half minute per person', async () => {
    const reader = new FakePresence();
    reader.onlineUids.add(ids.user.encode('501'));
    const lookup = { cache: redis, keys, reader, publicUidOf: (id: string) => ids.user.encode(id) };
    const first = await onlineOf(lookup, ['501', '502']);
    expect([...first]).toEqual([
      ['501', true],
      ['502', false],
    ]);
    await onlineOf(lookup, ['501', '502']);
    expect(reader.calls).toBe(1);
  });
});
