import { randomBytes } from 'node:crypto';
import type { AdminChatRow, AdminChatStoredRow } from '@app/db';
import { adminChatMessageSchema, adminChatSummarySchema, idFloor, idTime } from '@app/shared';
import { createPublicIds, encodeCallLineBody, type StoredMessage } from '@app/shared/server';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { adminMessageOf, chatSummaryOf, mergeMessagePage, sentShadowed } from '../src/admin/chats.js';
import { FULL_USER_SCOPE, type UserReadScope } from '../src/admin/refs.js';

/**
 * The pure parts of the admin chats read: the merge of the stored page with
 * the messages still in the stream (a stored row wins, nothing skipped, the
 * next page's bound, a read that stopped early), the conversation summary
 * (counts with pending messages, each once, who ended it, the retention
 * rule) and a message on the wire (sides, media, call lines, shadowban
 * records).
 */

const NOW = Date.UTC(2026, 10, 27, 12, 0, 0);
const DAY_MS = 86_400_000;
const SUBJECT = '1000001';
const OTHER = '1000002';
const MATCH = String(idFloor(NOW - 30 * DAY_MS) + 7n);
const NARROW: UserReadScope = { shadow: false, notes: false, holds: false, linked: false };

const publicIds = createPublicIds(randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url'));
const app = { publicIds, media: null } as unknown as FastifyInstance;

/** An id minted `secondsAgo` before NOW (plus a sequence, so ids of one second differ). */
let seq = 0n;
const idAt = (secondsAgo: number) => String(idFloor(NOW - secondsAgo * 1_000) + (seq += 1n));

function storedRow(id: string, extra: Partial<AdminChatStoredRow> = {}): AdminChatStoredRow {
  return { id, senderId: SUBJECT, refId: null, kind: 1, flags: 0, body: `stored ${id}`, unsendId: null, ...extra };
}

function pendingRow(id: string, extra: Partial<StoredMessage> = {}): StoredMessage {
  return { id, matchId: MATCH, senderId: OTHER, refId: null, kind: 1, flags: 0, body: `pending ${id}`, ...extra };
}

function chatRow(extra: Partial<AdminChatRow> = {}): AdminChatRow {
  return {
    id: MATCH,
    other: { id: OTHER, status: 3, name: 'Other', photo: null },
    side: 1,
    state: 1,
    source: 1,
    endedAtMs: null,
    endedBy: null,
    lastId: null,
    count: 0,
    storedSince: [],
    held: false,
    subjectSeesOther: true,
    otherSeesSubject: true,
    ...extra,
  };
}

describe('mergeMessagePage', () => {
  it('puts the pending messages after the stored ones, a stored row winning over its own pending copy', () => {
    const [s1, s2, both, p1, p2] = [idAt(50), idAt(40), idAt(30), idAt(20), idAt(10)] as [string, string, string, string, string];
    const stored = [storedRow(s1), storedRow(s2), storedRow(both, { flags: 2 })];
    const pending = [pendingRow(both, { flags: 0 }), pendingRow(p1), pendingRow(p2)];
    const { rows, next } = mergeMessagePage(stored, pending, { before: null, limit: 10, cutAt: null });
    expect(rows.map((r) => [r.id, r.pending])).toEqual([
      [s1, false],
      [s2, false],
      [both, false],
      [p1, true],
      [p2, true],
    ]);
    expect(rows.find((r) => r.id === both)?.flags).toBe(2);
    expect(next).toBeNull();
  });

  it('takes the newest `limit` of the union, so an older pending message waits for the next page', () => {
    const old = idAt(100);
    const ids = [idAt(90), idAt(80), idAt(70), idAt(60)];
    // Read with limit + 1 = 4 stored rows; one pending message older than all of them.
    const first = mergeMessagePage(ids.map((id) => storedRow(id)), [pendingRow(old)], { before: null, limit: 3, cutAt: null });
    expect(first.rows.map((r) => r.id)).toEqual(ids.slice(1));
    expect(first.next).toBe(ids[1]);
    // The next page (below its oldest shown) holds the stored row and the pending one, oldest first.
    const second = mergeMessagePage([storedRow(ids[0]!)], [pendingRow(old)], { before: ids[1]!, limit: 3, cutAt: null });
    expect(second.rows.map((r) => [r.id, r.pending])).toEqual([
      [old, true],
      [ids[0], false],
    ]);
    expect(second.next).toBeNull();
  });

  it('leaves pending messages at or above the page bound out, and says when more exist', () => {
    const [a, b, c] = [idAt(30), idAt(20), idAt(10)] as [string, string, string];
    const page = mergeMessagePage([], [pendingRow(a), pendingRow(b), pendingRow(c)], { before: b, limit: 5, cutAt: null });
    expect(page.rows.map((r) => r.id)).toEqual([a]);
    expect(mergeMessagePage([], [pendingRow(a), pendingRow(b), pendingRow(c)], { before: null, limit: 2, cutAt: null })).toMatchObject({ next: b });
  });

  it('stops at the cut of a read that stopped early, and hands it on as the next bound', () => {
    const [s1, s2, p1, cut, p2, s3] = [idAt(60), idAt(50), idAt(40), idAt(30), idAt(20), idAt(10)] as [string, string, string, string, string, string];
    // Everything at or above the cut was read; below it, messages not stored yet may be missing: nothing older shows.
    const page = mergeMessagePage([storedRow(s1), storedRow(s2), storedRow(s3)], [pendingRow(p1), pendingRow(p2)], { before: null, limit: 10, cutAt: cut });
    expect(page.rows.map((r) => r.id)).toEqual([p2, s3]);
    expect(page.next).toBe(cut);
    // A full page above the cut: its oldest row is the bound, as without one.
    const full = mergeMessagePage([storedRow(s3)], [pendingRow(p2)], { before: null, limit: 1, cutAt: cut });
    expect(full).toMatchObject({ next: s3 });
    expect(full.rows.map((r) => r.id)).toEqual([s3]);
    // The next page, below the cut, read to its end: the rest, and no further bound.
    const rest = mergeMessagePage([storedRow(s1), storedRow(s2)], [pendingRow(p1)], { before: cut, limit: 10, cutAt: null });
    expect(rest.rows.map((r) => r.id)).toEqual([s1, s2, p1]);
    expect(rest.next).toBeNull();
    // A read that found nothing above its cut: an empty page that still goes on.
    expect(mergeMessagePage([storedRow(s1)], [], { before: null, limit: 10, cutAt: cut })).toEqual({ rows: [], next: cut });
  });

  it('dates a taken-back message by its unsend, stored or pending, of the same sender only', () => {
    const [target, other, unsend, foreign] = [idAt(40), idAt(30), idAt(20), idAt(10)] as [string, string, string, string];
    const stored = [storedRow(target, { senderId: OTHER }), storedRow(other, { senderId: SUBJECT })];
    const pending = [pendingRow(unsend, { kind: 8, refId: target, senderId: OTHER, body: null }), pendingRow(foreign, { kind: 8, refId: other, senderId: OTHER, body: null })];
    const { rows } = mergeMessagePage(stored, pending, { before: null, limit: 10, cutAt: null });
    expect(rows.find((r) => r.id === target)?.unsendId).toBe(unsend);
    expect(rows.find((r) => r.id === other)?.unsendId).toBeNull();
    // The stored probe's answer stands.
    const probed = mergeMessagePage([storedRow(target, { unsendId: unsend })], [], { before: null, limit: 10, cutAt: null });
    expect(probed.rows[0]?.unsendId).toBe(unsend);
  });
});

describe('adminMessageOf', () => {
  it('names the sender by side, keeps hidden text, and shows media and call lines without a body', () => {
    const text = adminMessageOf({ ...storedRow(idAt(9), { flags: 2 }), pending: false }, SUBJECT, FULL_USER_SCOPE, []);
    expect(adminChatMessageSchema.parse(text)).toMatchObject({ from: 'subject', kind: 'text', flags: ['hidden'], shadowed: false, unsentAt: null });
    expect(text.body).toContain('stored');
    const image = adminMessageOf({ ...storedRow(idAt(8), { kind: 2, refId: '77', body: 'never shown', senderId: OTHER }), pending: true }, SUBJECT, FULL_USER_SCOPE, []);
    expect(image).toMatchObject({ from: 'other', kind: 'image', body: null, refId: '77', pending: true });
    const line = encodeCallLineBody({ kind: 'audio', outcome: 'missed', durationSeconds: 0, placedMs: NOW });
    const call = adminMessageOf({ ...storedRow(idAt(7), { kind: 5, refId: '88', body: line }), pending: false }, SUBJECT, FULL_USER_SCOPE, []);
    expect(call).toMatchObject({ kind: 'call', body: null, call: { kind: 'audio', outcome: 'missed', durationSeconds: 0 } });
    const notALine = adminMessageOf({ ...storedRow(idAt(6), { kind: 5, refId: '88', body: '{"v":2}' }), pending: false }, SUBJECT, FULL_USER_SCOPE, []);
    expect(notALine.call).toBeUndefined();
    const removed = adminMessageOf({ ...storedRow(idAt(5), { flags: 8, body: null, unsendId: idAt(4) }), pending: false }, SUBJECT, FULL_USER_SCOPE, []);
    expect(removed).toMatchObject({ body: null, flags: ['body_removed'] });
    expect(removed.unsentAt).not.toBeNull();
    // A caller who may not see shadowbans gets no such member at all.
    expect('shadowed' in adminMessageOf({ ...storedRow(idAt(3)), pending: false }, SUBJECT, NARROW, [])).toBe(false);
  });

  it("marks a message inside its sender's shadowban record, from its start up to (not at) its end", () => {
    const start = NOW - 10_000;
    const end = NOW - 5_000;
    const records = [{ userId: SUBJECT, startsAtMs: start, endsAtMs: end }, { userId: OTHER, startsAtMs: start, endsAtMs: null }];
    expect(sentShadowed(records, SUBJECT, start - 1)).toBe(false);
    expect(sentShadowed(records, SUBJECT, start)).toBe(true);
    expect(sentShadowed(records, SUBJECT, end - 1)).toBe(true);
    expect(sentShadowed(records, SUBJECT, end)).toBe(false);
    expect(sentShadowed(records, OTHER, NOW + DAY_MS)).toBe(true);
    expect(sentShadowed(records, '1000003', NOW)).toBe(false);
  });
});

describe('chatSummaryOf', () => {
  const options = { unmatchedDays: 7, nowMs: NOW };

  it('counts pending messages not stored yet, and dates the last activity by either', () => {
    const last = idAt(60);
    const newer = [pendingRow(idAt(30)), pendingRow(idAt(20), { kind: 7, refId: last }), pendingRow(idAt(10))];
    const summary = chatSummaryOf(app, chatRow({ lastId: last, count: 99, storedSince: [last] }), [pendingRow(last), ...newer], FULL_USER_SCOPE, options);
    expect(adminChatSummarySchema.parse(summary).messages).toEqual({ count: 100, more: true });
    expect(summary.lastActivityAt).toBe(new Date(idTime(newer.at(-1)!.id)).toISOString());
    expect(summary.other.id).toBe(publicIds.user.encode(OTHER));
    expect(summary.startedAt).toBe(new Date(idTime(MATCH)).toISOString());
    expect(chatSummaryOf(app, chatRow({ count: 3 }), [], FULL_USER_SCOPE, options).messages).toEqual({ count: 3, more: false });
  });

  it('counts a pending message older than a newer stored one (a call line written straight to the database)', () => {
    const [p1, p2] = [pendingRow(idAt(50)), pendingRow(idAt(40))];
    const line = idAt(30);
    // The call line is the newest stored row, so it is in storedSince; neither pending message is stored.
    const summary = chatSummaryOf(app, chatRow({ lastId: line, count: 2, storedSince: [line] }), [p1, p2], FULL_USER_SCOPE, options);
    expect(summary.messages).toEqual({ count: 4, more: false });
    expect(summary.lastActivityAt).toBe(new Date(idTime(line)).toISOString());
  });

  it('counts a pending message the writer stored meanwhile once, and reactions and unsends not at all', () => {
    const [kept, flushed, reaction, unsend, waiting] = [pendingRow(idAt(50)), pendingRow(idAt(40)), pendingRow(idAt(35), { kind: 7, refId: '1' }), pendingRow(idAt(33), { kind: 8, refId: '1', body: null }), pendingRow(idAt(30))];
    // `flushed` is in the stream still and stored already: storedSince names it.
    const row = chatRow({ lastId: flushed.id, count: 3, storedSince: [flushed.id] });
    const summary = chatSummaryOf(app, row, [kept, flushed, reaction, unsend, waiting], FULL_USER_SCOPE, options);
    expect(summary.messages).toEqual({ count: 5, more: false });
    expect(summary.lastActivityAt).toBe(new Date(idTime(waiting.id)).toISOString());
  });

  it("says who ended it from the subject's side", () => {
    const ended = { state: 2, endedAtMs: NOW - DAY_MS };
    expect(chatSummaryOf(app, chatRow({ ...ended, side: 1, endedBy: 1 }), [], FULL_USER_SCOPE, options).endedBy).toBe('subject');
    expect(chatSummaryOf(app, chatRow({ ...ended, side: 2, endedBy: 1 }), [], FULL_USER_SCOPE, options).endedBy).toBe('other');
    expect(chatSummaryOf(app, chatRow({ ...ended, side: 2, endedBy: 2 }), [], FULL_USER_SCOPE, options).endedBy).toBe('subject');
    expect(chatSummaryOf(app, chatRow({ ...ended, state: 4, side: 1, endedBy: 3 }), [], FULL_USER_SCOPE, options)).toMatchObject({ state: 'account_gone', endedBy: 'system' });
    expect(chatSummaryOf(app, chatRow(), [], FULL_USER_SCOPE, options)).toMatchObject({ endedBy: null, endedAt: null, lastActivityAt: null });
  });

  it('gives the retention rule only for an unmatch or block past it that keeps nothing, never under a hold', () => {
    // A match that never had a message reads the same: the rule, not a claim that anything was deleted.
    const past = { state: 2, endedBy: 1, endedAtMs: NOW - 8 * DAY_MS };
    expect(chatSummaryOf(app, chatRow(past), [], FULL_USER_SCOPE, options).retentionDays).toBe(7);
    expect(chatSummaryOf(app, chatRow({ ...past, state: 3 }), [], FULL_USER_SCOPE, options).retentionDays).toBe(7);
    expect(chatSummaryOf(app, chatRow({ ...past, endedAtMs: NOW - 6 * DAY_MS }), [], FULL_USER_SCOPE, options).retentionDays).toBeNull();
    expect(chatSummaryOf(app, chatRow({ ...past, held: true }), [], FULL_USER_SCOPE, options).retentionDays).toBeNull();
    // Under a hold the purge did not run: no deletion notice, whoever reads.
    expect(chatSummaryOf(app, chatRow({ ...past, held: true }), [], NARROW, options)).toMatchObject({ held: false, retentionDays: null });
    expect(chatSummaryOf(app, chatRow({ ...past, count: 1, lastId: idAt(9) }), [], FULL_USER_SCOPE, options).retentionDays).toBeNull();
    expect(chatSummaryOf(app, chatRow(past), [pendingRow(idAt(1))], FULL_USER_SCOPE, options).retentionDays).toBeNull();
    expect(chatSummaryOf(app, chatRow({ ...past, state: 4 }), [], FULL_USER_SCOPE, options).retentionDays).toBeNull();
  });

  it('shows holds and visibility only to callers who may see them', () => {
    const held = chatRow({ held: true, otherSeesSubject: false });
    expect(chatSummaryOf(app, held, [], FULL_USER_SCOPE, options)).toMatchObject({ held: true, visibility: { subjectSeesOther: true, otherSeesSubject: false } });
    const narrow = chatSummaryOf(app, held, [], NARROW, options);
    expect(narrow.held).toBe(false);
    expect('visibility' in narrow).toBe(false);
  });
});
