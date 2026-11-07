import { createMatch, matchOfPair, mutualLikeExists, spendSuperLike, withTransaction, type MatchRow } from '@app/db';
import {
  idTime,
  realtimeEnvelope,
  userChannel,
  wireTime,
  type Conversation,
  type PeerSummary,
  type Swipe,
  type SwipeResult,
  type SwipesResponse,
} from '@app/shared';
import {
  addSeen,
  announceMatch,
  appendMatch,
  clearPairLikes,
  conversationOf,
  countPendingLikes,
  dropFromDeck,
  dropPendingLikers,
  isLikeAnswered,
  jobId,
  matchSourceOf,
  parseCardSource,
  peerSummaryOf,
  photoVariantUrl,
  quotaPeriod,
  readQuotas,
  runLikeScript,
  useHourlySwipes,
  useQuota,
  type LikeScriptOutcome,
  type MatchEntry,
} from '@app/shared/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nextId } from '../auth/sessions.js';
import { HttpProblem } from '../lib/problem.js';
import type { ActiveAccount } from './active.js';
import type { ConfigSnapshot } from './cfg.js';
import { planLimit, sessionPlan } from './plans.js';

/**
 * `POST /v1/swipes`: passes, likes and super likes, in the order sent.
 *
 * - Every swipe that took effect leaves the person's deck queue (`LREM`) and
 *   goes into their seen filter (kv-cache); a pass on someone who liked them
 *   also drops that like from their buckets. A pass costs no statement.
 * - A like: the daily quota (Valkey), then the like script (mutual-like
 *   detection, the append to `wb:like`, the target's bucket). No statement;
 *   the worker inserts likes in batches.
 * - A super like: the weekly quota, else one from the wallet: the debit, its
 *   ledger row and the like row in one transaction (three statements), so a
 *   paid like is durable before anything else happens.
 * - A `check` (the actor's buckets are incomplete): one primary-key look-up
 *   in PostgreSQL; when the other like is there, the match is appended to
 *   `wb:match` and made as below.
 * - A match: the script already appended it to `wb:match` with the
 *   pre-minted ids; the INSERT here (one statement) is the fast path, so the
 *   answer can carry the conversation. The worker repeats it (a no-op),
 *   writes the like notes and publishes the event and the pushes.
 *
 * The target of a like is told (`like` event, and a push collapsed per
 * person) once the like is in the stream.
 */

/** A like push waits this long, so the likes of a burst become one push (the job id is per person). */
export const LIKE_PUSH_DELAY_MS = 30_000;

interface Target {
  swipe: Swipe;
  /** Null: not a person (a malformed or foreign id), or the caller. */
  userId: string | null;
}

export interface SwipeEnvironment {
  app: FastifyInstance;
  request: FastifyRequest;
  account: ActiveAccount;
  cfg: ConfigSnapshot;
  now?: number | undefined;
}

function budget(request: FastifyRequest, statements: number): void {
  if (request.pgTally?.budget !== undefined) request.pgTally.budget += statements;
}

/** How the actor appears to the target of a super like (their own first approved photo). */
function actorSummary(app: FastifyInstance, account: ActiveAccount): PeerSummary | undefined {
  const view = account.view;
  const name = view.profile?.name;
  if (!name) return undefined;
  const first = [...view.photos].filter((p) => p.status === 3).sort((a, b) => a.position - b.position)[0];
  let photo: PeerSummary['photo'] = null;
  if (first && app.media && first.w && first.h) {
    const url = photoVariantUrl(app.media, first.id, first.blobVer, 320);
    if (url) photo = { id: first.id, w: first.w, h: first.h, blurhash: first.blurhash ?? '', url };
  }
  return { id: account.session.publicUid, name, photo, verified: view.verified };
}

export class SwipeService {
  private readonly app: FastifyInstance;
  private readonly request: FastifyRequest;
  private readonly account: ActiveAccount;
  private readonly cfg: ConfigSnapshot;
  private readonly now: number;
  private readonly me: string;

  constructor(env: SwipeEnvironment) {
    this.app = env.app;
    this.request = env.request;
    this.account = env.account;
    this.cfg = env.cfg;
    this.now = env.now ?? Date.now();
    this.me = env.account.session.userId;
  }

  private get log() {
    return this.request.log;
  }

  async run(swipes: readonly Swipe[]): Promise<SwipesResponse> {
    const { app, cfg, me } = this;
    // Every comment is checked before anything happens: a refused one refuses the request.
    for (const swipe of swipes) {
      if (swipe.comment && cfg.bannedTerms.severity(swipe.comment, 'messages') >= 3) {
        throw new HttpProblem('text_refused', { detail: 'This comment cannot be sent.' });
      }
    }
    const hourly = await useHourlySwipes(app.redis, app.keys, me, swipes.length, this.now);
    if (!hourly.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil((hourly.resetsAtMs - this.now) / 1_000));
      throw new HttpProblem('rate_limited', { retryAfterSeconds, headers: { 'retry-after': String(retryAfterSeconds) } });
    }

    const plan = (await sessionPlan({ cache: app.cache, keys: app.keys, db: app.pg, log: this.log }, this.request, cfg, me, this.account.session.storeCode)).plan;
    // Test accounts are left out of quotas.
    const likeLimit = this.account.test ? -1 : planLimit(plan, 'daily_likes');
    const superLimit = this.account.test ? -1 : planLimit(plan, 'weekly_superlikes');

    const seenInRequest = new Set<string>();
    const targets: Target[] = swipes.map((swipe) => {
      const id = app.publicIds.user.decodeId(swipe.target);
      if (id === null || id === me || seenInRequest.has(id)) return { swipe, userId: null };
      seenInRequest.add(id);
      return { swipe, userId: id };
    });

    const results: SwipeResult[] = [];
    const swiped: string[] = [];
    const passed: string[] = [];
    for (const { swipe, userId } of targets) {
      if (userId === null) {
        results.push({ target: swipe.target, result: 'skipped' });
        continue;
      }
      if (swipe.action === 'pass') {
        passed.push(userId);
        swiped.push(userId);
        results.push({ target: swipe.target, result: 'passed' });
        continue;
      }
      const result = await this.like(swipe, userId, swipe.action === 'superlike' ? superLimit : likeLimit);
      if (result.result !== 'quota') swiped.push(userId);
      results.push(result);
    }

    // The deck and the seen filter are kv-cache (losing them is tolerated): a failure is logged, not answered.
    if (swiped.length > 0) {
      await Promise.all([
        dropFromDeck(app.cache, app.keys, me, swiped).catch((error: unknown) => this.log.warn({ err: error }, 'swipes: deck not updated')),
        addSeen(app.cache, app.keys, me, swiped, { returnDays: cfg.app['deck.pass_return_days'], now: this.now })
          .then((added) => {
            if (added.full) this.log.warn('swipes: the seen filter of this period is full');
          })
          .catch((error: unknown) => this.log.warn({ err: error }, 'swipes: seen filter not updated')),
      ]);
    }
    if (passed.length > 0) await dropPendingLikers(app.redis, app.keys, me, passed, this.now);

    const used = await readQuotas(app.redis, app.keys, me, this.now);
    return {
      results,
      quotas: {
        likes: { limit: likeLimit, used: used.likes, resetsAt: wireTime(quotaPeriod('likes', this.now).resetsAtMs) },
        superlikes: { limit: superLimit, used: used.superlikes, resetsAt: wireTime(quotaPeriod('superlikes', this.now).resetsAtMs) },
      },
    };
  }

  private async like(swipe: Swipe, targetId: string, limit: number): Promise<SwipeResult> {
    const { app, me } = this;
    const kind: 1 | 2 = swipe.action === 'superlike' ? 2 : 1;
    const itemKind: 0 | 1 | 2 = swipe.item ? (swipe.item.kind === 'photo' ? 1 : 2) : 0;
    const itemRef = swipe.item?.ref;
    const comment = swipe.comment;
    const quota = kind === 2 ? 'superlikes' : 'likes';
    const likeId = nextId(app);
    const matchId = nextId(app);
    const noteIds: [string, string] = [nextId(app), nextId(app)];

    let counted = false;
    let prepaid = false;
    const use = await useQuota(app.redis, app.keys, quota, me, limit, 1, this.now);
    if (use.allowed) {
      counted = true;
    } else if (kind === 2) {
      // Beyond the weekly super likes: the wallet, unless the like would change nothing (pending, or the pair matched).
      if (await isLikeAnswered(app.redis, app.keys, me, targetId, this.now)) return { target: swipe.target, result: 'duplicate' };
      const paid = await this.payFromWallet(likeId, targetId, itemKind, itemRef, comment);
      if (!paid) return { target: swipe.target, result: 'quota' };
      prepaid = true;
    } else {
      return { target: swipe.target, result: 'quota' };
    }

    let outcome: LikeScriptOutcome;
    try {
      outcome = await runLikeScript(app.redis, app.keys, {
        actorId: me,
        targetId,
        likeId,
        kind,
        itemKind,
        itemRef,
        comment,
        matchId,
        noteIds,
        prepaid,
        bucketCap: this.cfg.app['likes.bucket_cap'],
        now: this.now,
      });
    } catch (error) {
      if (counted) await this.giveBack(quota);
      // A paid like is in PostgreSQL already: the bucket rebuild finds it.
      throw error;
    }

    if (outcome === 'duplicate') {
      if (counted) await this.giveBack(quota);
      return { target: swipe.target, result: 'duplicate' };
    }
    if (outcome === 'check') {
      budget(this.request, 1);
      const mutual = await mutualLikeExists(app.pg, me, targetId, this.cfg.app['likes.window_days']);
      if (!mutual) {
        await this.announceLike(targetId, likeId, kind);
        return { target: swipe.target, result: 'liked' };
      }
      // The other like is in PostgreSQL: the match becomes durable in wb:match first, as the script does it.
      const entry: MatchEntry = { matchId, actorId: me, targetId, kind, noteIds, likeId, itemKind, itemRef: itemRef ?? null, comment: comment ?? null };
      await appendMatch(app.redis, app.keys, entry);
      outcome = 'match';
    }
    if (outcome === 'match') {
      const conversation = await this.makeMatch(matchId, targetId, matchSourceOf(kind, itemKind));
      if (conversation) return { target: swipe.target, result: 'matched', conversation };
      // The pair may not match (one side is hidden, or they matched before): the like stands, nothing is revealed.
      return { target: swipe.target, result: conversation === null ? 'liked' : 'skipped' };
    }
    await this.announceLike(targetId, likeId, kind);
    return { target: swipe.target, result: 'liked' };
  }

  private async giveBack(quota: 'likes' | 'superlikes'): Promise<void> {
    await useQuota(this.app.redis, this.app.keys, quota, this.me, -1, -1, this.now).catch((error: unknown) =>
      this.log.warn({ err: error }, 'swipes: quota not given back'),
    );
  }

  private async payFromWallet(likeId: string, targetId: string, itemKind: 0 | 1 | 2, itemRef: string | undefined, comment: string | undefined) {
    const { app, me } = this;
    const store = this.account.session.storeCode ?? 0;
    const ledgerId = nextId(app);
    budget(this.request, 3);
    return withTransaction(app.pg, (tx) =>
      spendSuperLike(tx, {
        userId: me,
        store,
        crossStore: this.cfg.app['billing.cross_store_entitlements'],
        ledgerId,
        like: { id: likeId, targetId, actorId: me, kind: 2, itemKind, itemRef: itemRef ?? null, comment: comment ?? null },
      }),
    );
  }

  /**
   * The fast path of a match: the INSERT with the pre-minted id, then the
   * Valkey state both people's lists read. Returns the actor's conversation,
   * `null` when the pair may not match, or `undefined` when the pair already
   * had a match of its own (an earlier one).
   */
  private async makeMatch(matchId: string, targetId: string, source: 1 | 2 | 4): Promise<Conversation | null | undefined> {
    const { app, me } = this;
    budget(this.request, 1);
    let row: MatchRow | null = await createMatch(app.pg, { matchId, actorId: me, targetId, source });
    if (!row) {
      // Either the pair may not match, or the worker's INSERT of the same pair was not committed when ours began.
      budget(this.request, 1);
      row = await matchOfPair(app.pg, me, targetId);
    }
    if (!row) return null;
    if (row.id !== matchId) return undefined;
    if (row.state !== 1) return undefined;
    const state = { id: row.id, lo: row.lo, hi: row.hi, state: row.state, flags: row.flags, source: row.source, createdMs: idTime(row.id).getTime() };
    try {
      await announceMatch(app.redis, app.keys, state);
      await clearPairLikes(app.redis, app.keys, me, targetId, this.now);
    } catch (error) {
      // The worker announces it again from wb:match.
      this.log.warn({ err: error }, 'swipes: match state not cached');
    }
    const card = parseCardSource(row.lo === targetId ? row.loCard : row.hiCard);
    const peer: PeerSummary = card
      ? peerSummaryOf({ publicIds: app.publicIds, media: app.media }, targetId, card)
      : { id: app.publicIds.user.encode(targetId), name: '', photo: null, verified: false };
    return conversationOf({ match: row, viewerId: me, peer });
  }

  /** Tells the target: the `like` event (with the liker only for a super like) and a push collapsed per person. */
  private async announceLike(targetId: string, likeId: string, kind: 1 | 2): Promise<void> {
    const { app } = this;
    try {
      if (app.realtime) {
        const { total } = await countPendingLikes(app.redis, app.keys, targetId, this.now);
        const from = kind === 2 && !this.account.test ? actorSummary(app, this.account) : undefined;
        const envelope = realtimeEnvelope('like', likeId, this.now, { total, kind: kind === 2 ? 'superlike' : 'like', ...(from ? { from } : {}) });
        await app.realtime.publish(userChannel(app.publicIds.user.encode(targetId)), envelope);
      }
    } catch (error) {
      this.log.warn({ err: error }, 'swipes: like event not published');
    }
    try {
      await app.jobs.add('push', 'send', jobId('send', 'like', targetId), { type: 'like', userId: targetId }, { delayMs: LIKE_PUSH_DELAY_MS, attempts: 3, backoffMs: 5_000 });
    } catch (error) {
      this.log.warn({ err: error }, 'swipes: like push not queued');
    }
  }
}
