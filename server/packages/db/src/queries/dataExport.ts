import { many, maybeOne, sql } from '../query.js';
import { defineQuery } from './define.js';

/**
 * What an account's data export reads (the worker's `account/export` job): a
 * few keyset reads, never on a request path. Only the person's own data:
 * their account, profile, photos (the rows; the pictures come from the
 * media bucket), their conversations without the other person, their own
 * messages and their purchases. No other person's id or name, and an ended
 * conversation reads "ended" whatever ended it (a block is never revealed).
 */

export interface ExportPhotoRow {
  id: string;
  position: number;
  status: number;
  blobVer: number;
}

export interface ExportAccountRow {
  status: number;
  /** The document of the person's own data (account, profile, fields, prompts, preferences, consents, conversations, purchases). */
  data: Record<string, unknown>;
  photos: ExportPhotoRow[];
  /** The ids of every conversation the person had (for their messages). */
  conversationIds: string[];
}

/** The account's own data in one statement; null for an account that is gone (deleted or purged). */
export const exportAccount = defineQuery({ name: 'dataExport.account', statements: 1 }, async (db, userId: string): Promise<ExportAccountRow | null> => {
  const row = await maybeOne<{ status: number; data: Record<string, unknown>; photos: ExportPhotoRow[]; conversation_ids: string[] }>(
    db,
    sql`SELECT u.status,
               jsonb_build_object(
                 'account', jsonb_strip_nulls(jsonb_build_object(
                   'createdAt', id_time(u.id), 'birthDate', u.birth_date, 'gender', u.gender, 'country', u.country,
                   'locale', u.locale, 'status', u.status, 'verified', u.is_verified)),
                 'profile', (SELECT jsonb_strip_nulls(jsonb_build_object(
                                'displayName', p.display_name, 'about', p.about, 'jobTitle', p.job_title, 'intention', p.intention,
                                'matching', p.mode_match, 'social', p.mode_social, 'incognito', p.incognito, 'hideAge', p.hide_age,
                                'hideDistance', p.hide_distance, 'showOnline', p.show_online, 'acceptCalls', p.accept_calls,
                                'updatedAt', p.updated_at))
                               FROM profiles p WHERE p.user_id = u.id),
                 'fields', (SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                                'field', d.key, 'number', v.num, 'option', v.opt, 'options', to_jsonb(v.opts), 'text', v.txt)) ORDER BY v.field_id), '[]'::jsonb)
                              FROM profile_field_values v JOIN profile_field_defs d ON d.id = v.field_id WHERE v.user_id = u.id),
                 'prompts', (SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                                'position', x.position, 'prompt', x.prompt_id, 'answer', x.answer, 'audioMs', x.audio_ms, 'status', x.status)) ORDER BY x.position), '[]'::jsonb)
                               FROM profile_prompts x WHERE x.user_id = u.id),
                 'preferences', (SELECT jsonb_build_object(
                                   'maxDistanceKm', f.max_distance_km, 'ageMin', f.age_min, 'ageMax', f.age_max, 'interestedIn', f.interested_in,
                                   'intents', f.intents, 'flags', f.flags, 'filters', f.filters, 'updatedAt', f.updated_at)
                                   FROM preferences f WHERE f.user_id = u.id),
                 'consents', (SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                                 'kind', c.kind, 'version', c.version, 'acceptedAt', c.accepted_at, 'withdrawnAt', c.withdrawn_at, 'store', c.store))
                                 ORDER BY c.kind, c.version), '[]'::jsonb)
                                FROM user_consents c WHERE c.user_id = u.id),
                 'conversations', (SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                                      'conversationId', m.id::text, 'matchedAt', id_time(m.id),
                                      'state', CASE WHEN m.state = 1 THEN 'active' ELSE 'ended' END, 'endedAt', m.ended_at)) ORDER BY m.id), '[]'::jsonb)
                                     FROM matches m WHERE m.user_lo = u.id OR m.user_hi = u.id),
                 'purchases', (SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                                  'productId', sp.product_id, 'store', s.store, 'kind', s.kind, 'state', s.state, 'quantity', s.quantity,
                                  'purchasedAt', s.purchased_at, 'expiresAt', s.expires_at, 'autoRenew', s.auto_renew, 'orderId', s.order_id))
                                  ORDER BY s.purchased_at, s.id), '[]'::jsonb)
                                 FROM store_purchases s JOIN store_products sp ON sp.id = s.product_ref WHERE s.user_id = u.id),
                 'subscriptions', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                                      'plan', sb.plan_id, 'store', sb.store, 'status', sb.status, 'startedAt', sb.started_at,
                                      'expiresAt', sb.expires_at, 'autoRenew', sb.auto_renew) ORDER BY sb.store), '[]'::jsonb)
                                     FROM subscriptions sb WHERE sb.user_id = u.id),
                 'wallet', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                               'at', id_time(w.id), 'item', w.item, 'store', w.store, 'delta', w.delta, 'balanceAfter', w.balance_after, 'reason', w.reason)
                               ORDER BY w.id), '[]'::jsonb)
                              FROM wallet_ledger w WHERE w.user_id = u.id)
               ) AS data,
               (SELECT coalesce(jsonb_agg(jsonb_build_object('id', ph.id::text, 'position', ph.position, 'status', ph.status, 'blobVer', ph.blob_ver)
                                 ORDER BY ph.position), '[]'::jsonb)
                  FROM photos ph WHERE ph.user_id = u.id) AS photos,
               ARRAY(SELECT m.id::text FROM matches m WHERE m.user_lo = u.id OR m.user_hi = u.id ORDER BY m.id) AS conversation_ids
          FROM users u
         WHERE u.id = ${userId}::bigint AND u.status NOT IN (7, 8)`,
  );
  if (!row) return null;
  return { status: row.status, data: row.data, photos: row.photos, conversationIds: row.conversation_ids };
});

export interface ExportMessageRow {
  conversationId: string;
  id: string;
  kind: number;
  flags: number;
  refId: string | null;
  body: string | null;
}

/**
 * One page of the person's own messages in their conversations, in
 * (conversation, id) order after `after` (a keyset over the messages key).
 */
export const exportOwnMessages = defineQuery(
  { name: 'dataExport.ownMessages', statements: 1 },
  async (db, userId: string, conversationIds: readonly string[], after: { conversationId: string; id: string } | null, limit: number): Promise<ExportMessageRow[]> => {
    if (conversationIds.length === 0) return [];
    const rows = await many<{ match_id: string; id: string; kind: number; flags: number; ref_id: string | null; body: string | null }>(
      db,
      sql`SELECT m.match_id::text AS match_id, m.id::text AS id, m.kind, m.flags, m.ref_id::text AS ref_id, m.body
            FROM messages m
           WHERE m.match_id = ANY (${[...conversationIds]}::bigint[]) AND m.sender_id = ${userId}::bigint
             AND (m.match_id, m.id) > (${after?.conversationId ?? '0'}::bigint, ${after?.id ?? '0'}::bigint)
           ORDER BY m.match_id, m.id
           LIMIT ${limit}::integer`,
    );
    return rows.map((r) => ({ conversationId: r.match_id, id: r.id, kind: r.kind, flags: r.flags, refId: r.ref_id, body: r.body }));
  },
);
