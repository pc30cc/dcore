-- 0029 - What a person reads of an action carries when it was lifted:
-- moderation_action_view() gains `revokedAtMs` (absent while the action
-- stands, as jsonb_strip_nulls drops it). Same signature: callers and grants
-- are unchanged, and no statement is added anywhere.

CREATE OR REPLACE FUNCTION moderation_action_view(p_action bigint) RETURNS jsonb
  LANGUAGE sql STABLE PARALLEL SAFE
  RETURN (SELECT jsonb_strip_nulls(jsonb_build_object(
                   'id', a.id::text,
                   'kind', a.kind,
                   'reasonText', a.reason_text,
                   'startsAtMs', floor(extract(epoch FROM a.starts_at) * 1000)::bigint,
                   'endsAtMs', floor(extract(epoch FROM a.ends_at) * 1000)::bigint,
                   'revokedAtMs', floor(extract(epoch FROM a.revoked_at) * 1000)::bigint,
                   'appeal', (SELECT jsonb_strip_nulls(jsonb_build_object('id', ap.id::text, 'status', ap.status, 'decisionText', ap.decision_text))
                                FROM appeals ap WHERE ap.action_id = a.id ORDER BY ap.id DESC LIMIT 1)))
            FROM moderation_actions a WHERE a.id = p_action AND a.kind IN (1, 2, 3));
