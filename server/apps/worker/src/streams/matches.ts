import { setTimeout as sleep } from 'node:timers/promises';
import { createMatch, matchOfPair, type MatchRow } from '@app/db';
import { idTime, realtimeEnvelope, userChannel } from '@app/shared';
import {
  announceMatch,
  clearPairLikes,
  conversationOf,
  jobId,
  matchSourceOf,
  parseCardSource,
  parseMatchEntry,
  peerSummaryOf,
  type MatchEntry,
} from '@app/shared/server';
import type { JobContext } from '../queues/types.js';
import { queueJob } from '../social/jobs.js';
import { streamIdMs } from './batch.js';
import type { StreamDelivery } from './consumer.js';

/**
 * The consumer of `wb:match`: every match is in this stream before anyone
 * else writes it (the like script appends it with the pre-minted ids), so
 * a match survives an API that died, timed out or met a database outage
 * after the script answered.
 *
 * For each entry, once it is `MATCH_GRACE_MS` old (the API's own INSERT
 * normally lands first and this one is a no-op):
 *
 * - the same INSERT (`ON CONFLICT (user_lo, user_hi) DO NOTHING`); the
 *   match is this entry's when the row carries the entry's id, whoever
 *   wrote it. A pair that already had another match, or that may not match
 *   (a block, a hidden account), ends here: nothing is announced;
 * - the Valkey state of both lists (`mt:`, `cl:`, `cv:`), both people out of
 *   each other's like buckets;
 * - the `conversation` event (reason `matched`) to each person, with the
 *   match id as the event id: a replay, or the API's publish of the same
 *   match, is one event for Centrifugo and the apps;
 * - the `match` push to each (job ids per match and person) and the like
 *   notes job, which waits for `wb:like` to be durable.
 *
 * Every step is idempotent, so an entry delivered twice changes nothing.
 */

export const MATCH_GRACE_MS = 1_500;
/** The like notes wait at least for the watermark's margin. */
export const LIKE_NOTES_DELAY_MS = 6_000;

export interface MatchStats {
  entries: number;
  announced: number;
  skipped: number;
}

export function matchEntryHandler(context: JobContext, options: { graceMs?: number; stats?: MatchStats } = {}) {
  const { services, log, config } = context;
  const graceMs = options.graceMs ?? MATCH_GRACE_MS;
  return async (delivery: StreamDelivery): Promise<void> => {
    const entry: MatchEntry = parseMatchEntry(delivery.fields);
    if (options.stats) options.stats.entries += 1;
    const age = Date.now() - streamIdMs(delivery.id);
    if (delivery.source === 'new' && age < graceMs) await sleep(graceMs - age);

    const source = matchSourceOf(entry.kind, entry.itemKind);
    let row: MatchRow | null = await createMatch(services.pg, { matchId: entry.matchId, actorId: entry.actorId, targetId: entry.targetId, source });
    // No row: the pair may not match, or another writer's INSERT of it was not committed when this one began.
    row ??= await matchOfPair(services.pg, entry.actorId, entry.targetId);
    if (row?.id !== entry.matchId || row.state !== 1) {
      if (options.stats) options.stats.skipped += 1;
      log.info({ matchId: entry.matchId, existing: row?.id === entry.matchId ? 'ended' : row ? 'other' : 'refused' }, 'match entry: nothing to announce');
      return;
    }

    const state = { id: row.id, lo: row.lo, hi: row.hi, state: row.state, flags: row.flags, source: row.source, createdMs: idTime(row.id).getTime() };
    await announceMatch(context.redis, services.keys, state);
    await clearPairLikes(context.redis, services.keys, row.lo, row.hi);

    const cards = { [row.lo]: parseCardSource(row.loCard), [row.hi]: parseCardSource(row.hiCard) };
    const render = { publicIds: services.publicIds, media: services.media };
    for (const [viewer, peerId] of [
      [row.lo, row.hi],
      [row.hi, row.lo],
    ] as const) {
      const card = cards[peerId];
      const peer = card
        ? peerSummaryOf(render, peerId, card)
        : { id: services.publicIds.user.encode(peerId), name: '', photo: null, verified: false };
      if (services.realtime) {
        const conversation = conversationOf({ match: row, viewerId: viewer, peer });
        await services.realtime.publish(
          userChannel(services.publicIds.user.encode(viewer)),
          realtimeEnvelope('conversation', row.id, idTime(row.id), { conversation, reason: 'matched' }),
        );
      }
      await queueJob(context.redis, config.queuePrefix, {
        queue: 'push',
        name: 'send',
        id: jobId('send', 'match', row.id, viewer),
        data: { type: 'match', userId: viewer, conversationId: row.id, ...(card?.name ? { peerName: card.name } : {}) },
        attempts: 3,
        backoffMs: 5_000,
      });
    }
    await queueJob(context.redis, config.queuePrefix, {
      queue: 'chat',
      name: 'like-notes',
      id: jobId('like-notes', row.id),
      data: {
        matchId: row.id,
        lo: row.lo,
        hi: row.hi,
        actorId: entry.actorId,
        targetId: entry.targetId,
        noteIds: entry.noteIds,
        likeId: entry.likeId,
        itemRef: entry.itemRef,
        comment: entry.comment,
        queuedAtMs: Date.now(),
      },
      delayMs: LIKE_NOTES_DELAY_MS,
      attempts: 5,
      backoffMs: 10_000,
    });
    if (options.stats) options.stats.announced += 1;
  };
}
