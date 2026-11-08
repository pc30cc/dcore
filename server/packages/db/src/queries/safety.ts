import { z } from 'zod';
import { execute, many, one, sql } from '../query.js';
import { defineQuery } from './define.js';

/**
 * Blocks, reports and the moderation actions the server applies, one
 * statement each (the functions of migration 0016). Each write answers what
 * its caller's Valkey and realtime side needs: the conversations that
 * ended, the peers whose lists change, the account's state before and
 * after. The block list reads the people this account blocked (a block made
 * by the other side is never listed), keyset-paged by when it was made.
 */

const id = z.string().regex(/^[1-9][0-9]{0,18}$/);
const epochMs = z.number().int().nonnegative();

// ─── Blocks ──────────────────────────────────────────────────────────────

export const pairMatchSchema = z.object({ matchId: id, lo: id, hi: id, state: z.number().int().min(1).max(5) });
export type PairMatch = z.infer<typeof pairMatchSchema>;

const blockOutcomeSchema = z.union([
  z.object({ found: z.literal(false) }),
  z.object({
    found: z.literal(true),
    /** The actor had blocked the target before. */
    already: z.boolean(),
    /** This block ended the pair's conversation. */
    endedNow: z.boolean(),
    /** The pair's match, in any state (null: they never matched). */
    match: pairMatchSchema.nullable(),
  }),
]);
export type BlockOutcome = z.infer<typeof blockOutcomeSchema>;

/** `actorId` blocks `targetId`; the pair's active match ends (state 3). The answer names the pair's match in any state. */
export const blockUser = defineQuery({ name: 'safety.block', statements: 1 }, async (db, actorId: string, targetId: string): Promise<BlockOutcome> => {
  const row = await one<{ out: unknown }>(db, sql`SELECT block_apply(${actorId}::bigint, ${targetId}::bigint) AS out`);
  return blockOutcomeSchema.parse(row.out);
});

export interface UnblockOutcome {
  /** The actor's block was lifted. */
  changed: boolean;
  /** No side blocks the other after this call (no row left: lifted now, or before). */
  cleared: boolean;
}

/**
 * `actorId` lifts their block of `targetId`: their bit leaves the pair's row
 * (the row goes when no side blocks any more). A pair that had matched stays
 * apart through its match row. Says whether something changed and whether
 * the pair is free of blocks now.
 */
export const unblockPair = defineQuery({ name: 'safety.unblockPair', statements: 1 }, async (db, actorId: string, targetId: string): Promise<UnblockOutcome> => {
  if (actorId === targetId) return { changed: false, cleared: false };
  const row = await one<{ changed: boolean; cleared: boolean }>(
    db,
    sql`WITH pair AS (
          SELECT least(${actorId}::bigint, ${targetId}::bigint) AS lo, greatest(${actorId}::bigint, ${targetId}::bigint) AS hi,
                 (CASE WHEN ${actorId}::bigint < ${targetId}::bigint THEN 1 ELSE 2 END)::smallint AS bit
        ), gone AS (
          DELETE FROM blocks b USING pair p
           WHERE b.user_lo = p.lo AND b.user_hi = p.hi AND b.blocked_by = p.bit
          RETURNING 1
        ), kept AS (
          UPDATE blocks b SET blocked_by = b.blocked_by & ~p.bit
            FROM pair p
           WHERE b.user_lo = p.lo AND b.user_hi = p.hi AND b.blocked_by = 3
          RETURNING 1
        )
        SELECT EXISTS (SELECT 1 FROM gone) OR EXISTS (SELECT 1 FROM kept) AS changed,
               -- The statement's own DELETE is not visible here: a row seen and not deleted is a block that stays.
               EXISTS (SELECT 1 FROM gone)
                 OR NOT EXISTS (SELECT 1 FROM blocks b, pair p WHERE b.user_lo = p.lo AND b.user_hi = p.hi) AS cleared`,
  );
  return { changed: row.changed === true, cleared: row.cleared === true };
});

/** {@link unblockPair}, answering only whether something changed. */
export const unblockUser = defineQuery(
  { name: 'safety.unblock', statements: 1 },
  async (db, actorId: string, targetId: string): Promise<boolean> => (await unblockPair(db, actorId, targetId)).changed,
);

export interface BlockedPerson {
  userId: string;
  /** When this account blocked them, in microseconds since the epoch (text: the cursor's key). */
  atUs: string;
  name: string;
  verified: boolean;
  photo: { id: string; w: number; h: number; blurhash: string; blobVer: number } | null;
}

/**
 * The people `viewerId` blocked, newest block first, after the keyset
 * cursor (`atUs`, `userId`) when given; `limit + 1` rows so the caller knows
 * whether there is more. Deleted and purged accounts are left out; every
 * other state is listed as it is (leaving out a shadowbanned or banned
 * person would tell the viewer about it).
 */
export const blockedPeople = defineQuery(
  { name: 'safety.blockedPeople', statements: 1 },
  async (db, viewerId: string, limit: number, after?: { atUs: string; userId: string }): Promise<BlockedPerson[]> => {
    const rows = await many<{
      peer: string;
      at_us: string;
      name: string;
      verified: boolean;
      photo_id: string | null;
      width: number | null;
      height: number | null;
      blurhash: string | null;
      blob_ver: number | null;
    }>(
      db,
      sql`WITH mine AS (
            SELECT b.user_hi AS peer, (extract(epoch FROM b.lo_at) * 1000000)::bigint AS at_us
              FROM blocks b WHERE b.user_lo = ${viewerId}::bigint AND (b.blocked_by & 1) <> 0
            UNION ALL
            SELECT b.user_lo, (extract(epoch FROM b.hi_at) * 1000000)::bigint
              FROM blocks b WHERE b.user_hi = ${viewerId}::bigint AND (b.blocked_by & 2) <> 0
          )
          SELECT x.peer::text AS peer, x.at_us::text AS at_us, p.display_name AS name, u.is_verified AS verified,
                 ph.id::text AS photo_id, ph.width, ph.height, ph.blurhash, ph.blob_ver
            FROM mine x
            JOIN users u ON u.id = x.peer AND u.status BETWEEN 1 AND 6
            JOIN profiles p ON p.user_id = x.peer
            LEFT JOIN LATERAL (
              SELECT f.id, f.width, f.height, f.blurhash, f.blob_ver FROM photos f
               WHERE f.user_id = x.peer AND f.status = 3 ORDER BY f.position LIMIT 1
            ) ph ON true
           WHERE ${after?.atUs ?? null}::bigint IS NULL
              OR (x.at_us, x.peer) < (${after?.atUs ?? null}::bigint, ${after?.userId ?? null}::bigint)
           ORDER BY x.at_us DESC, x.peer DESC
           LIMIT ${limit + 1}`,
    );
    return rows.map((r) => ({
      userId: r.peer,
      atUs: r.at_us,
      name: r.name,
      verified: r.verified === true,
      photo:
        r.photo_id !== null && r.width !== null && r.height !== null && r.blob_ver !== null
          ? { id: r.photo_id, w: Number(r.width), h: Number(r.height), blurhash: r.blurhash ?? '', blobVer: Number(r.blob_ver) }
          : null,
    }));
  },
);

// ─── Reports ─────────────────────────────────────────────────────────────

export interface ReportInput {
  reportId: string;
  reporterId: string;
  targetId: string;
  /** reports.context: 1 profile, 2 chat, 3 photo, 4 call. */
  context: number;
  /** reports.reason (1-8, 99). */
  reason: number;
  details?: string | undefined;
  conversationId?: string | undefined;
  messageIds?: readonly string[] | undefined;
  photoId?: string | undefined;
  callId?: string | undefined;
  block?: boolean | undefined;
}

const reportOutcomeSchema = z.union([
  z.object({ outcome: z.literal('not_found') }),
  z.object({
    outcome: z.literal('filed'),
    reportId: id,
    merged: z.boolean(),
    block: blockOutcomeSchema.nullable().optional(),
    holds: z.number().int().nonnegative(),
  }),
]);
export type ReportOutcome = z.infer<typeof reportOutcomeSchema>;

/** A report, its priorities, the optional block and a child-safety hold, in one statement. */
export const fileReport = defineQuery({ name: 'safety.fileReport', statements: 1 }, async (db, r: ReportInput): Promise<ReportOutcome> => {
  const row = await one<{ out: unknown }>(
    db,
    sql`SELECT report_file(${r.reportId}::bigint, ${r.reporterId}::bigint, ${r.targetId}::bigint, ${r.context}::smallint,
                           ${r.reason}::smallint, ${r.details ?? null}::text, ${r.conversationId ?? null}::bigint,
                           ${r.messageIds ? [...r.messageIds] : null}::bigint[], ${r.photoId ?? null}::bigint,
                           ${r.callId ?? null}::bigint, ${r.block === true}::boolean) AS out`,
  );
  return reportOutcomeSchema.parse(row.out);
});

// ─── Moderation actions ──────────────────────────────────────────────────

const stateSchema = z.object({ status: z.number().int().min(1).max(8), shadowbanned: z.boolean() });
export type AccountVisibilityState = z.infer<typeof stateSchema>;

/** What the person reads of an action (never a shadowban), times in ms. */
export const actionViewSchema = z.object({
  id,
  kind: z.number().int().min(1).max(3),
  reasonText: z.string(),
  startsAtMs: epochMs,
  endsAtMs: epochMs.optional(),
  appeal: z.object({ id, status: z.number().int().min(1).max(3), decisionText: z.string().optional() }).optional(),
});
export type ActionView = z.infer<typeof actionViewSchema>;

const endedSchema = z.array(z.object({ matchId: id, lo: id, hi: id, peerId: id }));

/** The effect of a moderation write on an account, as the Valkey and realtime side needs it. */
export const moderationEffectSchema = z.object({
  userId: id,
  before: stateSchema,
  after: stateSchema,
  /** Conversations that ended (a ban). */
  ended: endedSchema,
  /** Peers in the account's active conversations (their lists change when it leaves or comes back). */
  peers: z.array(id),
  /** The action as the person sees it (absent for a shadowban). */
  action: actionViewSchema.nullable().optional(),
});
export type ModerationEffect = z.infer<typeof moderationEffectSchema>;

export interface ModerationInput {
  actionId: string;
  userId: string;
  /** 1 warning, 2 suspension (endsAt required), 3 ban, 4 shadowban. */
  kind: 1 | 2 | 3 | 4;
  /** moderation_actions.reason_code (1-99). */
  reasonCode: number;
  /** Shown to the person, in their language (1-1000 characters). */
  reasonText: string;
  endsAt?: Date | undefined;
  /** admin_users.id; absent for an automatic rule. */
  adminId?: number | undefined;
  reportId?: string | undefined;
  /** Internal note (never shown). */
  note?: string | undefined;
}

const applySchema = z.union([
  z.object({ outcome: z.literal('missing') }),
  moderationEffectSchema.extend({ outcome: z.literal('applied'), actionId: id, kind: z.number().int().min(1).max(4) }),
]);
export type ModerationApplyOutcome = z.infer<typeof applySchema>;

/** Applies a warning, suspension, ban or shadowban (one statement). */
export const applyModeration = defineQuery({ name: 'safety.applyModeration', statements: 1 }, async (db, m: ModerationInput): Promise<ModerationApplyOutcome> => {
  const row = await one<{ out: unknown }>(
    db,
    sql`SELECT moderation_apply(${m.actionId}::bigint, ${m.userId}::bigint, ${m.kind}::smallint, ${m.reasonCode}::smallint,
                                ${m.reasonText}::text, ${m.endsAt ? m.endsAt.toISOString() : null}::timestamptz,
                                ${m.adminId ?? null}::integer, ${m.reportId ?? null}::bigint, ${m.note ?? null}::text) AS out`,
  );
  return applySchema.parse(row.out);
});

const revokeSchema = z.union([
  z.object({ outcome: z.literal('missing') }),
  moderationEffectSchema.extend({ outcome: z.literal('revoked'), already: z.boolean(), actionId: id, kind: z.number().int().min(1).max(4) }),
]);
export type ModerationRevokeOutcome = z.infer<typeof revokeSchema>;

/** Lifts an action before its end; `liftId` is the id of its lift record (kind 5). */
export const revokeModeration = defineQuery(
  { name: 'safety.revokeModeration', statements: 1 },
  async (db, actionId: string, liftId: string, options: { adminId?: number | undefined; reasonText?: string | undefined } = {}): Promise<ModerationRevokeOutcome> => {
    const row = await one<{ out: unknown }>(
      db,
      sql`SELECT moderation_revoke(${actionId}::bigint, ${options.adminId ?? null}::integer, ${liftId}::bigint, ${options.reasonText ?? null}::text) AS out`,
    );
    return revokeSchema.parse(row.out);
  },
);

const settleSchema = z.union([z.object({ outcome: z.literal('missing') }), moderationEffectSchema.extend({ outcome: z.literal('settled') })]);
export type ModerationSettleOutcome = z.infer<typeof settleSchema>;

/** Puts an account in line with the actions that stand now (a period that ended). */
export const settleModeration = defineQuery({ name: 'safety.settleModeration', statements: 1 }, async (db, userId: string): Promise<ModerationSettleOutcome> => {
  const row = await one<{ out: unknown }>(db, sql`SELECT moderation_settle(${userId}::bigint) AS out`);
  return settleSchema.parse(row.out);
});

const decisionSchema = z.union([
  z.object({ outcome: z.enum(['missing', 'decided']) }),
  moderationEffectSchema.extend({ outcome: z.literal('overturned'), appealId: id, actionId: id }),
  z.object({ outcome: z.literal('upheld'), appealId: id, actionId: id, userId: id, action: actionViewSchema.nullable().optional() }),
]);
export type AppealDecision = z.infer<typeof decisionSchema>;

/** Decides an open appeal; an overturn lifts the action in the same transaction. */
export const decideAppeal = defineQuery(
  { name: 'safety.decideAppeal', statements: 1 },
  async (db, appealId: string, overturn: boolean, liftId: string, options: { adminId?: number | undefined; text?: string | undefined } = {}): Promise<AppealDecision> => {
    const row = await one<{ out: unknown }>(
      db,
      sql`SELECT appeal_decide(${appealId}::bigint, ${options.adminId ?? null}::integer, ${overturn}::boolean,
                               ${options.text ?? null}::text, ${liftId}::bigint) AS out`,
    );
    return decisionSchema.parse(row.out);
  },
);

export interface DueAction {
  actionId: string;
  userId: string;
  endsAtMs: number;
}

/**
 * Suspensions, timed bans and shadowbans whose period ended in the last
 * week while their account still carries a penalty (a lost end job): the
 * sweep settles them. Served by the partial index of 0016.
 */
export const dueModeration = defineQuery({ name: 'safety.dueModeration', statements: 1 }, async (db, limit: number): Promise<DueAction[]> => {
  const rows = await many<{ id: string; user_id: string; ends_ms: string }>(
    db,
    sql`SELECT a.id::text AS id, a.user_id::text AS user_id, floor(extract(epoch FROM a.ends_at) * 1000)::bigint::text AS ends_ms
          FROM moderation_actions a
          JOIN users u ON u.id = a.user_id
         WHERE a.kind IN (2, 3, 4) AND a.revoked_at IS NULL AND a.ends_at IS NOT NULL
           AND a.ends_at <= now() AND a.ends_at > now() - interval '7 days'
           AND (u.status IN (5, 6) OR u.is_shadowbanned)
         ORDER BY a.ends_at
         LIMIT ${limit}`,
  );
  return rows.map((r) => ({ actionId: r.id, userId: r.user_id, endsAtMs: Number(r.ends_ms) }));
});

/** Moves a report's status (tests and the panel's later routes); 1 when it changed. */
export const setReportStatus = defineQuery(
  { name: 'safety.setReportStatus', statements: 1 },
  async (db, reportId: string, status: 1 | 2 | 3 | 4 | 5): Promise<number> =>
    execute(
      db,
      sql`UPDATE reports SET status = ${status}::smallint,
                             resolved_at = CASE WHEN ${status}::smallint IN (3, 4, 5) THEN coalesce(resolved_at, now()) END
           WHERE id = ${reportId}::bigint AND status IS DISTINCT FROM ${status}::smallint`,
    ),
);
