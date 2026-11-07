import { likeDetails, profileFor, visibleLikers } from '@app/db';
import { decodeCursor, encodeCursor, likeItemKind, type LikeItem, type LikesPage, type ProfileCard } from '@app/shared';
import { parseCardSource, readPendingLikes, utcDay, type PendingLikes } from '@app/shared/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpProblem } from '../lib/problem.js';
import type { ActiveAccount } from './active.js';
import { renderCard } from './cards.js';
import type { ConfigSnapshot } from './cfg.js';
import { planFeature, sessionPlan } from './plans.js';

/**
 * "Who liked me" (`GET /v1/likes`) and a profile opened from a list
 * (`GET /v1/profiles/:publicUid`).
 *
 * The likers come from the person's like buckets in Valkey (super likers
 * first, then the newest week first); one statement applies the visibility
 * rule to the page (context 1, and no match yet) and returns the cards; with
 * see-likes, a second one reads the liked items and comments. On the free
 * plan a like shows only its blurhash, except super likes and the day's one
 * open like (chosen once a day and kept in `lkr:<uid>:<day>`).
 */

/** Likes a free plan sees open each day, besides super likes. */
export const DAILY_REVEALS = 1;

const cursorSchema = z.object({ s: z.union([z.literal(0), z.literal(1)]), w: z.number().int(), i: z.string().regex(/^[1-9][0-9]{0,18}$/) });

interface Entry {
  id: string;
  week: number;
  superlike: boolean;
}

function budget(request: FastifyRequest, statements: number): void {
  if (request.pgTally?.budget !== undefined) request.pgTally.budget += statements;
}

function compareIds(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x > y ? -1 : x < y ? 1 : 0;
}

/** Super likers first, then by week (newest first), then by id (newest first). */
export function orderedLikers(pending: PendingLikes): Entry[] {
  const entries: Entry[] = [];
  for (const bucket of pending.buckets) {
    const supers = new Set(bucket.superLikers);
    for (const id of bucket.likers) entries.push({ id, week: bucket.week, superlike: supers.has(id) });
  }
  return entries.sort((a, b) => Number(b.superlike) - Number(a.superlike) || b.week - a.week || compareIds(a.id, b.id));
}

function after(entry: Entry, cursor: z.infer<typeof cursorSchema>): boolean {
  const s = entry.superlike ? 1 : 0;
  if (s !== cursor.s) return s < cursor.s;
  if (entry.week !== cursor.w) return entry.week < cursor.w;
  return BigInt(entry.id) < BigInt(cursor.i);
}

export class LikesService {
  constructor(
    private readonly app: FastifyInstance,
    private readonly request: FastifyRequest,
    private readonly account: ActiveAccount,
    private readonly cfg: ConfigSnapshot,
  ) {}

  private cardDeps() {
    return { publicIds: this.app.publicIds, media: this.app.media, cities: this.app.cities };
  }

  private async seesLikes(): Promise<boolean> {
    const { app } = this;
    const plan = await sessionPlan({ cache: app.cache, keys: app.keys, db: app.pg, log: this.request.log }, this.request, this.cfg, this.account.session.userId, this.account.session.storeCode);
    return planFeature(plan.plan, 'see_likes');
  }

  async page(limit: number, cursor: string | undefined): Promise<LikesPage> {
    const { app } = this;
    const me = this.account.session.userId;
    let from: z.infer<typeof cursorSchema> | undefined;
    if (cursor !== undefined) {
      const decoded = decodeCursor(cursorSchema, cursor);
      if (!decoded) throw new HttpProblem('bad_request', { detail: 'The cursor is not valid.' });
      from = decoded;
    }
    const now = Date.now();
    const pending = await readPendingLikes(app.redis, app.keys, me, now);
    const all = orderedLikers(pending);
    const rest = from ? all.filter((e) => after(e, from)) : all;
    const candidates = rest.slice(0, limit);
    const more = rest.length > limit;
    const seeLikes = await this.seesLikes();

    budget(this.request, 1);
    const visible = await visibleLikers(app.pg, me, candidates.map((c) => c.id));
    const cards = new Map(visible.map((v) => [v.id, parseCardSource(v.card)]));

    const details = new Map<string, Awaited<ReturnType<typeof likeDetails>>[number]>();
    const shown = candidates.filter((c) => cards.get(c.id));
    if (seeLikes && shown.length > 0) {
      budget(this.request, 1);
      for (const d of await likeDetails(app.pg, me, shown.map((c) => c.id), this.cfg.app['likes.window_days'])) details.set(d.actorId, d);
    }
    const reveal = seeLikes ? null : await this.dailyReveal(me, all.filter((e) => !e.superlike && cards.get(e.id)).map((e) => e.id), now);

    const items: LikeItem[] = [];
    for (const entry of shown) {
      const card = cards.get(entry.id);
      if (!card) continue;
      const kind = entry.superlike ? 'superlike' : 'like';
      const open = seeLikes || entry.superlike || entry.id === reveal;
      if (!open) {
        const blurhash = card.photos[0]?.bh;
        items.push({ kind, ...(blurhash && blurhash.length <= 64 ? { blurhash } : {}) });
        continue;
      }
      const liker: ProfileCard = renderCard(this.cardDeps(), entry.id, card, { likesYou: seeLikes || entry.superlike, superliked: entry.superlike }, this.request.locale);
      const item: LikeItem = { liker, kind };
      const detail = details.get(entry.id);
      if (detail && seeLikes) {
        if (detail.itemKind !== 0 && detail.itemRef) item.item = { kind: likeItemKind.name(detail.itemKind) === 'photo' ? 'photo' : 'prompt', ref: detail.itemRef };
        if (detail.comment) item.comment = detail.comment;
      }
      items.push(item);
    }
    const last = candidates.at(-1);
    return {
      total: pending.total,
      ...(pending.capped ? { totalPlus: true as const } : {}),
      items,
      nextCursor: more && last ? encodeCursor({ s: last.superlike ? 1 : 0, w: last.week, i: last.id }) : null,
    };
  }

  /** The day's open like on a free plan: chosen the first time the day's list is read, then kept. */
  private async dailyReveal(me: string, eligible: readonly string[], now: number): Promise<string | null> {
    const { app } = this;
    const key = app.keys.likesReveal(me, utcDay(now));
    try {
      const chosen = await app.redis.get(key);
      if (chosen !== null) return chosen === '-' ? null : chosen;
      const first = eligible[0];
      if (!first || DAILY_REVEALS < 1) return null;
      const set = await app.redis.set(key, first, 'EX', 2 * 86_400, 'NX');
      return set === 'OK' ? first : await app.redis.get(key);
    } catch (error) {
      this.request.log.warn({ err: error }, 'likes: daily reveal unreadable');
      return null;
    }
  }

  /**
   * A profile opened from chat, likes or requests: one statement for the
   * visibility rule and the card. `likesYou`/`superliked` from the buckets
   * (the plan is read only when the person is a pending liker).
   */
  async profile(targetId: string): Promise<ProfileCard> {
    const { app } = this;
    const me = this.account.session.userId;
    if (targetId === me) throw new HttpProblem('not_found');
    budget(this.request, 1);
    const view = await profileFor(app.pg, me, targetId);
    const card = view.visible ? parseCardSource(view.card) : null;
    if (!card) throw new HttpProblem('not_found');
    const pending = await readPendingLikes(app.redis, app.keys, me);
    const bucket = pending.buckets.find((b) => b.likers.includes(targetId));
    const superliked = bucket?.superLikers.includes(targetId) === true;
    const likesYou = bucket !== undefined && (superliked || (await this.seesLikes()));
    return renderCard(this.cardDeps(), targetId, card, { likesYou, superliked }, this.request.locale);
  }
}

