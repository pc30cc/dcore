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
 * The stream read sends only `GET` (the flush watermark), `XREVRANGE`
 * (`wb:msg` above it) and `XRANGE` of single entries: no consumer group
 * command, no acknowledgement, no script, no write. Nothing here touches
 * the conversation's list state, read or delivered pointers, unread counts,
 * caches or realtime channels. Message text never reaches a log line: a
 * malformed entry is skipped without logging it, and a failed read logs the
 * error only.
 *
 * What bounds a read: every entry not yet durable has an id at or above the
 * watermark; a page with a cursor needs only the entries that can hold its
 * messages (up to the cursor's time plus the writer's margin), the unsends
 * of the conversation wherever they are (their targets may be on any page),
 * and one read takes at most `scanMax` entries (`hardMax` to get below a
 * cursor). When it stops early, the page stops where it did (`cutAt`).
 *
 * The pages of one conversation go on from each other's reads: the cursor
 * carries where the last read stopped, the newest entry the reads saw, and
 * the entries of the conversation they read but did not show yet (held: the
 * messages below the next cursor, and the unsends of those). The next page
 * reads the held entries one by one, the entries newer than the newest one
 * seen, and below the stop: never again the window the last read covered.
 * A cursor without that place (too many held entries to carry, a first
 * read, a read that gave up) reads the window again from the cursor's time.
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

/** Where the reads of a conversation's pages stand in the stream (carried by the page cursor). */
export interface StreamPlace {
  /** The entry the last read stopped at: the next one reads below it. Null: the reads reached the watermark. */
  stop: string | null;
  /** The newest entry the reads saw: only entries above it are new to the next page. */
  top: string;
  /** Entries of the conversation read and not shown yet (stream ids). */
  held: readonly string[];
}

export interface PendingMessages {
  /** Per conversation, oldest first: the messages not yet durable (at or above the watermark), below the cursor. */
  byMatch: Map<string, StoredMessage[]>;
  /** With conversations named: their unsends not yet durable, wherever they are (above the cursor too), oldest first. */
  unsends: StoredMessage[];
  /** With conversations named: the stream entry of each message kept (in `byMatch` or `unsends`), by message id. */
  entryOf: Map<string, string>;
  read: StreamRead;
  /** With `backlog`: every message not yet durable at or above this id was read; below it, not all. */
  cutAt: string | null;
  /** Where this read leaves the stream for the next page (without its held entries); null: the next page reads the window again. */
  place: Omit<StreamPlace, 'held'> | null;
}

export interface PendingQuery {
  /** Only these conversations' messages; null: every conversation's, without their bodies. */
  matchIds: ReadonlySet<string> | null;
  /** Only messages below this id (a page's cursor); null: no bound. */
  before?: string | null;
  /** With a cursor: where the previous page's read stood. */
  resume?: StreamPlace | null;
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

type Entry = [string, string[]];

/**
 * The messages in `wb:msg` that PostgreSQL may not have yet. Every entry
 * not yet written has a stream time of at least the watermark's time plus
 * the writer's margin, so a scan starts at the watermark's time; entries
 * below the watermark (durable) are left to the database read. Without a
 * watermark (no writer ran since Valkey was emptied) the whole stream is
 * read, up to the limits.
 *
 * Stopping early at the oldest entry read (time T), every entry not read
 * has a stream time of at most T, and so (its id minted before its XADD,
 * on clocks within `clockSlackMs`) an id below `cutAt`. An unsend has an id
 * above its target's, so the unsend of any message at or above `cutAt` was
 * read too.
 */
export async function pendingMessagesOf(
  app: { redis: Redis; keys: KeyBuilder },
  log: FastifyBaseLogger,
  query: PendingQuery,
  overrides: Partial<StreamReadLimits> = {},
): Promise<PendingMessages> {
  const limits = { ...STREAM_READ_LIMITS, ...overrides };
  const byMatch = new Map<string, StoredMessage[]>();
  const unsends: StoredMessage[] = [];
  const entryOf = new Map<string, string>();
  const { matchIds } = query;
  const named = matchIds !== null;
  if (named && matchIds.size === 0) return { byMatch, unsends, entryOf, read: 'complete', cutAt: null, place: null };
  const bound = query.before ? BigInt(query.before) : null;
  const resume = bound === null ? null : (query.resume ?? null);
  let read: StreamRead = 'complete';
  let cutAt: string | null = null;
  let stop: string | null = null;
  let top: string | null = resume?.top ?? null;
  const seen = new Set<string>();
  try {
    const watermark = await readWatermark(app.redis, app.keys, 'msg');
    const floor = watermark === null || watermark <= 0n ? '-' : String(idTime(watermark).getTime());
    const stream = app.keys.stream('msg');

    const keep = ([entryId, flat]: Entry) => {
      if (seen.has(entryId)) return;
      seen.add(entryId);
      if (top === null || compareEntries(entryId, top) > 0) top = entryId;
      // The conversation first: the other conversations' entries are never built into records.
      if (named && !matchIds.has(fieldOf(flat, 'm') ?? '')) return;
      const fields: Record<string, string> = {};
      for (let i = 0; i + 1 < flat.length; i += 2) fields[flat[i]!] = flat[i + 1]!;
      let message: StoredMessage;
      try {
        message = parseMessageEntry(fields);
      } catch {
        // A malformed entry is the writer's to dead-letter; its fields are never logged here.
        return;
      }
      const n = BigInt(message.id);
      if (watermark !== null && n < watermark) return;
      if (!named) message.body = null;
      else if (message.kind === KIND.unsend) {
        unsends.push(message);
        entryOf.set(message.id, entryId);
      }
      if (bound !== null && n >= bound) return;
      if (named) entryOf.set(message.id, entryId);
      const list = byMatch.get(message.matchId);
      if (list) list.push(message);
      else byMatch.set(message.matchId, [message]);
    };

    /**
     * Entries from `end` down to `start`, a page at a time, each kept; stops
     * when `enough` says so after a page. Returns the entries it took and
     * whether it reached `start` (read every entry in the range).
     */
    const scan = async (end: string, start: string, enough: (taken: number, last: string) => boolean): Promise<{ taken: number; whole: boolean; last: string | null }> => {
      let taken = 0;
      let last: string | null = null;
      for (;;) {
        const entries = (await app.redis.xrevrange(stream, end, start, 'COUNT', limits.pageSize)) as Entry[];
        for (const entry of entries) keep(entry);
        taken += entries.length;
        if (entries.length < limits.pageSize) return { taken, whole: true, last: entries.at(-1)?.[0] ?? last };
        last = entries.at(-1)![0];
        if (enough(taken, last)) return { taken, whole: false, last };
        // The next page ends just before the oldest entry of this one.
        end = `(${last}`;
      }
    };
    const cutOf = (last: string) => idFloor(streamMs(last) + limits.clockSlackMs + 1);
    /** The entries above a scanned range (unsends whose targets may be below it): `scanMax` at most; false when there were more. */
    const above = async (start: string): Promise<boolean> => (await scan('+', start, (taken) => taken >= limits.scanMax)).whole;

    if (resume !== null) {
      // The held entries, one by one (gone: stored and trimmed since, so in the database's answer).
      if (resume.held.length > 0) {
        const batch = app.redis.pipeline();
        for (const id of resume.held) batch.xrange(stream, id, id);
        for (const [error, entries] of (await batch.exec()) ?? []) {
          if (error) throw error;
          for (const entry of (entries as Entry[] | null) ?? []) keep(entry);
        }
      }
      // What came after the last read, then below where it stopped (nothing there once durable below this cursor).
      if (!(await above(`(${resume.top}`))) read = 'partial';
      const below = resume.stop !== null && !(watermark !== null && bound! <= watermark);
      if (below && read === 'complete') {
        const fresh = await scan(`(${resume.stop}`, floor, (taken) => taken >= limits.scanMax);
        if (!fresh.whole) {
          const cut = cutOf(fresh.last!);
          read = 'backlog';
          cutAt = (cut < bound! ? cut : bound!).toString();
          stop = fresh.last;
        }
      }
    } else if (bound !== null && watermark !== null && bound <= watermark) {
      // Every message not yet durable is at or above the watermark: none below this page's cursor, but unsends of its messages may be.
      if (!(await above(floor))) read = 'partial';
    } else {
      // A message below the cursor was appended at most the mint margin after the cursor's time.
      const endMs = bound === null ? null : idTime(bound).getTime() + limits.mintMarginMs;
      const main = await scan(endMs === null ? '+' : String(endMs), floor, (taken, last) => {
        if (taken < limits.scanMax) return false;
        // Stopping here leaves the next page a cursor below this one's.
        if (bound === null || cutOf(last) < bound) return true;
        return taken >= limits.hardMax;
      });
      if (!main.whole) {
        const cut = cutOf(main.last!);
        if (bound === null || cut < bound) {
          read = 'backlog';
          cutAt = cut.toString();
          stop = main.last;
        } else read = 'partial';
      }
      if (endMs !== null && named && read !== 'partial' && !(await above(String(endMs + 1)))) read = 'partial';
    }
  } catch (error) {
    log.warn({ err: error }, 'admin chats: the message stream was not read');
    return { byMatch: new Map(), unsends: [], entryOf: new Map(), read: 'partial', cutAt: null, place: null };
  }
  for (const list of byMatch.values()) list.sort(byId);
  unsends.sort(byId);
  const place = named && read !== 'partial' && top !== null ? { stop, top } : null;
  return { byMatch, unsends, entryOf, read, cutAt, place };
}

/** Stream ids in stream order (`ms-seq`). */
function compareEntries(a: string, b: string): number {
  const [am, as] = a.split('-').map(BigInt) as [bigint, bigint];
  const [bm, bs] = b.split('-').map(BigInt) as [bigint, bigint];
  return am !== bm ? (am < bm ? -1 : 1) : as === bs ? 0 : as < bs ? -1 : 1;
}

/**
 * The entries of the conversation the next page needs and this one read
 * without showing: its messages below `next`, and the unsends of messages
 * below `next`. Stream ids, oldest first.
 */
export function heldEntries(pending: PendingMessages, conversation: readonly StoredMessage[], next: string): string[] {
  const below = BigInt(next);
  const held = new Set<string>();
  for (const m of conversation) if (BigInt(m.id) < below) held.add(pending.entryOf.get(m.id)!);
  for (const u of pending.unsends) if (u.refId !== null && BigInt(u.refId) < below) held.add(pending.entryOf.get(u.id)!);
  return [...held].filter(Boolean).sort(compareEntries);
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
 * read stopped there, else null. `unsends`: the conversation's unsends not
 * yet durable wherever they are (default: those among `pending`).
 */
export function mergeMessagePage(
  stored: readonly AdminChatStoredRow[],
  pending: readonly StoredMessage[],
  page: { before: string | null; limit: number; cutAt: string | null; unsends?: readonly StoredMessage[] },
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
  // An unsend still in the stream (wherever it is: above this page's cursor too), or one on this page, names its target too.
  const unsends = new Map<string, string>();
  const note = (m: { id: string; kind: number; refId: string | null; senderId: string }) => {
    if (m.kind !== KIND.unsend || m.refId === null) return;
    const key = `${m.refId}:${m.senderId}`;
    const known = unsends.get(key);
    if (known === undefined || BigInt(m.id) < BigInt(known)) unsends.set(key, m.id);
  };
  for (const m of page.unsends ?? pending) note(m);
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
 * newest of either. `streamComplete`: the read reached every message not
 * stored yet (else the count may leave some out, and says so).
 */
export function chatSummaryOf(
  app: FastifyInstance,
  row: AdminChatRow,
  pending: readonly StoredMessage[],
  scope: UserReadScope,
  options: { unmatchedDays: number; nowMs: number; streamComplete: boolean },
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
    countComplete: options.streamComplete,
    held: scope.holds && row.held,
    ...(scope.shadow ? { visibility: { subjectSeesOther: row.subjectSeesOther, otherSeesSubject: row.otherSeesSubject } } : {}),
    retentionDays: emptiedByRetention ? days : null,
  };
}
