import { insertLikes, mutualLikesAmong } from '@app/db';
import { idTime, realtimeEnvelope, userChannel } from '@app/shared';
import { appendMatch, countPendingLikes, jobId, parseCardSource, parseLikeEntry, peerSummaryOf, StreamEntryError, type LikeEntry } from '@app/shared/server';
import { deckSettingsOf } from '../deck/settings.js';
import type { JobContext } from '../queues/types.js';
import { queueJob } from '../social/jobs.js';
import type { BatchResult } from './batch.js';
import type { StreamDelivery } from './consumer.js';

/**
 * The writer of `wb:like` (batch mode): one statement per batch, the
 * multi-row INSERT (`ON CONFLICT DO NOTHING`, so a replayed batch and a like
 * the wallet transaction wrote are no-ops) that also says, for every like
 * written now (or paid from the wallet), whether its target may hear of it.
 * Then:
 *
 * - a row-count check: a batch of new entries that inserted fewer rows than
 *   it carried (wallet-paid likes aside) points at colliding ids, and is
 *   logged as an error;
 * - for the likes whose actor's buckets were incomplete when they were made
 *   (`x`: a bucket at its cap, or the buckets lost), one look-up of the
 *   mutual likes among them, now that the batch is durable: a like that was
 *   still in the stream when the API looked is found here, and its match is
 *   appended to `wb:match` (the match writer makes it, once);
 * - the target of every like the statement cleared is told: the `like`
 *   event (the like id as event id; `from` only for a super like) and one
 *   push per person, collapsed over half a minute by its job id. Nobody is
 *   told about a like that made a match (the match is announced instead),
 *   about a like within a blocked pair, from a hidden or shadowbanned
 *   account or across the test-account line, between people who matched
 *   before, or about a like sent again. Telling is best effort: the likes
 *   are durable, and a failure is logged, not retried.
 */

/** A like push waits this long, so the likes of a burst become one push (the job id is per person). */
export const LIKE_PUSH_DELAY_MS = 30_000;

export interface LikeBatchStats {
  batches: number;
  rows: number;
  inserted: number;
  checked: number;
  matched: number;
  /** Likes whose target was told. */
  told?: number;
}

export function likeBatchHandler(context: JobContext, stats?: LikeBatchStats) {
  const { services, log } = context;
  return async (entries: readonly StreamDelivery[]): Promise<BatchResult> => {
    const poison: string[] = [];
    const likes: { entry: StreamDelivery; like: LikeEntry }[] = [];
    for (const entry of entries) {
      try {
        const like = parseLikeEntry(entry.fields);
        if (like.commentDropped) log.warn({ id: entry.id, likeId: like.id }, 'like comment cannot be stored; the like is written without it');
        likes.push({ entry, like });
      } catch (error) {
        if (error instanceof StreamEntryError) poison.push(entry.id);
        else throw error;
      }
    }
    if (likes.length === 0) return { poison };
    const settings = await deckSettingsOf(services, context.redis, log).get();
    // The same like twice in one batch (a replay that met its original) is one row.
    const unique = [...new Map(likes.map(({ like }) => [like.id, like])).values()];
    const written = await insertLikes(
      services.pg,
      unique.map((like) => ({
        id: like.id,
        targetId: like.targetId,
        actorId: like.actorId,
        kind: like.kind,
        itemKind: like.itemKind,
        itemRef: like.itemRef,
        comment: like.comment,
        prepaid: like.prepaid,
      })),
      settings.likesWindowDays,
    );
    const inserted = written.filter((w) => w.inserted).length;
    const expected = unique.filter((like) => !like.prepaid).length;
    const fresh = likes.every(({ entry }) => entry.source === 'new');
    if (fresh && inserted < expected) {
      log.error({ inserted, expected, batch: likes.length }, 'like batch inserted fewer rows than it carried: colliding ids?');
    }

    const flagged = likes.filter(({ like }) => like.check).map(({ like }) => like);
    const mutualPairs = new Set<string>();
    if (flagged.length > 0) {
      const mutual = await mutualLikesAmong(
        services.pg,
        flagged.map((l) => ({ actorId: l.actorId, targetId: l.targetId })),
        settings.likesWindowDays,
      );
      for (const pair of mutual) {
        const like = flagged.find((l) => l.actorId === pair.actorId && l.targetId === pair.targetId);
        if (!like) continue;
        mutualPairs.add(`${like.actorId}:${like.targetId}`);
        // A match the API may also have found: its INSERT and this entry's agree on the pair, and only one id wins.
        await appendMatch(context.redis, services.keys, {
          matchId: services.ids.nextId(),
          actorId: like.actorId,
          targetId: like.targetId,
          kind: like.kind,
          noteIds: [services.ids.nextId(), services.ids.nextId()],
          likeId: like.id,
          itemKind: like.itemKind,
          itemRef: like.itemRef,
          comment: like.comment,
        });
      }
    }

    const byId = new Map(likes.map(({ like }) => [like.id, like]));
    const tell: { like: LikeEntry; actorCard: unknown }[] = [];
    const pairsTold = new Set<string>();
    for (const row of written) {
      const like = byId.get(row.id);
      if (!like || !row.tell || like.matched) continue;
      const pair = `${like.actorId}:${like.targetId}`;
      // A like that turned out mutual is announced as a match; the same pair twice in one batch is told once.
      if (mutualPairs.has(pair) || pairsTold.has(pair)) continue;
      pairsTold.add(pair);
      tell.push({ like, actorCard: row.actorCard });
    }
    const told = await tellTargets(context, tell);

    if (stats) {
      stats.batches += 1;
      stats.rows += likes.length;
      stats.inserted += inserted;
      stats.checked += flagged.length;
      stats.matched += mutualPairs.size;
      stats.told = (stats.told ?? 0) + told;
    }
    return { poison };
  };
}

/** The `like` events and pushes of a batch; returns how many likes were told. */
async function tellTargets(context: JobContext, likes: readonly { like: LikeEntry; actorCard: unknown }[]): Promise<number> {
  const { services, log } = context;
  if (likes.length === 0) return 0;
  const targets = [...new Set(likes.map(({ like }) => like.targetId))];
  // How many wait for each target, counted once per target (read after the batch: these likes are in the buckets).
  const totals = new Map<string, number>();
  await Promise.all(
    targets.map(async (targetId) => {
      try {
        totals.set(targetId, (await countPendingLikes(context.redis, services.keys, targetId)).total);
      } catch (error) {
        log.warn({ err: error }, 'like: pending likes not counted');
      }
    }),
  );
  const render = { publicIds: services.publicIds, media: services.media };
  let told = 0;
  await Promise.all(
    likes.map(async ({ like, actorCard }) => {
      const total = totals.get(like.targetId);
      if (services.realtime && total !== undefined) {
        const card = like.kind === 2 ? parseCardSource(actorCard) : null;
        const from = card ? peerSummaryOf(render, like.actorId, card) : undefined;
        const envelope = realtimeEnvelope('like', like.id, idTime(like.id), { total, kind: like.kind === 2 ? 'superlike' : 'like', ...(from ? { from } : {}) });
        try {
          await services.realtime.publish(userChannel(services.publicIds.user.encode(like.targetId)), envelope);
        } catch (error) {
          log.warn({ err: error }, 'like: event not published');
        }
      }
      told += 1;
    }),
  );
  await Promise.all(
    targets.map((targetId) =>
      queueJob(context.redis, context.config.queuePrefix, {
        queue: 'push',
        name: 'send',
        id: jobId('send', 'like', targetId),
        data: { type: 'like', userId: targetId },
        delayMs: LIKE_PUSH_DELAY_MS,
        attempts: 3,
        backoffMs: 5_000,
      }).catch((error: unknown) => log.warn({ err: error }, 'like: push not queued')),
    ),
  );
  return told;
}
