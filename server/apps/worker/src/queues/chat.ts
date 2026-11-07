import { writeLikeNotes } from '@app/db';
import { idTime, realtimeEnvelope, userChannel, wireTime } from '@app/shared';
import { readWatermark } from '@app/shared/server';
import { DelayedError, type Job } from 'bullmq';
import { z } from 'zod';
import { deckSettingsOf } from '../deck/settings.js';
import type { JobContext, QueueDefinition } from './types.js';

/**
 * Chat jobs (queue `chat`). `like-notes`: the first lines of a new
 * conversation, each like's comment as a like note. The second like's
 * comment comes with the job; the first like is read from `likes`, so the
 * job waits until `wb:like`'s watermark has passed the second like (every
 * like before it is then in PostgreSQL), checking again every two seconds.
 * One statement writes the notes with their pre-minted ids and returns the
 * ones it wrote; those are published to both people (`message`). A replay
 * writes and publishes nothing (a note whose publish failed reaches the
 * apps with the conversation's history).
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
  noteIds: z.tuple([ID, ID]),
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
  const notes = await writeLikeNotes(services.pg, {
    matchId: data.matchId,
    actorId: data.actorId,
    targetId: data.targetId,
    noteIds: data.noteIds,
    itemRef: data.itemRef,
    comment: data.comment,
    windowDays: settings.likesWindowDays,
  });
  if (notes.length > 0 && services.realtime) {
    const channels = [data.lo, data.hi].map((id) => userChannel(services.publicIds.user.encode(id)));
    for (const note of notes.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))) {
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

export const chatQueue: QueueDefinition<unknown, LikeNotesResult> = {
  name: CHAT_QUEUE,
  async process(job, context) {
    switch (job.name) {
      case 'like-notes':
        return likeNotesJob(job, context);
      default:
        throw new Error(`the chat queue has no job named "${job.name}"`);
    }
  },
};
