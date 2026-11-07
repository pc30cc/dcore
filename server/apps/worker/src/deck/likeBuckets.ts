import { pendingLikesChunk, type PendingLike } from '@app/db';
import { idTime } from '@app/shared';
import { likeWeek, likeWeeks } from '@app/shared/server';
import { takeLease } from '../lease.js';
import type { JobContext } from '../queues/types.js';
import { deckSettingsOf } from './settings.js';

/**
 * `lk-rebuild` (queue `maint`, on demand): after Valkey lost the like
 * buckets (`lk:ready` absent), mutual-like detection falls back to a
 * PostgreSQL point lookup and the deck reads likers from PostgreSQL; this
 * job puts the buckets back from the last `likes.window_days` of `likes`
 * (matched pairs left out), then sets `lk:ready`.
 *
 * - The walk is in primary-key order (`target_id, actor_id, id`), 5,000 rows
 *   a statement, so a person's likes come together and the walk never
 *   sorts.
 * - Each like goes to the bucket of the week its id was minted in
 *   (`lkin:<target>:<week>`; super likes also to `:s`), as the like script
 *   puts it there; weeks no longer live are skipped. A bucket stops at
 *   `likes.bucket_cap` and gets its `:full` marker, as the script does.
 * - New likes keep arriving while it runs (the script adds them); adding
 *   the same liker twice changes nothing, so the walk needs no pause.
 * - A lease (`lease:lk-rebuild`, renewed while the walk goes on) keeps a
 *   second run from walking at the same time.
 */

export const REBUILD_CHUNK = 5_000;
const LEASE_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

export type LikeRebuildResult =
  | { outcome: 'ready' | 'leased' }
  | { outcome: 'rebuilt'; likes: number; added: number; full: number; skipped: number; chunks: number };

/** Unix ms of the start (Monday 00:00 UTC) of a like week. */
export function likeWeekStartMs(week: number): number {
  return (week * 7 - 3) * DAY_MS;
}

/** Seconds a bucket of `week` should live from `now`: until the last week it is read in has ended, plus a day. */
export function bucketTtlSeconds(week: number, now: number): number {
  return Math.max(3_600, Math.ceil((likeWeekStartMs(week + 5) + DAY_MS - now) / 1_000));
}

export async function lkRebuildJob(context: JobContext, options: { now?: () => number; chunk?: number } = {}): Promise<LikeRebuildResult> {
  const { services, redis, log } = context;
  const { keys, pg } = services;
  const now = options.now ?? Date.now;
  if ((await redis.exists(keys.likesReady())) === 1) return { outcome: 'ready' };
  const lease = keys.jobLease('lk-rebuild');
  if (!(await takeLease(redis, lease, LEASE_MS, context.config.workerId))) return { outcome: 'leased' };
  const settings = await deckSettingsOf(services, redis, log).get();
  const chunk = options.chunk ?? REBUILD_CHUNK;
  let after: { targetId: string; actorId: string; likeId: string } | null = null;
  let likes = 0;
  let added = 0;
  let full = 0;
  let skipped = 0;
  let chunks = 0;
  for (;;) {
    const rows: PendingLike[] = await pendingLikesChunk(pg, after, chunk, settings.likesWindowDays);
    chunks += 1;
    if (rows.length === 0) break;
    const last = rows[rows.length - 1]!;
    after = { targetId: last.targetId, actorId: last.actorId, likeId: last.likeId };
    const live = new Set(likeWeeks(now()));
    // (target, week) → likers and super likers of this chunk.
    const buckets = new Map<string, { targetId: string; week: number; actors: Set<string>; supers: Set<string> }>();
    for (const row of rows) {
      likes += 1;
      const week = likeWeek(idTime(row.likeId));
      if (row.matched || !live.has(week)) {
        skipped += 1;
        continue;
      }
      const key = `${row.targetId}:${week}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { targetId: row.targetId, week, actors: new Set(), supers: new Set() };
        buckets.set(key, bucket);
      }
      bucket.actors.add(row.actorId);
      if (row.kind === 2) bucket.supers.add(row.actorId);
    }
    const list = [...buckets.values()];
    if (list.length > 0) {
      // How full each bucket is already (the like script may be adding to it now), then the adds.
      const sizes = redis.pipeline();
      for (const b of list) {
        sizes.scard(keys.likesIn(b.targetId, b.week));
        sizes.exists(keys.likesInFull(b.targetId, b.week));
      }
      const replies = (await sizes.exec()) ?? [];
      const writes = redis.pipeline();
      list.forEach((b, i) => {
        const size = Number(replies[i * 2]?.[1] ?? 0);
        const isFull = Number(replies[i * 2 + 1]?.[1] ?? 0) === 1;
        const ttl = bucketTtlSeconds(b.week, now());
        const bucketKey = keys.likesIn(b.targetId, b.week);
        const room = isFull ? 0 : Math.max(0, settings.bucketCap - size);
        const actors = [...b.actors];
        const taken = actors.slice(0, room);
        if (taken.length > 0) {
          writes.sadd(bucketKey, ...taken);
          writes.expire(bucketKey, ttl, 'NX');
          added += taken.length;
        }
        if (actors.length > room) {
          writes.set(keys.likesInFull(b.targetId, b.week), '1', 'EX', ttl);
          full += 1;
        }
        const supers = [...b.supers];
        if (supers.length > 0) {
          const superKey = keys.likesInSuper(b.targetId, b.week);
          writes.sadd(superKey, ...supers);
          writes.expire(superKey, ttl, 'NX');
        }
      });
      const written = (await writes.exec()) ?? [];
      const failed = written.find(([error]) => error !== null)?.[0];
      if (failed) throw failed;
    }
    await redis.pexpire(lease, LEASE_MS);
    if (rows.length < chunk) break;
  }
  await redis.set(keys.likesReady(), String(now()));
  log.info({ likes, added, full, skipped, chunks }, 'lk-rebuild: like buckets rebuilt');
  return { outcome: 'rebuilt', likes, added, full, skipped, chunks };
}
