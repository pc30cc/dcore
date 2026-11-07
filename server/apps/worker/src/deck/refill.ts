import { deckCandidates, deckViewer, profileCards, type DeckCandidate, type DeckSearch, type DeckViewer } from '@app/db';
import { idTime, preferenceFlags } from '@app/shared';
import {
  DeckFlag,
  SeenFilter,
  jobId,
  likeWeeks,
  loadCards,
  readDeck,
  releaseDeckLock,
  takeDeckLock,
  utcDay,
  writeDeck,
  type DeckEntry,
} from '@app/shared/server';
import type { JobContext } from '../queues/types.js';
import { addJob } from './enqueue.js';
import { compileFilters, passesFilters } from './filters.js';
import { diversify, scoreOf, type ScoreInput } from './score.js';
import { decodePoolCursor, deckArea, deckSeed, encodePoolCursor, searchFingerprint, type PoolCursor } from './search.js';
import { deckSettingsOf, planHas } from './settings.js';

/**
 * The deck refill (queue `deck`, job `refill`), run when a person's queue
 * runs low (`GET /v1/deck`) or is gone (a change of preferences):
 *
 * 1. Valkey: the refill guard (`deck:lock:<uid>`), the queue as it is, the
 *    like buckets (likers and super likers) and `lk:ready`, the seen filter.
 * 2. One read of the viewer (`deck_viewer()`): cell, preferences, plans;
 *    the likers too while the buckets are being rebuilt (lk:ready absent;
 *    the rebuild is queued).
 * 3. The search cells (h3-js), then one statement: a page of the pool
 *    (`deck_candidates()`, the shortest activity window first, widened only
 *    while the page comes back short) together with the injected people
 *    under the same rules: the queued entries (re-checked, their versions
 *    refreshed), super likers, a sample of likers, people boosted in the
 *    viewer's r5 cells. The pool's keyset cursor is kept with the queue, so
 *    the next refill continues where this one stopped; at the end of the
 *    pool it starts over (seen people are dropped by the filter).
 * 4. In memory: seen people dropped, advanced filters, the score of docs/10
 *    with the panel's weights (inbound load from the candidates' like
 *    buckets, boosts from `bst:<r5>`), the diversity pass; super likers go
 *    first, then the best until the queue holds `queue_size`.
 * 5. The cards of everyone queued: cached ones from one MGET, the rest built
 *    in one statement and cached.
 * 6. One transaction on kv-cache writes the queue and its metadata.
 *
 * Statements: 1 (viewer) + 1 per pool page (usually 1) + 1 when cards are
 * missing; the configuration snapshot when `cfg:v` moved.
 */

export interface RefillData {
  userId: string;
  /** The session's store code (plans of that store count, with admin grants). */
  store?: number | undefined;
}

export type RefillResult =
  | { outcome: 'locked' }
  | { outcome: 'not_eligible'; reason: string }
  | {
      outcome: 'refilled';
      kept: number;
      dropped: number;
      added: number;
      front: number;
      poolRows: number;
      injectedRows: number;
      seenDropped: number;
      filteredOut: number;
      cardsBuilt: number;
      pages: number;
      exhausted: boolean;
      lkReady: boolean;
    };

/** Likers sampled into the injected part (the rest still arrive through the pool). */
export const INJECT_LIKERS = 300;
/** Boosted people injected per refill. */
export const INJECT_BOOSTED = 300;
const NEWCOMER_MS = 7 * 86_400_000;
const DAY_MS = 86_400_000;
const LK_REBUILD_SLOT_MS = 10 * 60_000;

function idleDays(activeOn: string, today: string): number {
  return Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${activeOn}T00:00:00Z`)) / DAY_MS));
}

function ageOn(birthDate: string, now: Date): number {
  const [y, m, d] = birthDate.split('-').map(Number) as [number, number, number];
  let age = now.getUTCFullYear() - y;
  if (now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d)) age -= 1;
  return age;
}

/** A stable sample of `n` ids under the viewer's seed (the same refill day picks the same ones). */
function sample(ids: readonly string[], n: number, seed: string): string[] {
  if (ids.length <= n) return [...ids];
  const s = BigInt(seed);
  return [...ids].sort((a, b) => Number(((BigInt(a) ^ s) % 1_000_003n) - ((BigInt(b) ^ s) % 1_000_003n)) || (a < b ? -1 : 1)).slice(0, n);
}

/** Uniform in [0, 1) from the row's seeded hash (`tie`): the per-viewer shuffle. */
function shuffleOf(tie: string): number {
  return Number(BigInt.asUintN(20, BigInt(tie))) / 2 ** 20;
}

function eligible(viewer: DeckViewer | null): string | null {
  if (!viewer) return 'missing';
  if (viewer.status !== 3) return 'status';
  if (!viewer.preferences) return 'preferences';
  if (!viewer.cell || !viewer.country) return 'location';
  if (viewer.gender === undefined || !viewer.birthDate) return 'basics';
  return null;
}

export async function refillDeck(context: JobContext, data: RefillData, options: { now?: number } = {}): Promise<RefillResult> {
  const { services, redis, log } = context;
  const { cache, keys, pg } = services;
  const userId = data.userId;
  const token = await takeDeckLock(cache, keys, userId);
  if (!token) return { outcome: 'locked' };
  try {
    const settings = await deckSettingsOf(services, redis, log).get();
    const now = options.now ?? Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const day = utcDay(now);
    const weeks = likeWeeks(now);

    // Valkey: like buckets and lk:ready (kv-core), the queue (kv-cache), the seen filter (kv-cache).
    const core = redis.pipeline().exists(keys.likesReady()).get(keys.catalogueVersion());
    for (const w of weeks) core.smembers(keys.likesIn(userId, w));
    for (const w of weeks) core.smembers(keys.likesInSuper(userId, w));
    const [coreReplies, existing, seen] = await Promise.all([
      core.exec(),
      readDeck(cache, keys, userId),
      SeenFilter.load(cache, keys, userId, { returnDays: settings.passReturnDays, now }).catch((error: unknown) => {
        log.warn({ err: error }, 'deck refill: seen filter unreadable; nobody is hidden by it this time');
        return SeenFilter.empty();
      }),
    ]);
    if (!coreReplies) throw new Error('deck refill: Valkey pipeline aborted');
    const failed = coreReplies.find(([error]) => error !== null)?.[0];
    if (failed) throw failed;
    const lkReady = Number(coreReplies[0]![1]) === 1;
    const catalogueReply = coreReplies[1]![1];
    const catalogue = typeof catalogueReply === 'string' ? catalogueReply : '0';
    const bucketLikers = new Set<string>();
    const bucketSuper = new Set<string>();
    weeks.forEach((_, i) => {
      for (const id of coreReplies[2 + i]![1] as string[]) bucketLikers.add(id);
      for (const id of coreReplies[2 + weeks.length + i]![1] as string[]) bucketSuper.add(id);
    });
    if (!lkReady) {
      // The buckets are incomplete (Valkey lost them): rebuild them; meanwhile the likers come from PostgreSQL.
      await addJob(redis, context.config.queuePrefix, 'maint', 'lk-rebuild', jobId('lk-rebuild', Math.floor(now / LK_REBUILD_SLOT_MS)), {}).catch(
        (error: unknown) => log.warn({ err: error }, 'deck refill: the like-bucket rebuild could not be queued'),
      );
    }

    const viewer = await deckViewer(pg, userId, {
      store: data.store ?? 0,
      crossStore: settings.crossStore,
      windowDays: settings.likesWindowDays,
      withLikers: !lkReady,
    });
    const notEligible = eligible(viewer);
    if (notEligible) return { outcome: 'not_eligible', reason: notEligible };
    const v = viewer!;
    const prefs = v.preferences!;
    const wholeCountry = (prefs.flags & preferenceFlags.code('whole_country')) !== 0;
    const area = deckArea(v.cell!, prefs.maxDistanceKm, wholeCountry);
    const seed = deckSeed(userId, day);
    const likers = lkReady ? bucketLikers : new Set(v.likers ?? []);
    const superLikers = lkReady ? bucketSuper : new Set(v.superLikers ?? []);
    for (const id of superLikers) likers.add(id);
    likers.delete(userId);
    superLikers.delete(userId);
    const seeLikes = planHas(settings, v.plans ?? [], 'see_likes');

    // Boosted people in the viewer's r5 cells (kv-core), injected whatever their activity order.
    const boostedIds = new Set<string>();
    if (area.res === 5 && area.cells.length > 0) {
      const boosts = redis.pipeline();
      for (const cell of area.cells) boosts.zrangebyscore(keys.boosted(cell), now, '+inf', 'LIMIT', 0, 50);
      for (const [error, ids] of (await boosts.exec()) ?? []) if (!error) for (const id of ids as string[]) boostedIds.add(id);
      boostedIds.delete(userId);
    }

    const keptIds = existing.ids.filter((id) => existing.meta.has(id));
    const queued = new Set(existing.ids);
    const unseen = (id: string) => !queued.has(id) && !seen.has(id);
    const only = [
      ...new Set([
        ...keptIds,
        ...[...superLikers].filter(unseen),
        ...sample([...likers].filter(unseen), INJECT_LIKERS, seed),
        ...[...boostedIds].filter(unseen).slice(0, INJECT_BOOSTED),
      ]),
    ];

    const search: DeckSearch = {
      viewerId: userId,
      res: area.res,
      cells: area.cells,
      country: v.country!,
      center: area.center,
      radiusM: area.radiusM,
      likers: [...likers],
      seed,
    };
    const fingerprint = searchFingerprint(day, area, v.cell!, v.country!);
    const started = decodePoolCursor(existing.cursor);
    // The pool's position, moved by every page (an object: the page reader below assigns it).
    const at: { cursor: PoolCursor | null } = { cursor: started?.fingerprint === fingerprint ? started : null };
    const limit = settings.refill.fetch_limit;
    const steps = [...new Set([...settings.refill.idle_steps.filter((s) => s < settings.refill.max_idle_days), settings.refill.max_idle_days])].sort(
      (a, b) => a - b,
    );

    const pool: DeckCandidate[] = [];
    const injected: DeckCandidate[] = [];
    let pages = 0;
    let ended = false;
    const fetchPage = async (maxIdleDays: number, want: number): Promise<number> => {
      const rows = await deckCandidates(
        pg,
        search,
        { maxIdleDays, after: at.cursor ? { activeOn: at.cursor.activeOn, tie: at.cursor.tie } : null, limit: want },
        pages === 0 ? { ids: only, maxIdleDays: settings.refill.max_idle_days } : null,
      );
      pages += 1;
      const page = rows.filter((r) => !r.injected);
      injected.push(...rows.filter((r) => r.injected));
      pool.push(...page);
      const last = page[page.length - 1];
      if (last) at.cursor = { fingerprint, activeOn: last.activeOn, tie: last.tie };
      return page.length;
    };
    for (const step of steps) {
      // A window that ends before the cursor's day would only return nothing.
      if (at.cursor && step !== steps[steps.length - 1] && idleDays(at.cursor.activeOn, today) > step) continue;
      const want = limit - pool.length;
      ended = (await fetchPage(step, want)) < want;
      if (!ended) break;
    }
    if (ended && started !== null && pool.length < limit) {
      // The end of the pool: once, start again from the top (seen people are dropped below).
      at.cursor = null;
      const want = limit - pool.length;
      ended = (await fetchPage(steps[steps.length - 1]!, want)) < want;
    }
    const nextCursor = ended || !at.cursor ? null : encodePoolCursor(at.cursor);

    // Merge the pool and the injected rows; the same person may be in both.
    const rowsById = new Map<string, DeckCandidate>();
    for (const row of [...injected, ...pool]) if (!rowsById.has(row.userId) && row.userId !== userId) rowsById.set(row.userId, row);

    const filters = compileFilters(prefs.filters, settings.filterFields);
    let seenDropped = 0;
    let filteredOut = 0;
    const kept: DeckCandidate[] = [];
    for (const id of keptIds) {
      const row = rowsById.get(id);
      if (row && passesFilters({ attrs: row.attrs, heightCm: row.heightCm }, filters)) kept.push(row);
    }
    const keptSet = new Set(kept.map((r) => r.userId));
    const fresh: DeckCandidate[] = [];
    for (const row of rowsById.values()) {
      if (keptSet.has(row.userId) || queued.has(row.userId)) continue;
      if (seen.has(row.userId)) {
        seenDropped += 1;
        continue;
      }
      if (!passesFilters({ attrs: row.attrs, heightCm: row.heightCm }, filters)) {
        filteredOut += 1;
        continue;
      }
      fresh.push(row);
    }

    // Inbound load (unanswered likes waiting for each candidate) and running boosts, from kv-core.
    const loads = new Map<string, number>();
    const boosted = new Set<string>(boostedIds);
    if (fresh.length > 0) {
      const lookups = redis.pipeline();
      for (const row of fresh) for (const w of weeks) lookups.scard(keys.likesIn(row.userId, w));
      const byCell = new Map<string, string[]>();
      for (const row of fresh) {
        if (boosted.has(row.userId)) continue;
        const ids = byCell.get(row.cellR5) ?? [];
        ids.push(row.userId);
        byCell.set(row.cellR5, ids);
      }
      const cells = [...byCell.entries()];
      for (const [cell, ids] of cells) lookups.zmscore(keys.boosted(cell), ...ids);
      const replies = (await lookups.exec()) ?? [];
      fresh.forEach((row, i) => {
        let n = 0;
        for (let j = 0; j < weeks.length; j += 1) {
          const [error, count] = replies[i * weeks.length + j] ?? [null, 0];
          if (!error) n += Number(count);
        }
        loads.set(row.userId, n);
      });
      let at = fresh.length * weeks.length;
      for (const [, ids] of cells) {
        const [error, scores] = replies[at] ?? [null, []];
        at += 1;
        if (error) continue;
        (scores as (string | null)[]).forEach((score, j) => {
          if (score !== null && Number(score) > now) boosted.add(ids[j]!);
        });
      }
    }

    const nowDate = new Date(now);
    const inputOf = (row: DeckCandidate): ScoreInput => ({
      userId: row.userId,
      distanceKm: row.distanceM === null ? null : row.distanceM / 1_000,
      idleDays: idleDays(row.activeOn, today),
      completeness: row.completeness,
      verified: (row.flags & 1) !== 0,
      newcomer: now - idTime(row.userId).getTime() < NEWCOMER_MS,
      liker: likers.has(row.userId),
      boosted: boosted.has(row.userId),
      pendingLikes: loads.get(row.userId) ?? 0,
      attrs: row.attrs,
      intents: row.intents,
      ageBand: Math.floor(ageOn(row.birthDate, nowDate) / 5),
      cityId: row.cityId,
    });
    const ctx = { weights: settings.weights, radiusKm: area.radiusM === null ? null : area.radiusM / 1_000, viewerAttrs: v.attrs ?? [], viewerIntents: v.intents ?? prefs.intents };
    const scored = fresh.map((row) => {
      const input = inputOf(row);
      return { row, input, score: scoreOf(input, ctx) + settings.weights.shuffle * shuffleOf(row.tie) };
    });
    const rowOf = new Map(fresh.map((row) => [row.userId, row]));
    const front = scored
      .filter((s) => superLikers.has(s.row.userId))
      .sort((a, b) => b.score - a.score)
      .map((s) => s.row);
    const room = Math.max(0, settings.refill.queue_size - kept.length - front.length);
    const back = diversify(scored.filter((s) => !superLikers.has(s.row.userId)).map((s) => ({ input: s.input, score: s.score })))
      .slice(0, room)
      .map((input) => rowOf.get(input.userId)!);

    // Cards for everyone queued (kept ones are usually cached).
    const queuedRows = [...front, ...kept, ...back];
    const loaded = await loadCards(
      cache,
      keys,
      queuedRows.map((r) => ({ userId: r.userId, version: r.profileVer })),
      catalogue,
      (ids) => profileCards(pg, ids),
      (error) => log.warn({ err: error }, 'deck refill: cards not cached'),
    );
    const entryOf = (row: DeckCandidate): DeckEntry | null => {
      const card = loaded.cards.get(row.userId);
      if (!card) return null;
      const superLiker = superLikers.has(row.userId);
      const flags =
        (superLiker || (seeLikes && likers.has(row.userId)) ? DeckFlag.likesYou : 0) |
        (superLiker ? DeckFlag.superliked : 0) |
        (idleDays(row.activeOn, today) <= 1 ? DeckFlag.activeRecently : 0) |
        (boosted.has(row.userId) ? DeckFlag.boosted : 0);
      return { userId: row.userId, version: card.v, km: row.distanceM === null ? null : row.distanceM / 1_000, flags };
    };
    const entries = (rows: readonly DeckCandidate[]) => rows.map(entryOf).filter((e): e is DeckEntry => e !== null);
    const keptEntries = entries(kept);
    const frontEntries = entries(front);
    const backEntries = entries(back);
    const keptIdsAfter = new Set(keptEntries.map((e) => e.userId));
    const dropped = existing.ids.filter((id) => !keptIdsAfter.has(id));
    const added = frontEntries.length + backEntries.length;

    await writeDeck(cache, keys, userId, {
      kept: keptEntries,
      front: frontEntries,
      back: backEntries,
      drop: dropped,
      builtAt: now,
      cursor: nextCursor,
      exhaustedAt: added === 0 ? now : null,
    });
    log.info(
      { kept: keptEntries.length, dropped: dropped.length, added, pool: pool.length, injected: injected.length, seenDropped, filteredOut, pages, built: loaded.built },
      'deck refilled',
    );
    return {
      outcome: 'refilled',
      kept: keptEntries.length,
      dropped: dropped.length,
      added,
      front: frontEntries.length,
      poolRows: pool.length,
      injectedRows: injected.length,
      seenDropped,
      filteredOut,
      cardsBuilt: loaded.built,
      pages,
      exhausted: added === 0 && keptEntries.length === 0,
      lkReady,
    };
  } finally {
    await releaseDeckLock(cache, keys, userId, token).catch(() => undefined);
  }
}
