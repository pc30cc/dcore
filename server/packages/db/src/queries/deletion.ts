import { z } from 'zod';
import { many, maybeOne, one, sql, type Queryable, type SqlFragment } from '../query.js';
import { defineQuery } from './define.js';

/**
 * Account deletion, restore and purge (users, sessions, matches,
 * message_requests; the purge itself is `account_purge()`, migration 0012).
 *
 * A deletion sets status 7 at once, remembering the status to restore
 * (`restore_status`), revokes every session (reason 6), ends every active
 * conversation (matches state 4, ended by the system) and withdraws the
 * person's pending message requests; the users trigger removes the
 * discovery row. It is one statement (data-modifying WITH), so it is
 * atomic without an explicit transaction. Asking again for an account that
 * is already deleted changes nothing and answers the same purge time.
 *
 * Times leave as epoch milliseconds; ids as decimal strings.
 */

const id = z.string().regex(/^[1-9][0-9]{0,18}$/);
const epochMs = z.coerce.number().int().nonnegative();

/** sessions.revoke_reason 6 (account_deleted); matches.state 4 and ended_by 3 (system). */
const REVOKE_DELETED = 6;
const MATCH_ACCOUNT_GONE = 4;
const ENDED_BY_SYSTEM = 3;
/** message_requests.status 1 pending, 5 withdrawn or the sender left. */
const REQUEST_PENDING = 1;
const REQUEST_WITHDRAWN = 5;

const msOf = (column: SqlFragment) => sql`floor(extract(epoch FROM ${column}) * 1000)::bigint`;

// ─── Preflight ─────────────────────────────────────────────────────────────

export interface RenewingSubscription {
  /** 1 google_play, 2 cafe_bazaar. */
  store: number;
  /** The store's product id, when the subscription came from a purchase row. */
  productId: string | null;
}

/**
 * A store subscription that renews by itself (status 1 active and renewing,
 * 3 grace), which deleting the account does not cancel: the session's own
 * store first. One read of `subscriptions` (its primary key starts with the
 * user).
 */
export const renewingSubscription = defineQuery(
  { name: 'deletion.renewingSubscription', statements: 1 },
  async (db, userId: string, sessionStore: number | null): Promise<RenewingSubscription | null> => {
    const row = await maybeOne<{ store: number; product_id: string | null }>(
      db,
      sql`SELECT s.store::integer AS store, p.product_id
            FROM subscriptions s
            LEFT JOIN store_purchases sp ON sp.id = s.purchase_id
            LEFT JOIN store_products p ON p.id = sp.product_ref
           WHERE s.user_id = ${userId}::bigint AND s.store IN (1, 2) AND s.status IN (1, 3) AND s.expires_at > now()
           ORDER BY (s.store = ${sessionStore}::smallint) DESC NULLS LAST, s.expires_at DESC
           LIMIT 1`,
    );
    return row ? { store: row.store, productId: row.product_id } : null;
  },
);

// ─── Deleting ──────────────────────────────────────────────────────────────

/** Which account: by its id (the app), or by a sign-in identity's keyed hashes (the web page). */
export type DeletionTarget = { userId: string } | { provider: 1 | 2; subjectHashes: readonly Buffer[] };

export interface EndedConversation {
  matchId: string;
  peerId: string;
}

export type DeletionOutcome =
  | {
      kind: 'deleted';
      userId: string;
      deletedAtMs: number;
      purgeAtMs: number;
      /** Sessions that were live and are revoked now. */
      sessionIds: string[];
      /** Conversations ended now, with the other person. */
      ended: EndedConversation[];
    }
  /** Deleted before (status 7): nothing changed; the same purge time. */
  | { kind: 'already'; userId: string; deletedAtMs: number; purgeAtMs: number }
  /** No such account, or already purged. */
  | { kind: 'none' };

const changedSchema = z.object({ id, deletedAtMs: epochMs, purgeAtMs: epochMs });
const endedSchema = z.array(z.object({ matchId: id, peerId: id }));

function targetOf(target: DeletionTarget): SqlFragment {
  if ('userId' in target) return sql`SELECT ${target.userId}::bigint AS id`;
  return sql`SELECT ai.user_id AS id
               FROM auth_identities ai JOIN users u ON u.id = ai.user_id
              WHERE ai.provider = ${target.provider} AND ai.subject_hash = ANY(${target.subjectHashes}::bytea[]) AND u.status <> 8
              ORDER BY ai.id
              LIMIT 1`;
}

/**
 * Deletes an account (status 7, `deleted_via` 1 app, 2 web page, 3 admin):
 * one statement; a second (a read) only when nothing changed, to tell an
 * account deleted before from none. A concurrent second deletion waits for
 * the first's row lock and then finds it deleted.
 */
export const deleteAccount = defineQuery(
  { name: 'deletion.deleteAccount', statements: 2 },
  async (db, target: DeletionTarget, via: 1 | 2 | 3): Promise<DeletionOutcome> => {
    const row = await one<{ target_id: string | null; changed: unknown; sessions: string[]; ended: unknown }>(
      db,
      sql`WITH target AS (${targetOf(target)}),
          changed AS (
            UPDATE users u
               SET status = 7, deleted_at = now(), deleted_via = ${via}, restore_status = u.status
              FROM target t
             WHERE u.id = t.id AND u.status BETWEEN 1 AND 6
            RETURNING u.id, u.deleted_at
          ),
          revoked AS (
            UPDATE sessions s SET revoked_at = now(), revoke_reason = ${REVOKE_DELETED}
              FROM changed c
             WHERE s.user_id = c.id AND s.revoked_at IS NULL
            RETURNING s.id
          ),
          mine AS (
            SELECT m.id FROM matches m JOIN changed c ON m.user_lo = c.id WHERE m.state = 1
            UNION ALL
            SELECT m.id FROM matches m JOIN changed c ON m.user_hi = c.id WHERE m.state = 1
          ),
          ended AS (
            UPDATE matches m SET state = ${MATCH_ACCOUNT_GONE}, ended_at = now(), ended_by = ${ENDED_BY_SYSTEM}
              FROM mine
             WHERE m.id = mine.id AND m.state = 1
            RETURNING m.id, m.user_lo, m.user_hi
          ),
          withdrawn AS (
            UPDATE message_requests r SET status = ${REQUEST_WITHDRAWN}, decided_at = now()
              FROM changed c
             WHERE r.from_id = c.id AND r.status = ${REQUEST_PENDING}
            RETURNING r.id
          )
          SELECT (SELECT t.id::text FROM target t) AS target_id,
                 (SELECT jsonb_build_object('id', c.id::text, 'deletedAtMs', ${msOf(sql`c.deleted_at`)},
                                            'purgeAtMs', ${msOf(sql`account_purge_at(c.deleted_at)`)})
                    FROM changed c) AS changed,
                 ARRAY(SELECT r.id::text FROM revoked r) AS sessions,
                 coalesce((SELECT jsonb_agg(jsonb_build_object(
                                    'matchId', e.id::text,
                                    'peerId', (CASE WHEN e.user_lo = c.id THEN e.user_hi ELSE e.user_lo END)::text))
                             FROM ended e, changed c), '[]'::jsonb) AS ended,
                 ARRAY(SELECT w.id::text FROM withdrawn w) AS withdrawn`,
    );
    if (row.changed !== null) {
      const changed = changedSchema.parse(row.changed);
      return {
        kind: 'deleted',
        userId: changed.id,
        deletedAtMs: changed.deletedAtMs,
        purgeAtMs: changed.purgeAtMs,
        sessionIds: row.sessions,
        ended: endedSchema.parse(row.ended),
      };
    }
    if (row.target_id === null) return { kind: 'none' };
    // Nothing changed: deleted before (or by a concurrent request), purged, or no such row.
    const state = await maybeOne<{ status: number; deleted_ms: string | null; purge_ms: string | null }>(
      db,
      sql`SELECT status::integer AS status, ${msOf(sql`deleted_at`)}::text AS deleted_ms,
                 ${msOf(sql`account_purge_at(deleted_at)`)}::text AS purge_ms
            FROM users WHERE id = ${row.target_id}::bigint`,
    );
    if (state?.status === 7 && state.deleted_ms !== null && state.purge_ms !== null) {
      return { kind: 'already', userId: row.target_id, deletedAtMs: Number(state.deleted_ms), purgeAtMs: Number(state.purge_ms) };
    }
    return { kind: 'none' };
  },
);

/**
 * The account a sign-in identity belongs to, unless purged: the web page's
 * check before it sends a code. One read.
 */
export const deletionAccountOf = defineQuery(
  { name: 'deletion.accountOf', statements: 1 },
  async (db, provider: 1 | 2, subjectHashes: readonly Buffer[]): Promise<{ userId: string; status: number } | null> => {
    const row = await maybeOne<{ id: string; status: number }>(
      db,
      sql`SELECT u.id::text AS id, u.status::integer AS status
            FROM auth_identities ai JOIN users u ON u.id = ai.user_id
           WHERE ai.provider = ${provider} AND ai.subject_hash = ANY(${subjectHashes}::bytea[]) AND u.status <> 8
           ORDER BY ai.id
           LIMIT 1`,
    );
    return row ? { userId: row.id, status: row.status } : null;
  },
);

// ─── Restoring ─────────────────────────────────────────────────────────────

export type RestoreOutcome =
  /** Restored now, to this status. */
  | { kind: 'restored'; status: number; onboardingStep: number }
  /** Not deleted (restored before): its state as it is. */
  | { kind: 'not_deleted'; status: number; onboardingStep: number }
  /** Still deleted, but the grace is over: the purge comes. */
  | { kind: 'expired'; purgeAtMs: number }
  /** Purged, or no such account. */
  | { kind: 'gone' };

/**
 * Restores a deleted account before its purge time: one statement (a read
 * follows only when nothing changed). The status is the one it had when it
 * was deleted, except that a ban or suspension in effect now wins, a
 * penalty that ended meanwhile gives an active account, and an account
 * without its basics (birth date, gender) goes back to onboarding.
 * Sessions stay revoked; the restore session signs in again by refreshing.
 */
export const restoreAccount = defineQuery(
  { name: 'deletion.restoreAccount', statements: 2 },
  async (db, userId: string): Promise<RestoreOutcome> => {
    const restored = await maybeOne<{ status: number; onboarding_step: number }>(
      db,
      sql`UPDATE users u
             SET status = CASE
                   WHEN u.birth_date IS NULL OR u.gender IS NULL THEN 1
                   WHEN EXISTS (SELECT 1 FROM moderation_actions a
                                 WHERE a.user_id = u.id AND a.kind = 3 AND a.revoked_at IS NULL
                                   AND a.starts_at <= now() AND (a.ends_at IS NULL OR a.ends_at > now())) THEN 6
                   WHEN EXISTS (SELECT 1 FROM moderation_actions a
                                 WHERE a.user_id = u.id AND a.kind = 2 AND a.revoked_at IS NULL
                                   AND a.starts_at <= now() AND a.ends_at > now()) THEN 5
                   WHEN u.restore_status BETWEEN 1 AND 4 THEN u.restore_status
                   ELSE 3
                 END,
                 deleted_at = NULL, deleted_via = NULL, restore_status = NULL
           WHERE u.id = ${userId}::bigint AND u.status = 7 AND account_purge_at(u.deleted_at) > now()
          RETURNING u.status::integer AS status, u.onboarding_step::integer AS onboarding_step`,
    );
    if (restored) return { kind: 'restored', status: restored.status, onboardingStep: restored.onboarding_step };
    const state = await maybeOne<{ status: number; onboarding_step: number; purge_ms: string | null }>(
      db,
      sql`SELECT status::integer AS status, onboarding_step::integer AS onboarding_step,
                 ${msOf(sql`account_purge_at(deleted_at)`)}::text AS purge_ms
            FROM users WHERE id = ${userId}::bigint`,
    );
    if (!state || state.status === 8) return { kind: 'gone' };
    if (state.status === 7) return { kind: 'expired', purgeAtMs: Number(state.purge_ms) };
    return { kind: 'not_deleted', status: state.status, onboardingStep: state.onboarding_step };
  },
);

// ─── The worker's side ─────────────────────────────────────────────────────

export interface FanoutTarget {
  status: number;
  /** The profile's card version (`card:<uid>:<ver>:<catv>`), when there is a profile. */
  profileVersion: number | null;
  /** Conversations the deletion at `deletedAtMs` ended, with the other person. */
  ended: EndedConversation[];
}

/**
 * What the deletion fan-out needs: the account's status and card version,
 * and the conversations its deletion at `deletedAtMs` ended (matches state
 * 4 ended at or after that time; the deletion sets ended_at to its own
 * time). One read.
 */
export const deletionFanoutTarget = defineQuery(
  { name: 'deletion.fanoutTarget', statements: 1 },
  async (db, userId: string, deletedAtMs: number): Promise<FanoutTarget | null> => {
    const at = sql`to_timestamp(${deletedAtMs}::double precision / 1000)`;
    const row = await maybeOne<{ status: number; profile_ver: number | null; ended: unknown }>(
      db,
      sql`SELECT u.status::integer AS status,
                 (SELECT p.version FROM profiles p WHERE p.user_id = u.id) AS profile_ver,
                 coalesce((SELECT jsonb_agg(jsonb_build_object('matchId', x.id::text, 'peerId', x.peer::text) ORDER BY x.id)
                             FROM (SELECT m.id, m.user_hi AS peer FROM matches m
                                    WHERE m.user_lo = u.id AND m.state = ${MATCH_ACCOUNT_GONE} AND m.ended_at >= ${at}
                                   UNION ALL
                                   SELECT m.id, m.user_lo FROM matches m
                                    WHERE m.user_hi = u.id AND m.state = ${MATCH_ACCOUNT_GONE} AND m.ended_at >= ${at}) x),
                          '[]'::jsonb) AS ended
            FROM users u WHERE u.id = ${userId}::bigint`,
    );
    if (!row) return null;
    return { status: row.status, profileVersion: row.profile_ver, ended: endedSchema.parse(row.ended) };
  },
);

export interface SweepRow {
  userId: string;
  deletedAtMs: number;
  purgeAtMs: number;
  /** The purge time has passed. */
  due: boolean;
}

/**
 * Deleted accounts the periodic sweep looks at: those whose purge time has
 * passed by `nowMs` (a purge job that was lost is made again) and those
 * deleted since `recentSinceMs` (a fan-out that could not be queued is
 * queued again). Uses the partial index on deleted_at of status 7. One read.
 */
export const deletionSweep = defineQuery(
  { name: 'deletion.sweep', statements: 1 },
  async (db, input: { nowMs: number; recentSinceMs: number; limit: number }): Promise<SweepRow[]> => {
    const now = sql`to_timestamp(${input.nowMs}::double precision / 1000)`;
    const rows = await many<{ id: string; deleted_ms: string; purge_ms: string; due: boolean }>(
      db,
      sql`SELECT u.id::text AS id, ${msOf(sql`u.deleted_at`)}::text AS deleted_ms,
                 ${msOf(sql`account_purge_at(u.deleted_at)`)}::text AS purge_ms,
                 account_purge_at(u.deleted_at) <= ${now} AS due
            FROM users u
           WHERE u.status = 7
             AND (u.deleted_at <= ${now} - (account_purge_at(${now}) - ${now})
                  OR u.deleted_at >= to_timestamp(${input.recentSinceMs}::double precision / 1000))
           ORDER BY u.deleted_at
           LIMIT ${input.limit}`,
    );
    return rows.map((r) => ({ userId: r.id, deletedAtMs: Number(r.deleted_ms), purgeAtMs: Number(r.purge_ms), due: r.due }));
  },
);

const purgeSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('purged'),
    purgeAtMs: epochMs,
    matchIds: z.array(id),
    heldMatchIds: z.array(id),
    deviceIds: z.array(id),
    sessionIds: z.array(id),
    photos: z.array(z.object({ id, blobVer: z.number().int().positive() })),
  }),
  z.object({ outcome: z.literal('not_due'), purgeAtMs: epochMs }),
  z.object({ outcome: z.literal('held'), purgeAtMs: epochMs }),
  z.object({ outcome: z.literal('not_deleted') }),
  z.object({ outcome: z.literal('missing') }),
]);
export type PurgeOutcome = z.infer<typeof purgeSchema>;

/**
 * The purge of a deleted account whose grace is over (`account_purge()`):
 * one statement. `nowMs` is the time the purge is due against (the worker's
 * clock); null uses the database's.
 */
export const purgeAccount = defineQuery(
  { name: 'deletion.purge', statements: 1 },
  async (db: Queryable, userId: string, nowMs: number | null): Promise<PurgeOutcome> => {
    const row = await one<{ result: unknown }>(
      db,
      nowMs === null
        ? sql`SELECT account_purge(${userId}::bigint) AS result`
        : sql`SELECT account_purge(${userId}::bigint, to_timestamp(${nowMs}::double precision / 1000)) AS result`,
    );
    return purgeSchema.parse(row.result);
  },
);

/** After their blobs are gone: a purged account's photo rows. One statement; returns the rows deleted. */
export const purgePhotos = defineQuery(
  { name: 'deletion.purgePhotos', statements: 1 },
  async (db, userId: string, photoIds: readonly string[]): Promise<number> => {
    const row = await one<{ n: number }>(db, sql`SELECT account_purge_photos(${userId}::bigint, ${photoIds}::bigint[]) AS n`);
    return row.n;
  },
);
