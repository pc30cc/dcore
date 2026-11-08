import { profileCards } from '@app/db';
import { deckPageSchema, deckQuerySchema, preferenceFlags, type DeckSuggestion, type ProfileCard } from '@app/shared';
import { cardChangedSince, DeckFlag, dropFromDeck, jobId, loadCards, readDeckHead, updateDeckEntries, type DeckEntry } from '@app/shared/server';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { HttpProblem } from '../lib/problem.js';
import { activeAccount } from '../services/active.js';
import { renderCard } from '../services/cards.js';
import { requireScope } from '../services/session.js';

/**
 * `GET /v1/deck`: the head of the person's prepared deck, from Valkey.
 *
 * - The queue (`deck:<uid>` + `deckm:<uid>`, kv-cache) is read in one round
 *   trip without taking anything: a swipe removes its card.
 * - People hidden since the queue was built (`vis:out`: a ban, a snooze, a
 *   deletion, a shadowban) are skipped; so are people whose card no longer
 *   exists. Both are dropped from the queue.
 * - Cards come from `card:<uid>:<ver>:<catv>` in one MGET; the misses of the
 *   page are built in one statement (`profile_cards()`), the only statement
 *   this route may send (besides the own-account view on a cold cache). A
 *   person whose card changed after their entry's version was taken (an
 *   edit, a privacy switch, a photo deleted or refused: their `vis:chg`
 *   stamp, read with `vis:out`) is built again with the misses, whatever
 *   card the cache holds for the old version. A card built at a newer
 *   version moves the queue's entry to it (with the stamp it was checked
 *   against), so it is not built again.
 * - When the queue runs low (`deck.refill.refill_below`) or is gone, a
 *   refill is queued for the worker (one per person per 30 seconds). An
 *   empty page while a refill is due says `exhausted: false`; `exhausted:
 *   true` only once a refill found nobody new (then a refill is asked for
 *   again at most every 10 minutes), with suggestions.
 */

/** Ids read past the page, to replace people skipped on the way. */
const HEAD_SLACK = 20;
/** A refill that found nobody is not asked for again before this. */
export const EXHAUSTED_RETRY_MS = 10 * 60_000;
/** Clock slack between the API and the worker when comparing hide times with the queue's build time. */
const HIDDEN_SLACK_MS = 60_000;
const REFILL_SLOT_MS = 30_000;
const MAX_DISTANCE_KM = 500;

export const deckRoutes: FastifyPluginAsyncZod = async (app) => {
  const fullOnly = requireScope(app, app.account, ['full']);

  app.get(
    '/v1/deck',
    {
      preHandler: fullOnly,
      // The page's missing cards (one statement); the own-account view on a cold cache raises it by one itself.
      config: { pgBudget: 1 },
      schema: {
        tags: ['deck'],
        summary: 'The next cards of the prepared deck',
        querystring: deckQuerySchema,
        response: { 200: deckPageSchema },
      },
    },
    async (request, reply) => {
      const { session, view } = await activeAccount(app, request);
      const preferences = view.preferences;
      if (!preferences) throw new HttpProblem('onboarding_incomplete');
      if (!view.location) throw new HttpProblem('location_required');
      const cfg = app.cfg.get();
      const settings = cfg.app['deck.refill'];
      const { keys } = app;
      const userId = session.userId;
      const now = Date.now();
      const limit = request.query.limit;

      const [head, catalogue] = await Promise.all([
        readDeckHead(app.cache, keys, userId, limit + HEAD_SLACK),
        app.redis.get(keys.catalogueVersion()),
      ]);
      const entries = head.entries;
      const hiddenSince = new Map<string, number>();
      const changedAt = new Map<string, number>();
      if (entries.length > 0) {
        const ids = entries.map((e) => e.userId);
        const replies = await app.redis.pipeline().zmscore(keys.accountsHidden(), ...ids).zmscore(keys.profilesChanged(), ...ids).exec();
        const failed = replies?.find(([error]) => error !== null)?.[0];
        if (!replies || failed) throw failed ?? new Error('deck: Valkey pipeline aborted');
        const [hidden, changed] = [replies[0]![1] as (string | null)[], replies[1]![1] as (string | null)[]];
        ids.forEach((id, i) => {
          if (hidden[i] !== null && hidden[i] !== undefined) hiddenSince.set(id, Number(hidden[i]));
          if (changed[i] !== null && changed[i] !== undefined) changedAt.set(id, Number(changed[i]));
        });
      }
      const builtAt = head.builtAt ?? 0;
      const drop: string[] = [...head.broken];
      const visible: DeckEntry[] = [];
      for (const entry of entries) {
        const hidden = hiddenSince.get(entry.userId);
        if (hidden !== undefined && hidden >= builtAt - HIDDEN_SLACK_MS) drop.push(entry.userId);
        else visible.push(entry);
      }

      // Cards for a page and its replacements: a person whose card is gone is skipped too.
      const cards: ProfileCard[] = [];
      const newer: DeckEntry[] = [];
      let consumed = head.broken.length + (entries.length - visible.length);
      if (visible.length > 0) {
        const wanted = visible;
        // A card that changed since its version was taken is asked for at version 0, which is never cached: it is built.
        const stale = new Set(wanted.filter((e) => cardChangedSince(e, builtAt, changedAt.get(e.userId) ?? null)).map((e) => e.userId));
        const loaded = await loadCards(
          app.cache,
          keys,
          wanted.map((e) => ({ userId: e.userId, version: stale.has(e.userId) ? 0 : e.version })),
          catalogue ?? '0',
          (ids) => profileCards(app.pg, ids),
          (error) => request.log.warn({ err: error }, 'deck: cards not cached'),
        );
        for (const entry of wanted) {
          if (cards.length >= limit) break;
          consumed += 1;
          const card = loaded.cards.get(entry.userId);
          if (!card) {
            drop.push(entry.userId);
            continue;
          }
          // The stamp read before the build: a change after it has a larger one, so it is noticed next time.
          if (stale.has(entry.userId)) newer.push({ ...entry, version: card.v, checkedAt: changedAt.get(entry.userId) });
          else if (card.v !== entry.version) newer.push({ ...entry, version: card.v });
          cards.push(
            renderCard(
              app,
              entry.userId,
              card,
              {
                km: entry.km,
                likesYou: (entry.flags & DeckFlag.likesYou) !== 0,
                superliked: (entry.flags & DeckFlag.superliked) !== 0,
                activeRecently: (entry.flags & DeckFlag.activeRecently) !== 0,
              },
              request.locale,
            ),
          );
        }
      }
      if (drop.length > 0) {
        dropFromDeck(app.cache, keys, userId, drop).catch((error: unknown) => request.log.warn({ err: error }, 'deck: hidden people not dropped'));
      }
      if (newer.length > 0) {
        // A profile changed since the queue was built: the next read asks for the card it just built.
        updateDeckEntries(app.cache, keys, userId, newer).catch((error: unknown) => request.log.warn({ err: error }, 'deck: versions not updated'));
      }

      const remaining = Math.max(0, head.length - consumed);
      const exhaustedRecently = head.exhaustedAt !== null && now - head.exhaustedAt < EXHAUSTED_RETRY_MS;
      if (remaining < settings.refill_below && !exhaustedRecently) {
        try {
          await app.jobs.add('deck', 'refill', jobId('refill', userId, Math.floor(now / REFILL_SLOT_MS)), {
            userId,
            ...(session.storeCode !== undefined ? { store: session.storeCode } : {}),
          });
        } catch (error) {
          // The page is still good; the next request asks again.
          request.log.warn({ err: error }, 'deck: refill not queued');
        }
      }

      const exhausted = cards.length === 0 && remaining === 0 && exhaustedRecently;
      const suggestions: DeckSuggestion[] = [];
      if (exhausted) {
        const wholeCountry = (preferences.flags & preferenceFlags.code('whole_country')) !== 0;
        if (!wholeCountry && preferences.maxDistanceKm < MAX_DISTANCE_KM) suggestions.push('widen_distance');
        if (preferences.ageMin > 18 || preferences.ageMax < 99) suggestions.push('widen_age');
        suggestions.push('boost');
      }
      reply.header('cache-control', 'private, no-store');
      return { cards, remaining, exhausted, ...(exhausted ? { suggestions } : {}) };
    },
  );
};
