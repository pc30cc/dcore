-- 0021 — accepting a message request accepts that request only.
--
-- Two people can each have a pending request to the other. Accepting one
-- used to mark both accepted while storing only the accepted one's body as
-- a message: the other body (possibly paid from the wallet) was lost, and a
-- later accept of that request answered with a message id that was never
-- written. Two accepts of the two requests at the same moment could also
-- deadlock (each held its own request row, then waited for the pair's lock,
-- then for the other's row).
--
-- Now the pair's lock is taken first (match_create() takes it again in the
-- same transaction), only the accepted request moves to accepted, and the
-- other one stays pending: accepting it later finds the pair's active match
-- and stores its body there under its own id. An accept repeated after it
-- worked answers with the message it stored, or with no message id when
-- none is stored (nothing to show).
CREATE OR REPLACE FUNCTION message_request_accept(p_request bigint, p_user bigint, p_match_id bigint, p_message_id bigint) RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  r       message_requests%ROWTYPE;
  m       record;
  v_from  bigint;
  v_msg   bigint;
BEGIN
  SELECT x.from_id INTO v_from FROM message_requests x WHERE x.id = p_request AND x.to_id = p_user;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  -- The pair's lock before any row lock, in the order match_create() and the block take them.
  PERFORM pg_advisory_xact_lock(pair_lock_key(v_from, p_user));
  SELECT * INTO r FROM message_requests x WHERE x.id = p_request AND x.to_id = p_user FOR UPDATE;
  IF NOT FOUND OR r.status NOT IN (1, 2) THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  IF r.status = 2 THEN
    -- Already accepted: the same answer as the first time (its first message included, when it is stored).
    SELECT x.id, x.user_lo, x.user_hi, x.state, x.flags, x.source INTO m FROM matches x WHERE x.id = r.match_id;
    IF NOT FOUND OR m.state <> 1 THEN
      RETURN jsonb_build_object('outcome', 'not_found');
    END IF;
    SELECT y.id INTO v_msg FROM messages y
     WHERE y.match_id = m.id AND y.sender_id = r.from_id AND y.kind = 1 AND y.body = r.body
       AND y.id >= id_floor(r.decided_at - interval '1 minute')
     ORDER BY y.id LIMIT 1;
    -- messageId is null when no first message is stored.
    RETURN jsonb_build_object(
      'outcome', 'accepted', 'created', false,
      'match', jsonb_build_object('id', m.id::text, 'lo', m.user_lo::text, 'hi', m.user_hi::text, 'state', m.state, 'flags', m.flags, 'source', m.source),
      'fromId', r.from_id::text, 'toId', r.to_id::text, 'body', r.body, 'messageId', v_msg::text,
      'loCard', profile_card(m.user_lo), 'hiCard', profile_card(m.user_hi));
  END IF;

  SELECT c.o_id AS id, c.o_lo AS user_lo, c.o_hi AS user_hi, c.o_state AS state, c.o_flags AS flags, c.o_source AS source,
         c.o_created AS created, c.o_lo_card AS lo_card, c.o_hi_card AS hi_card
    INTO m
    FROM match_create(p_match_id, p_user, r.from_id, 3::smallint) c;
  IF NOT FOUND OR m.state <> 1 THEN
    -- The pair may not match (a block, a hidden account), or matched before and it ended.
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  UPDATE message_requests x SET status = 2, decided_at = now(), match_id = m.id
   WHERE x.id = r.id AND x.status = 1;
  INSERT INTO messages (match_id, id, sender_id, kind, flags, body)
  VALUES (m.id, p_message_id, r.from_id, 1, 0, r.body)
  ON CONFLICT (match_id, id) DO NOTHING;

  RETURN jsonb_build_object(
    'outcome', 'accepted', 'created', m.created,
    'match', jsonb_build_object('id', m.id::text, 'lo', m.user_lo::text, 'hi', m.user_hi::text, 'state', m.state, 'flags', m.flags, 'source', m.source),
    'fromId', r.from_id::text, 'toId', r.to_id::text, 'body', r.body, 'messageId', p_message_id::text,
    'loCard', m.lo_card, 'hiCard', m.hi_card);
END
$$;

COMMENT ON FUNCTION message_request_accept(bigint, bigint, bigint, bigint) IS
  'POST /v1/message-requests/:id/accept in one statement: the pair''s lock, the match (match_create, source 3), this request accepted (a request the other way stays pending), its body as the first message.';

REVOKE ALL ON FUNCTION message_request_accept(bigint, bigint, bigint, bigint) FROM PUBLIC;

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    GRANT EXECUTE ON FUNCTION message_request_accept(bigint, bigint, bigint, bigint) TO app_rw;
  ELSE
    RAISE NOTICE 'role app_rw does not exist: grants skipped (development database?)';
  END IF;
END
$grant$;
