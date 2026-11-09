import { clearUnsentBody, flushReadPointers, withTransaction, writeLikeNotes } from '@app/db';
import { idTime, realtimeEnvelope, userChannel, wireTime } from '@app/shared';
import {
  chatJobNames,
  chatKeys,
  holdDirectWrites,
  KIND,
  noteMessage,
  readFlushDone,
  readWatermark,
  releaseDirectWrites,
  takeReadFlushChunk,
  unsendClearJobSchema,
} from '@app/shared/server';
import { DelayedError, type Job } from 'bullmq';
import { z } from 'zod';
import { deckSettingsOf } from '../deck/settings.js';
import { takeLease } from '../lease.js';
import type { JobContext, QueueDefinition } from './types.js';

/**
 * Chat jobs (queue `chat`).
 *
 * `read-flush` (every minute, under a lease never released early): the
 * conversations whose read pointers moved (`rp:dirty`, moved a chunk at a
 * time into `rp:flushing`) and their pointers (`rp:<m>`) written with one
 * UPDATE per chunk (`matches_flush_read()`: only forward, only rows that
 * move), then taken out of `rp:flushing`. However many receipts a
 * conversation got in the minute, it costs one row of one statement. A chunk
 * that cannot be written, or whose run died before it was written, stays in
 * `rp:flushing`, and the next run writes it first.
 *
 * `unsend-clear`: the body of a taken-back message is removed once the
 * window in which a report may still copy it is over (flag 8), and the list
 * preview with it when it was the newest. While a legal hold names the
 * conversation or either person, the body stays in PostgreSQL (the preview
 * still goes: the other person never sees it again) and the job looks again
 * a day later, until the hold is released.
 *
 * `like-notes`: the first lines of a new
 * conversation, each like's comment as a like note. The second like's
 * comment comes with the job; the first like is read from `likes`, so the
 * job waits until `wb:like`'s watermark has passed the second like (every
 * like before it is then in PostgreSQL), checking again every two seconds.
 * The notes' ids are minted by each try right before its write and held in
 * `wb:msg:direct` until it is done: the history's sync cursor never passes
 * a note that is not durable yet, and a try that runs minutes after the
 * match (the wait, a retry) never writes ids below a cursor a client
 * already holds. One transaction writes the notes once (an earlier try
 * that committed leaves them, and they are what this one finds); the notes
 * are published to both people (`message`) by the try that wrote them, or
 * again by a retry, whose earlier try may have died before its publish. A
 * replayed job writes and publishes nothing (a note whose publish failed
 * reaches the apps with the conversation's history).
 */

export const CHAT_QUEUE = 'chat';
/** A note job gives up waiting for the watermark after this long and writes what it can find. */
export const NOTES_MAX_WAIT_MS = 10 * 60_000;
const RECHECK_MS = 2_000;

const ID = z.string().regex(/^[1-9][0-9]{0,18}$/);

export const likeNotesJobSchema = z.object({
  matchId: ID,
  lo: ID,
  hi: ID,
  actorId: ID,
  targetId: ID,
  /** Ids minted when the match was made (older producers); unused: each try mints the ids it writes. */
  noteIds: z.tuple([ID, ID]).optional(),
  likeId: ID,
  itemRef: ID.nullable(),
  comment: z.string().min(1).max(300).nullable(),
  queuedAtMs: z.number().int().nonnegative(),
});
export type LikeNotesJob = z.infer<typeof likeNotesJobSchema>;

export type LikeNotesResult = { outcome: 'written'; notes: number; waitedMs: number };

export async function likeNotesJob(job: Job, context: JobContext, now: () => number = Date.now): Promise<LikeNotesResult> {
  const { services, redis, log } = context;
  const data = likeNotesJobSchema.parse(job.data);
  const waited = now() - data.queuedAtMs;
  const watermark = await readWatermark(redis, services.keys, 'like');
  if ((watermark === null || watermark <= BigInt(data.likeId)) && waited < NOTES_MAX_WAIT_MS) {
    if (!context.token) throw new Error('a delayed retry needs the job token');
    await job.moveToDelayed(now() + RECHECK_MS, context.token);
    throw new DelayedError();
  }
  if (waited >= NOTES_MAX_WAIT_MS) log.warn({ matchId: data.matchId }, 'like notes: the like stream is not durable yet; writing what is in PostgreSQL');
  const settings = await deckSettingsOf(services, redis, log).get();
  // Minted now and held until written: above every sync cursor handed out so far, and none passes them before they are durable.
  const noteIds: [string, string] = [services.ids.nextId(), services.ids.nextId()];
  await holdDirectWrites(redis, services.keys, noteIds);
  let write;
  try {
    write = await withTransaction(services.pg, (tx) =>
      writeLikeNotes(tx, {
        matchId: data.matchId,
        actorId: data.actorId,
        targetId: data.targetId,
        noteIds,
        itemRef: data.itemRef,
        comment: data.comment,
        windowDays: settings.likesWindowDays,
      }),
    );
  } finally {
    // Durable, or not written at all (a retry mints new ids).
    await releaseDirectWrites(redis, services.keys, noteIds).catch((error: unknown) => log.warn({ err: error, matchId: data.matchId }, 'like notes: hold not released (it runs out)'));
  }
  // Notes this try found already written: a retry publishes them (its earlier try may have died before that), a replay does not.
  const notes = write.written || job.attemptsMade > 0 ? write.notes : [];
  const ordered = notes.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  for (const note of ordered) {
    // The list shows the note as the conversation's newest line, unread for the person it was written to.
    await noteMessage(redis, services.keys, {
      message: { id: note.id, matchId: data.matchId, senderId: note.senderId, refId: note.refId, kind: KIND.likeNote, flags: 0, body: note.body },
      lo: data.lo,
      hi: data.hi,
      unreadFor: note.senderId === data.lo ? 'hi' : 'lo',
    }).catch((error: unknown) => log.warn({ err: error, matchId: data.matchId }, 'like notes: list state not updated'));
  }
  if (ordered.length > 0 && services.realtime) {
    const channels = [data.lo, data.hi].map((id) => userChannel(services.publicIds.user.encode(id)));
    for (const note of ordered) {
      const envelope = realtimeEnvelope('message', note.id, idTime(note.id), {
        id: note.id,
        conversationId: data.matchId,
        senderId: services.publicIds.user.encode(note.senderId),
        kind: 'like_note',
        body: note.body,
        ...(note.refId ? { refId: note.refId } : {}),
        at: wireTime(idTime(note.id)),
      });
      // A replay writes nothing, so it would publish nothing either: a failed publish is left to the history read.
      await services.realtime.broadcast(channels, envelope).catch((error: unknown) => log.warn({ err: error, matchId: data.matchId }, 'like notes: not published'));
    }
  }
  return { outcome: 'written', notes: notes.length, waitedMs: waited };
}

export const READ_FLUSH_EVERY_MS = 60_000;
/** Conversations per flush statement. */
export const READ_FLUSH_CHUNK = 5_000;

export interface ReadFlushResult {
  leased: boolean;
  conversations: number;
  written: number;
  statements: number;
}

export async function readFlushJob(context: JobContext): Promise<ReadFlushResult> {
  const { services, redis, log } = context;
  const result: ReadFlushResult = { leased: false, conversations: 0, written: 0, statements: 0 };
  if (!(await takeLease(redis, services.keys.jobLease('chat-read-flush'), READ_FLUSH_EVERY_MS - 5_000, context.config.workerId))) return result;
  result.leased = true;
  const c = chatKeys(services.keys);
  for (;;) {
    // Nothing leaves rp:flushing before its pointers are written: a run that dies here loses nothing.
    const { left, ids } = await takeReadFlushChunk(redis, services.keys, READ_FLUSH_CHUNK);
    if (ids.length === 0) break;
    const matchIds = ids.filter((id) => /^[1-9][0-9]{0,18}$/.test(id));
    const pipeline = redis.pipeline();
    for (const id of matchIds) pipeline.hmget(c.readPointers(id), 'lo', 'hi');
    const replies = matchIds.length > 0 ? ((await pipeline.exec()) ?? []) : [];
    const pointers = matchIds
      .map((matchId, i) => {
        const [lo, hi] = ((replies[i]?.[1] ?? []) as (string | null)[]).map((v) => (v && /^[0-9]{1,19}$/.test(v) ? v : '0'));
        return { matchId, lo: lo ?? '0', hi: hi ?? '0' };
      })
      .filter((p) => p.lo !== '0' || p.hi !== '0');
    if (pointers.length > 0) {
      // On a failure the chunk stays in rp:flushing (its pointers are still in rp:<m>): the next run writes it first.
      result.written += await flushReadPointers(services.pg, pointers);
      result.statements += 1;
      result.conversations += pointers.length;
    }
    await readFlushDone(redis, services.keys, ids);
    if (!left && ids.length < READ_FLUSH_CHUNK) break;
  }
  if (result.conversations > 0) log.info(result, 'read flush: done');
  return result;
}

export type UnsendClearResult = { outcome: 'cleared' | 'nothing' };

/** A body kept for a legal hold is looked at again this often. */
export const UNSEND_HOLD_RECHECK_MS = 24 * 3_600_000;

export async function unsendClearJob(job: Job, context: JobContext, now: () => number = Date.now): Promise<UnsendClearResult> {
  const { services, redis } = context;
  const data = unsendClearJobSchema.parse(job.data);
  const outcome = await clearUnsentBody(services.pg, data.matchId, data.targetId, data.senderId);
  // The list's preview of that message goes with it (held or not: it was taken back).
  const last = chatKeys(services.keys).lastMessage(data.matchId);
  if ((await redis.hget(last, 'id')) === data.targetId) await redis.hset(last, 'p', '');
  if (outcome === 'held') {
    if (!context.token) throw new Error('a delayed retry needs the job token');
    await job.moveToDelayed(now() + UNSEND_HOLD_RECHECK_MS, context.token);
    throw new DelayedError();
  }
  return { outcome };
}

export const chatQueue: QueueDefinition<unknown, LikeNotesResult | ReadFlushResult | UnsendClearResult> = {
  name: CHAT_QUEUE,
  schedules: [{ id: chatJobNames.readFlush, name: chatJobNames.readFlush, repeat: { every: READ_FLUSH_EVERY_MS }, opts: { attempts: 1 } }],
  async process(job, context) {
    switch (job.name) {
      case 'like-notes':
        return likeNotesJob(job, context);
      case 'read-flush':
        return readFlushJob(context);
      case 'unsend-clear':
        return unsendClearJob(job, context);
      default:
        throw new Error(`the chat queue has no job named "${job.name}"`);
    }
  },
};
