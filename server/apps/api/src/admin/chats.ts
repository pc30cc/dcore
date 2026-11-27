import type { AdminChatRow, AdminChatShadowRow, AdminChatStoredRow } from '@app/db';
import { idFloor, idTime, matchSource, matchState, messageKind, wireTime, type AdminChatMessage, type AdminChatSummary } from '@app/shared';
import { decodeCallLineBody, FLAG, KIND, parseMessageEntry, readWatermark, type KeyBuilder, type StoredMessage } from '@app/shared/server';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { messageFlagNames, userRefOf, type UserReadScope } from './refs.js';

/**
 * The read side of the admin user page's chats: the messages still in the
 * write-behind stream, merged with the stored page, and both mapped to the
 * admin wire.
 *
 * The stream read sends only `GET` (the flush watermark) and `XREVRANGE`
 * (`wb:msg` above it): no consumer group command, no acknowledgement, no
 * script, no write. Nothing here touches the conversation's list state,
 * read or delivered pointers, unread counts, caches or realtime channels.
 * Message text never reaches a log line: a malformed entry is skipped
 * without logging it, and a failed read logs the error only.
 *
 * What bounds a read: every entry not yet durable has an id at or above the
 * watermark, so a page whose cursor is at or below it reads no stream; a
 * page with a cursor reads only the entries that can hold its messages (up
 * to the cursor's time plus the writer's margin); and one read takes at
 * most `scanMax` entries (`hardMax` to get below a cursor). When it stops
 * early, the page stops where it did (`cutAt`) and the next page goes on
 * from there, so nothing is skipped.
 */

export interface StreamReadLimits {
  /** Entries per XREVRANGE, newest first. */
  pageSize: number;
  /** Entries one read takes before it may stop. */
  scanMax: number;
  /** Entries one read takes at most (past `scanMax` only to get below a page's cursor). */
  hardMax: number;
  /** How long before its XADD an id may be minted: the writer's watermark margin. */
  mintMarginMs: number;
  /** How far an API host's clock may run ahead of Valkey's. */
  clockSlackMs: number;
}

export const STREAM_READ_LIMITS: Readonly<StreamReadLimits> = {
  pageSize: 1_000,
  scanMax: 5_000,
  hardMax: 10_000,
  mintMarginMs: 5_000,
  clockSlackMs: 1_000,
};

const DAY_MS = 86_400_000;

/** How a read of the stream went (the wire's `stream`). */
export type StreamRead = 'complete' | 'backlog' | 'partial';

export interface PendingMessages {
  /** Per conversation, oldest first: the messages not yet durable (at or above the watermark). */
  byMatch: Map<string, StoredMessage[]>;
  read: StreamRead;
  /** With `backlog`: every message not yet durable at or above this id was read; below it, not all. */
  cutAt: string | null;
}

export interface PendingQuery {
  /** Only these conversations' messages; null: every conversation's, without their bodies. */
  matchIds: ReadonlySet<string> | null;
  /** Only messages below this id (a page's cursor); null: no bound. */
  before?: string | null;
}

const byId = (a: { id: string }, b: { id: string }) => {
  const x = BigInt(a.id);
  const y = BigInt(b.id);
  return x < y ? -1 : x > y ? 1 : 0;
};

const streamMs = (entryId: string) => Number(entryId.slice(0, entryId.indexOf('-')));

function fieldOf(flat: readonly string[], name: string): string | undefined {
  for (let i = 0; i + 1 < flat.length; i += 2) if (flat[i] === name) return flat[i + 1];
  return undefined;
}

/** The lowest id of the messages (null: none). */
export function lowestId(messages: Iterable<{ id: string }>): string | null {
  let low: bigint | null = null;
  for (const m of messages) {
    const n = BigInt(m.id);
    if (low === null || n < low) low = n;
  }
  return low === null ? null : low.toString();
}

/**
 * The messages in `wb:msg` that PostgreSQL may not have yet. Every entry
 * not yet written has a stream time of at least the watermark's time plus
 * the writer's margin, so the scan starts at the watermark's time; entries
 * below the watermark (durable) are left to the database read. Without a
 * watermark (no writer ran since Valkey was emptied) the whole stream is
 * read, up to the limits.
 *
 * Stopping early at the oldest entry read (time T), every entry not read
 * has a stream time of at most T, and so (its id minted before its XADD,
 * on clocks within `clockSlackMs`) an id below `cutAt`.
 */
export async function pendingMessagesOf(
  app: { redis: Redis; keys: KeyBuilder },
  log: FastifyBaseLogger,
  query: PendingQuery,
  overrides: Partial<StreamReadLimits> = {},
): Promise<PendingMessages> {
  const limits = { ...STREAM_READ_LIMITS, ...overrides };
  const byMatch = new Map<string, StoredMessage[]>();
  const { matchIds } = query;
  if (matchIds !== null && matchIds.size === 0) return { byMatch, read: 'complete', cutAt: null };
  const bound = query.before ? BigInt(query.before) : null;
  let read: StreamRead = 'complete';
  let cutAt: string | null = null;
  try {
    const watermark = await readWatermark(app.redis, app.keys, 'msg');
    // Every message not yet durable is at or above the watermark: none below this page's cursor.
    if (bound !== null && watermark !== null && bound <= watermark) return { byMatch, read, cutAt };
    const start = watermark === null || watermark <= 0n ? '-' : String(idTime(watermark).getTime());
    // A message below the cursor was appended at most the mint margin after the cursor's time.
    let end = bound === null ? '+' : String(idTime(bound).getTime() + limits.mintMarginMs);
    const stream = app.keys.stream('msg');
    let scanned = 0;
    for (;;) {
      const entries = (await app.redis.xrevrange(stream, end, start, 'COUNT', limits.pageSize)) as [string, string[]][];
      for (const [, flat] of entries) {
        // The conversation first: the other conversations' entries are never built into records.
        if (matchIds !== null && !matchIds.has(fieldOf(flat, 'm') ?? '')) continue;
        const fields: Record<string, string> = {};
        for (let i = 0; i + 1 < flat.length; i += 2) fields[flat[i]!] = flat[i + 1]!;
        let message: StoredMessage;
        try {
          message = parseMessageEntry(fields);
        } catch {
          // A malformed entry is the writer's to dead-letter; its fields are never logged here.
          continue;
        }
        const n = BigInt(message.id);
        if ((watermark !== null && n < watermark) || (bound !== null && n >= bound)) continue;
        if (matchIds === null) message.body = null;
        const list = byMatch.get(message.matchId);
        if (list) list.push(message);
        else byMatch.set(message.matchId, [message]);
      }
      scanned += entries.length;
      if (entries.length < limits.pageSize) break;
      const last = entries.at(-1)![0];
      if (scanned >= limits.scanMax) {
        const cut = idFloor(streamMs(last) + limits.clockSlackMs + 1);
        // Stopping here leaves the next page a cursor below this one's.
        if (bound === null || cut < bound) {
          read = 'backlog';
          cutAt = cut.toString();
          break;
        }
        if (scanned >= limits.hardMax) {
          read = 'partial';
          break;
        }
      }
      // The next page ends just before the oldest entry of this one.
      end = `(${last}`;
    }
  } catch (error) {
    log.warn({ err: error }, 'admin chats: the message stream was not read');
    return { byMatch: new Map(), read: 'partial', cutAt: null };
  }
  for (const list of byMatch.values()) list.sort(byId);
  return { byMatch, read, cutAt };
}

/** A message of the page, stored or pending, with the id of the unsend that took it back. */
export interface AdminMessageRow {
  id: string;
  senderId: string;
  refId: string | null;
  kind: number;
  flags: number;
  body: string | null;
  unsendId: string | null;
  pending: boolean;
}

/**
 * One page from the stored rows (`limit + 1` of them below `before`,
 * ascending) and the pending messages of the conversation: the union by id
 * (a stored row wins: it carries later flag and body changes), the newest
 * `limit` of it below `before` and at or above `cutAt`, ascending. Every
 * stored row among the newest `limit` of the union is among the newest
 * `limit + 1` stored rows, so nothing is skipped. `next` is the next page's
 * bound: its oldest row when the union held more, `cutAt` when the stream
 * read stopped there, else null.
 */
export function mergeMessagePage(
  stored: readonly AdminChatStoredRow[],
  pending: readonly StoredMessage[],
  page: { before: string | null; limit: number; cutAt: string | null },
): { rows: AdminMessageRow[]; next: string | null } {
  const bound = page.before === null ? null : BigInt(page.before);
  const floor = page.cutAt === null ? null : BigInt(page.cutAt);
  const union = new Map<string, AdminMessageRow>();
  for (const m of pending) {
    const n = BigInt(m.id);
    if ((bound !== null && n >= bound) || (floor !== null && n < floor)) continue;
    union.set(m.id, { id: m.id, senderId: m.senderId, refId: m.refId, kind: m.kind, flags: m.flags, body: m.body, unsendId: null, pending: true });
  }
  for (const row of stored) {
    if (floor !== null && BigInt(row.id) < floor) continue;
    union.set(row.id, { ...row, pending: false });
  }
  const newestFirst = [...union.values()].sort((a, b) => byId(b, a));
  const rows = newestFirst.slice(0, page.limit).reverse();
  // An unsend still in the stream, or one on this page, names its target too.
  const unsends = new Map<string, string>();
  const note = (m: { id: string; kind: number; refId: string | null; senderId: string }) => {
    if (m.kind !== KIND.unsend || m.refId === null) return;
    const key = `${m.refId}:${m.senderId}`;
    const known = unsends.get(key);
    if (known === undefined || BigInt(m.id) < BigInt(known)) unsends.set(key, m.id);
  };
  for (const m of pending) note(m);
  for (const m of rows) note(m);
  for (const m of rows) {
    if (m.unsendId === null && m.kind !== KIND.unsend) m.unsendId = unsends.get(`${m.id}:${m.senderId}`) ?? null;
  }
  const next = newestFirst.length > page.limit ? rows[0]!.id : page.cutAt;
  return { rows, next };
}

/** Whether a message at `atMs` from `senderId` falls inside one of their shadowban records. */
export function sentShadowed(shadows: readonly AdminChatShadowRow[], senderId: string, atMs: number): boolean {
  return shadows.some((s) => s.userId === senderId && s.startsAtMs <= atMs && (s.endsAtMs === null || atMs < s.endsAtMs));
}

/** A message as the admin reads it: the sender as a side, media never linked, a call line as its summary. */
export function adminMessageOf(row: AdminMessageRow, subjectId: string, scope: UserReadScope, shadows: readonly AdminChatShadowRow[]): AdminChatMessage {
  const atMs = idTime(row.id).getTime();
  let body: string | null = null;
  let call: AdminChatMessage['call'];
  if (row.kind === KIND.call) {
    const line = decodeCallLineBody(row.body);
    if (line) call = { kind: line.kind, outcome: line.outcome, durationSeconds: line.durationSeconds };
  } else if (row.kind !== KIND.image && row.kind !== KIND.voice && (row.flags & FLAG.bodyRemoved) === 0) {
    body = row.body;
  }
  return {
    id: row.id,
    from: row.senderId === subjectId ? 'subject' : 'other',
    kind: messageKind.name(row.kind),
    flags: messageFlagNames(row.flags),
    body,
    refId: row.refId,
    at: wireTime(atMs),
    unsentAt: row.unsendId === null ? null : wireTime(idTime(row.unsendId)),
    ...(call ? { call } : {}),
    ...(scope.shadow ? { shadowed: sentShadowed(shadows, row.senderId, atMs) } : {}),
    pending: row.pending,
  };
}

const COUNTED_CAP = 100;
const ENDED_BY = { 1: 'lo', 2: 'hi', 3: 'system' } as const;
const counted = (m: { kind: number }) => m.kind !== KIND.reaction && m.kind !== KIND.unsend;

/**
 * A conversation as the list and the page show it. A pending message adds
 * to the count unless it is stored already (the row's `storedSince`: every
 * stored id at or above the oldest pending one); the last activity is the
 * newest of either.
 */
export function chatSummaryOf(
  app: FastifyInstance,
  row: AdminChatRow,
  pending: readonly StoredMessage[],
  scope: UserReadScope,
  options: { unmatchedDays: number; nowMs: number },
): AdminChatSummary {
  const newestStored = row.lastId === null ? null : BigInt(row.lastId);
  const storedAlready = new Set(row.storedSince);
  const unstored = pending.filter((m) => counted(m) && !storedAlready.has(m.id)).length;
  const newestPending = pending.length > 0 ? BigInt(pending.at(-1)!.id) : null;
  const last = newestStored === null ? newestPending : newestPending === null || newestStored > newestPending ? newestStored : newestPending;
  const total = row.count + unstored;
  const ended = row.endedBy === null ? null : ENDED_BY[row.endedBy as 1 | 2 | 3];
  const state = matchState.name(row.state);
  const days = options.unmatchedDays;
  // Nothing kept and the retention past: the rule that would have deleted any (whether there were is not known).
  const emptiedByRetention =
    (state === 'unmatched' || state === 'blocked') &&
    row.endedAtMs !== null &&
    options.nowMs - row.endedAtMs >= days * DAY_MS &&
    !row.held &&
    row.count === 0 &&
    row.lastId === null &&
    pending.length === 0;
  return {
    id: row.id,
    other: userRefOf(app, row.other),
    state,
    source: matchSource.name(row.source),
    startedAt: wireTime(idTime(row.id)),
    endedAt: row.endedAtMs === null ? null : wireTime(row.endedAtMs),
    endedBy: ended === null ? null : ended === 'system' ? 'system' : (ended === 'lo') === (row.side === 1) ? 'subject' : 'other',
    lastActivityAt: last === null ? null : wireTime(idTime(last)),
    messages: { count: Math.min(total, COUNTED_CAP), more: total > COUNTED_CAP },
    held: scope.holds && row.held,
    ...(scope.shadow ? { visibility: { subjectSeesOther: row.subjectSeesOther, otherSeesSubject: row.otherSeesSubject } } : {}),
    retentionDays: emptiedByRetention ? days : null,
  };
}
