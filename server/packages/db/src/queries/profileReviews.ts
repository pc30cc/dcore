import { z } from 'zod';
import { execute, many, maybeOne, sql, type SqlFragment } from '../query.js';
import { adminIdText, adminRefRow, adminRefSql, msOf } from './adminShared.js';
import { adminUserRefRowSchema } from './adminUsers.js';
import { defineQuery } from './define.js';

/**
 * The new-profile review (0038 `profile_reviews`): the panel's queue per
 * state, oldest account first (profile_reviews_state_idx, which holds only
 * the rows on the queue: a suspended or banned account's row is not read
 * past), the locked read
 * every decision starts with, the decisions, and the person's resubmission.
 */

const id = adminIdText;

const reviewItemRow = z.object({
  user: adminUserRefRowSchema.extend({
    age: z.number().int().nullable(),
    gender: z.number().int().nullable(),
    country: z.string().nullable(),
    verified: z.boolean(),
  }),
  locale: z.string(),
  signedUpAtMs: z.number().int(),
  state: z.number().int().min(1).max(3),
  submittedAtMs: z.number().int(),
  rounds: z.number().int(),
  about: z.string().nullable(),
  job: z.string().nullable(),
  prompts: z.array(
    z.object({ position: z.number().int(), promptId: z.number().int(), answer: z.string().nullable(), status: z.number().int(), rejectReason: z.number().int().nullable() }),
  ),
  photos: z.array(z.object({ id, position: z.number().int(), status: z.number().int().min(1).max(4), blobVer: z.number().int().positive() })),
  decision: z.object({ kind: z.number().int().min(2).max(3), reasonText: z.string(), decidedAtMs: z.number().int(), decidedBy: adminRefRow.nullable() }).nullable(),
});
export type ProfileReviewItemRow = z.infer<typeof reviewItemRow>;

/** The queue's statement (exported for the plan checks of the tests). */
export function profileReviewQueueStatement(options: { state: number; afterId?: string | null | undefined; limit: number }): SqlFragment {
  const after = options.afterId ? sql` AND r.user_id > ${options.afterId}::bigint` : sql``;
  return sql`SELECT jsonb_build_object(
      'user', admin_user_ref(u) || jsonb_build_object(
                'age', CASE WHEN u.birth_date IS NULL THEN NULL ELSE extract(year FROM age(u.birth_date))::integer END,
                'gender', u.gender, 'country', u.country, 'verified', u.is_verified),
      'locale', u.locale,
      'signedUpAtMs', ${msOf(sql`id_time(u.id)`)},
      'state', r.state,
      'submittedAtMs', ${msOf(sql`r.submitted_at`)},
      'rounds', r.rounds,
      'about', p.about,
      'job', p.job_title,
      'prompts', coalesce((SELECT jsonb_agg(jsonb_build_object('position', pp.position, 'promptId', pp.prompt_id, 'answer', pp.answer,
                                                               'status', pp.status, 'rejectReason', pp.reject_reason) ORDER BY pp.position)
                             FROM profile_prompts pp WHERE pp.user_id = u.id), '[]'::jsonb),
      'photos', coalesce((SELECT jsonb_agg(jsonb_build_object('id', ph.id::text, 'position', ph.position, 'status', ph.status, 'blobVer', ph.blob_ver)
                                           ORDER BY ph.position)
                            FROM photos ph WHERE ph.user_id = u.id), '[]'::jsonb),
      'decision', CASE WHEN r.decided_at IS NULL THEN NULL ELSE jsonb_build_object(
                    'kind', r.last_decision, 'reasonText', r.reason_text, 'decidedAtMs', ${msOf(sql`r.decided_at`)},
                    'decidedBy', ${adminRefSql(sql`r.decided_by`)}) END) AS item
    FROM profile_reviews r
    JOIN users u ON u.id = r.user_id
    LEFT JOIN profiles p ON p.user_id = r.user_id
   WHERE r.state = ${options.state}::smallint AND r.listed AND u.status = 2${after}
   ORDER BY r.user_id
   LIMIT ${options.limit}`;
}

/** Accounts waiting in one review state, oldest first; pass the page size + 1. */
export const profileReviewQueue = defineQuery(
  { name: 'profileReviews.queue', statements: 1 },
  async (db, options: { state: number; afterId?: string | null | undefined; limit: number }): Promise<ProfileReviewItemRow[]> => {
    const rows = await many<{ item: unknown }>(db, profileReviewQueueStatement(options));
    return rows.map((row) => reviewItemRow.parse(row.item));
  },
);

const lockedRow = z.object({
  status: z.number().int(),
  locale: z.string(),
  ref: adminUserRefRowSchema,
  state: z.number().int().nullable(),
  rounds: z.number().int().nullable(),
});
export type ProfileReviewLocked = z.infer<typeof lockedRow>;

/** The account and its review row, both locked (null: no account, or a purged one). */
export const profileReviewForUpdate = defineQuery({ name: 'profileReviews.forUpdate', statements: 1 }, async (tx, userId: string): Promise<ProfileReviewLocked | null> => {
  const row = await maybeOne<{ r: unknown }>(
    tx,
    sql`SELECT jsonb_build_object('status', u.status, 'locale', u.locale, 'ref', admin_user_ref(u), 'state', r.state, 'rounds', r.rounds) AS r
          FROM users u
          LEFT JOIN LATERAL (SELECT pr.state, pr.rounds FROM profile_reviews pr WHERE pr.user_id = u.id FOR UPDATE) r ON true
         WHERE u.id = ${userId}::bigint AND u.status <> 8
           FOR UPDATE OF u`,
  );
  return row ? lockedRow.parse(row.r) : null;
});

/** Approves: the account becomes active (the trigger removes the review row; discovery follows); true when it moved. */
export const profileReviewApprove = defineQuery({ name: 'profileReviews.approve', statements: 1 }, async (tx, userId: string): Promise<boolean> => {
  return (await execute(tx, sql`UPDATE users SET status = 3 WHERE id = ${userId}::bigint AND status = 2`)) === 1;
});

/** Sends the profile back (2) or rejects it (3), with the message the person reads; true when written. */
export const profileReviewDecide = defineQuery(
  { name: 'profileReviews.decide', statements: 1 },
  async (tx, input: { userId: string; state: 2 | 3; reasonText: string; adminId: number | null }): Promise<boolean> => {
    const written = await execute(
      tx,
      sql`INSERT INTO profile_reviews AS r (user_id, state, reason_text, decided_at, decided_by, last_decision, rounds)
          VALUES (${input.userId}::bigint, ${input.state}::smallint, ${input.reasonText}::text, now(), ${input.adminId}::integer, ${input.state}::smallint, 1)
          ON CONFLICT (user_id) DO UPDATE
             SET state = EXCLUDED.state, reason_text = EXCLUDED.reason_text, decided_at = now(),
                 decided_by = EXCLUDED.decided_by, last_decision = EXCLUDED.last_decision, rounds = r.rounds + 1`,
    );
    return written === 1;
  },
);

const resubmitRow = z.object({ state: z.number().int().nullable(), resubmitted: z.boolean(), status: z.number().int().nullable() });

/**
 * The person sends the profile again after changes: needs_changes (2)
 * becomes waiting (1), submitted now. Answers the state after the call
 * (null: no review row) and whether it moved.
 */
export const profileReviewResubmit = defineQuery({ name: 'profileReviews.resubmit', statements: 1 }, async (db, userId: string) => {
  const row = await maybeOne<{ r: unknown }>(
    db,
    sql`WITH upd AS (
          UPDATE profile_reviews r SET state = 1, submitted_at = now()
            FROM users u
           WHERE r.user_id = ${userId}::bigint AND u.id = r.user_id AND u.status = 2 AND r.state = 2
          RETURNING r.state)
        SELECT jsonb_build_object(
                 'state', coalesce((SELECT state FROM upd), (SELECT pr.state FROM profile_reviews pr WHERE pr.user_id = ${userId}::bigint)),
                 'resubmitted', EXISTS (SELECT 1 FROM upd),
                 'status', (SELECT s.status FROM users s WHERE s.id = ${userId}::bigint)) AS r`,
  );
  return resubmitRow.parse(row?.r ?? { state: null, resubmitted: false, status: null });
});
