import { z } from 'zod';
import { many, maybeOne, sql } from '../query.js';
import { defineQuery } from './define.js';

/**
 * The deck worker's statements (migration 0014): the viewer's search before
 * a refill, the candidate pool together with the injected people in one
 * statement, the batch card build, and the like-bucket rebuild's keyset
 * walk over `likes`. None of them runs on a request path except
 * {@link profileCards} for cards that left the cache.
 */

const id = z.string().regex(/^[1-9][0-9]{0,18}$/);

const viewerSchema = z.object({
  status: z.number().int(),
  test: z.boolean(),
  gender: z.number().int().optional(),
  birthDate: z.string().optional(),
  /** The effective r7 cell (travel while it lasts, else home), as decimal text. */
  cell: id.optional(),
  country: z.string().length(2).optional(),
  preferences: z
    .object({
      interestedIn: z.number().int(),
      ageMin: z.number().int(),
      ageMax: z.number().int(),
      maxDistanceKm: z.number().int(),
      intents: z.number().int(),
      flags: z.number().int(),
      filters: z.record(z.string(), z.array(z.number())),
    })
    .optional(),
  /** The viewer's own discovery attributes (absent while the viewer is not in discovery). */
  attrs: z.array(z.number().int()).optional(),
  intents: z.number().int().optional(),
  plans: z.array(z.number().int()).optional(),
  /** Only while the like buckets are being rebuilt (lk:ready absent). */
  likers: z.array(id).optional(),
  superLikers: z.array(id).optional(),
});
export type DeckViewer = z.infer<typeof viewerSchema>;

export interface DeckViewerOptions {
  /** The session's store code (plans of that store and admin grants). */
  store: number;
  crossStore: boolean;
  /** `likes.window_days`. */
  windowDays: number;
  /** Read the likers from `likes` (the Valkey buckets are not complete). */
  withLikers: boolean;
}

/** One read: `deck_viewer()`. Null when there is no such account. */
export const deckViewer = defineQuery({ name: 'deck.viewer', statements: 1 }, async (db, userId: string, options: DeckViewerOptions) => {
  const row = await maybeOne<{ viewer: unknown }>(
    db,
    sql`SELECT deck_viewer(${userId}::bigint, ${options.store}::smallint, ${options.crossStore}::boolean,
                           ${options.windowDays}::integer, ${options.withLikers}::boolean) AS viewer`,
  );
  if (!row || row.viewer === null) return null;
  return viewerSchema.parse(row.viewer);
});

export interface DeckSearch {
  viewerId: string;
  /** 5 or 3 (cells of that resolution), 0 (the whole country). */
  res: 0 | 3 | 5;
  cells: readonly string[];
  country: string;
  /** The viewer's cell centre; null with the whole country. */
  center: { lat: number; lng: number } | null;
  radiusM: number | null;
  likers: readonly string[];
  seed: string;
}

export interface DeckPoolPage {
  maxIdleDays: number;
  /** Keyset cursor (the last row's `activeOn` and `tie`), null for the first page. */
  after: { activeOn: string; tie: string } | null;
  limit: number;
}

export interface DeckCandidate {
  userId: string;
  profileVer: number;
  distanceM: number | null;
  /** `YYYY-MM-DD`. */
  activeOn: string;
  tie: string;
  birthDate: string;
  completeness: number;
  quality: number;
  flags: number;
  intents: number;
  heightCm: number | null;
  cityId: number | null;
  attrs: number[];
  cellR5: string;
  /** From the injected part (a liker, super liker or boosted person), not the pool. */
  injected: boolean;
}

interface CandidateRow {
  injected: boolean;
  user_id: string;
  profile_ver: number;
  distance_m: number | null;
  active_on: string;
  tie: string;
  birth_date: string;
  completeness: number;
  quality: number;
  flags: number;
  intents: number;
  height_cm: number | null;
  city_id: number | null;
  attrs: number[] | null;
  h3_r5: string;
}

function candidateCall(search: DeckSearch, page: DeckPoolPage, only: readonly string[] | null) {
  const center = search.center ? sql`ST_SetSRID(ST_MakePoint(${search.center.lng}::float8, ${search.center.lat}::float8), 4326)::geography` : sql`NULL::geography`;
  return sql`deck_candidates(${search.viewerId}::bigint, ${search.res}::integer, ${search.cells}::bigint[], ${search.country}::text,
                             ${center}, ${search.radiusM}::integer, ${search.likers}::bigint[], ${page.maxIdleDays}::integer,
                             ${search.seed}::bigint, ${page.after?.activeOn ?? null}::date, ${page.after?.tie ?? null}::bigint,
                             ${page.limit}::integer, ${only}::bigint[])`;
}

const COLUMNS = sql`c.user_id::text AS user_id, c.profile_ver, c.distance_m, c.active_on::text AS active_on, c.tie::text AS tie,
                    c.birth_date::text AS birth_date, c.completeness, c.quality, c.flags, c.intents, c.height_cm, c.city_id,
                    c.attrs, c.h3_r5::text AS h3_r5`;

/** The injected people of a refill: checked under the same rules, in the widest activity window. */
export interface DeckInjected {
  ids: readonly string[];
  maxIdleDays: number;
}

/**
 * One page of the candidate pool and, in the same statement, the injected
 * people (the same rules, no cursor, their own activity window) when any.
 */
export const deckCandidates = defineQuery(
  { name: 'deck.candidates', statements: 1 },
  async (db, search: DeckSearch, page: DeckPoolPage, injected: DeckInjected | null = null): Promise<DeckCandidate[]> => {
    const pool = sql`SELECT false AS injected, ${COLUMNS} FROM ${candidateCall(search, page, null)} c`;
    const statement =
      injected && injected.ids.length > 0
        ? sql`${pool} UNION ALL SELECT true AS injected, ${COLUMNS} FROM ${candidateCall(search, { maxIdleDays: injected.maxIdleDays, after: null, limit: injected.ids.length }, injected.ids)} c`
        : pool;
    const rows = await many<CandidateRow>(db, statement);
    return rows.map((r) => ({
      userId: r.user_id,
      profileVer: r.profile_ver,
      distanceM: r.distance_m,
      activeOn: r.active_on,
      tie: r.tie,
      birthDate: r.birth_date,
      completeness: r.completeness,
      quality: r.quality,
      flags: r.flags,
      intents: r.intents,
      heightCm: r.height_cm,
      cityId: r.city_id,
      attrs: r.attrs ?? [],
      cellR5: r.h3_r5,
      injected: r.injected,
    }));
  },
);

/** `profile_card()` of many people in one statement; people without a card are left out. */
export const profileCards = defineQuery({ name: 'deck.cards', statements: 1 }, async (db, userIds: readonly string[]) => {
  const out = new Map<string, unknown>();
  if (userIds.length === 0) return out;
  const rows = await many<{ user_id: string; card: unknown }>(db, sql`SELECT user_id::text AS user_id, card FROM profile_cards(${userIds}::bigint[])`);
  for (const row of rows) if (row.card !== null) out.set(row.user_id, row.card);
  return out;
});

export interface PendingLike {
  targetId: string;
  actorId: string;
  likeId: string;
  /** 1 like, 2 super like. */
  kind: number;
  /** The two matched: not pending. */
  matched: boolean;
}

/**
 * The like-bucket rebuild's walk: likes of the window in primary-key order
 * after `(target, actor, id)`, each with whether the pair matched (either
 * way; those stay out of the buckets). Matched rows are returned rather than
 * filtered so a chunk is never empty before the end. One statement per
 * chunk; a `null` cursor starts at the beginning.
 */
export const pendingLikesChunk = defineQuery(
  { name: 'deck.pendingLikes', statements: 1 },
  async (db, after: { targetId: string; actorId: string; likeId: string } | null, limit: number, windowDays: number): Promise<PendingLike[]> => {
    const cursor = after
      ? sql`AND (l.target_id, l.actor_id, l.id) > (${after.targetId}::bigint, ${after.actorId}::bigint, ${after.likeId}::bigint)`
      : sql``;
    const rows = await many<{ target_id: string; actor_id: string; id: string; kind: number; matched: boolean }>(
      db,
      sql`SELECT l.target_id::text AS target_id, l.actor_id::text AS actor_id, l.id::text AS id, l.kind,
                 EXISTS (SELECT 1 FROM matches m
                          WHERE m.user_lo = least(l.target_id, l.actor_id) AND m.user_hi = greatest(l.target_id, l.actor_id)) AS matched
            FROM likes l
           WHERE l.id >= id_floor(now() - make_interval(days => ${windowDays}::integer))
             ${cursor}
           ORDER BY l.target_id, l.actor_id, l.id
           LIMIT ${limit}::integer`,
    );
    return rows.map((r) => ({ targetId: r.target_id, actorId: r.actor_id, likeId: r.id, kind: r.kind, matched: r.matched }));
  },
);
