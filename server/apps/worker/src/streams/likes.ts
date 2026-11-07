import { insertLikes, mutualLikesAmong } from '@app/db';
import { appendMatch, parseLikeEntry, StreamEntryError, type LikeEntry } from '@app/shared/server';
import { deckSettingsOf } from '../deck/settings.js';
import type { JobContext } from '../queues/types.js';
import type { BatchResult } from './batch.js';
import type { StreamDelivery } from './consumer.js';

/**
 * The writer of `wb:like` (batch mode): one multi-row INSERT per batch
 * (`ON CONFLICT DO NOTHING`, so a replayed batch and a like the wallet
 * transaction wrote are no-ops), then:
 *
 * - a row-count check: a batch of new entries that inserted fewer rows than
 *   it carried (wallet-paid likes aside) points at colliding ids, and is
 *   logged as an error;
 * - for the likes whose actor's buckets were incomplete when they were made
 *   (`x`: a bucket at its cap, or the buckets lost), one look-up of the
 *   mutual likes among them, now that the batch is durable: a like that was
 *   still in the stream when the API looked is found here, and its match is
 *   appended to `wb:match` (the match writer makes it, once).
 */

export interface LikeBatchStats {
  batches: number;
  rows: number;
  inserted: number;
  checked: number;
  matched: number;
}

export function likeBatchHandler(context: JobContext, stats?: LikeBatchStats) {
  const { services, log } = context;
  return async (entries: readonly StreamDelivery[]): Promise<BatchResult> => {
    const poison: string[] = [];
    const likes: { entry: StreamDelivery; like: LikeEntry }[] = [];
    for (const entry of entries) {
      try {
        likes.push({ entry, like: parseLikeEntry(entry.fields) });
      } catch (error) {
        if (error instanceof StreamEntryError) poison.push(entry.id);
        else throw error;
      }
    }
    if (likes.length === 0) return { poison };
    const inserted = await insertLikes(
      services.pg,
      likes.map(({ like }) => ({
        id: like.id,
        targetId: like.targetId,
        actorId: like.actorId,
        kind: like.kind,
        itemKind: like.itemKind,
        itemRef: like.itemRef,
        comment: like.comment,
      })),
    );
    const expected = likes.filter(({ like }) => !like.prepaid).length;
    const fresh = likes.every(({ entry }) => entry.source === 'new');
    if (fresh && inserted < expected) {
      log.error({ inserted, expected, batch: likes.length }, 'like batch inserted fewer rows than it carried: colliding ids?');
    }

    const flagged = likes.filter(({ like }) => like.check).map(({ like }) => like);
    let matched = 0;
    if (flagged.length > 0) {
      const settings = await deckSettingsOf(services, context.redis, log).get();
      const mutual = await mutualLikesAmong(
        services.pg,
        flagged.map((l) => ({ actorId: l.actorId, targetId: l.targetId })),
        settings.likesWindowDays,
      );
      for (const pair of mutual) {
        const like = flagged.find((l) => l.actorId === pair.actorId && l.targetId === pair.targetId);
        if (!like) continue;
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
        matched += 1;
      }
    }
    if (stats) {
      stats.batches += 1;
      stats.rows += likes.length;
      stats.inserted += inserted;
      stats.checked += flagged.length;
      stats.matched += matched;
    }
    return { poison };
  };
}
