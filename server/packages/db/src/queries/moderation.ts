import { z } from 'zod';
import { many, one, sql } from '../query.js';
import { defineQuery } from './define.js';

/**
 * What a person sees of the moderation of their own account: warnings,
 * suspensions and bans (never a shadowban or an internal action), with the
 * reason written for them and the latest appeal of each; and the appeal
 * they file against one.
 */

const id = z.string().regex(/^[1-9][0-9]{0,18}$/);
const epochMs = z.number().int().nonnegative();

export const ownActionSchema = z.object({
  id,
  kind: z.number().int().min(1).max(3),
  reasonText: z.string(),
  startsAtMs: epochMs,
  endsAtMs: epochMs.nullable(),
  revoked: z.boolean(),
  active: z.boolean(),
  appeal: z.object({ id, status: z.number().int().min(1).max(3), decisionText: z.string().nullable() }).nullable(),
});
export type OwnAction = z.infer<typeof ownActionSchema>;

/** The newest 50 visible actions; `active` = a suspension or ban in effect now. */
export const ownModeration = defineQuery({ name: 'moderation.own', statements: 1 }, async (db, userId: string) => {
  const rows = await many<Record<string, unknown>>(
    db,
    sql`
SELECT m.id::text AS id, m.kind, m.reason_text AS "reasonText",
       floor(extract(epoch FROM m.starts_at) * 1000)::bigint AS "startsAtMs",
       floor(extract(epoch FROM m.ends_at) * 1000)::bigint AS "endsAtMs",
       m.revoked_at IS NOT NULL AS revoked,
       (m.kind IN (2, 3) AND m.revoked_at IS NULL AND m.starts_at <= now() AND (m.ends_at IS NULL OR m.ends_at > now())) AS active,
       a.appeal
  FROM moderation_actions m
  LEFT JOIN LATERAL (
    SELECT jsonb_build_object('id', ap.id::text, 'status', ap.status, 'decisionText', ap.decision_text) AS appeal
      FROM appeals ap WHERE ap.action_id = m.id
     ORDER BY ap.id DESC LIMIT 1) a ON true
 WHERE m.user_id = ${userId}::bigint AND m.kind IN (1, 2, 3)
 ORDER BY m.id DESC
 LIMIT 50`,
  );
  return rows.map((r) =>
    ownActionSchema.parse({ ...r, startsAtMs: Number(r['startsAtMs']), endsAtMs: r['endsAtMs'] === null ? null : Number(r['endsAtMs']) }),
  );
});

export type AppealOutcome =
  | { kind: 'filed'; appealId: string }
  | { kind: 'not_found' }
  | { kind: 'open' }
  | { kind: 'not_appealable' };

/**
 * Files an appeal against one of the person's own warnings, suspensions or
 * bans: only while the action stands (not revoked, not over) and only once
 * per action (an open appeal answers `open`, a decided one
 * `not_appealable`). One statement.
 */
export const fileAppeal = defineQuery(
  { name: 'moderation.fileAppeal', statements: 1 },
  async (db, userId: string, actionId: string, appealId: string, body: string): Promise<AppealOutcome> => {
    const row = await one<{ found: boolean; standing: boolean; open: boolean; decided: boolean; filed: string | null }>(
      db,
      sql`
WITH a AS (
  SELECT m.id,
         (m.revoked_at IS NULL AND (m.ends_at IS NULL OR m.ends_at > now())) AS standing,
         EXISTS (SELECT 1 FROM appeals x WHERE x.action_id = m.id AND x.status = 1) AS open,
         EXISTS (SELECT 1 FROM appeals x WHERE x.action_id = m.id AND x.status <> 1) AS decided
    FROM moderation_actions m
   WHERE m.id = ${actionId}::bigint AND m.user_id = ${userId}::bigint AND m.kind IN (1, 2, 3)
), ins AS (
  INSERT INTO appeals (id, user_id, action_id, body)
  SELECT ${appealId}::bigint, ${userId}::bigint, a.id, ${body}::text FROM a
   WHERE a.standing AND NOT a.open AND NOT a.decided
  ON CONFLICT (action_id) WHERE status = 1 DO NOTHING
  RETURNING id
)
SELECT EXISTS (SELECT 1 FROM a) AS found,
       coalesce((SELECT a.standing FROM a), false) AS standing,
       coalesce((SELECT a.open FROM a), false) AS open,
       coalesce((SELECT a.decided FROM a), false) AS decided,
       (SELECT ins.id::text FROM ins) AS filed`,
    );
    if (!row.found) return { kind: 'not_found' };
    if (row.filed !== null) return { kind: 'filed', appealId: row.filed };
    if (row.open) return { kind: 'open' };
    // A concurrent filing won the partial unique index between the check and the insert.
    if (row.standing && !row.decided) return { kind: 'open' };
    return { kind: 'not_appealable' };
  },
);
