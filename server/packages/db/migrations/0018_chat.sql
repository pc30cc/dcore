-- 0018 - Message requests and chat report evidence.
--
-- Chat itself needs no new table: messages arrive through the write-behind
-- stream (wb:msg) as batched INSERTs, read pointers are flushed by
-- matches_flush_read() (0006). What needs one statement each:
--
--   * message_request_send(): a request to someone not matched yet, with
--     its checks (visibility, an existing match, a pending request, a recent
--     decline, which is answered like a pending one so it is never
--     revealed) and, once the free quota is spent, the wallet's direct
--     message in the same transaction;
--   * message_request_accept(): the request becomes a conversation (the
--     match under the pair's lock, as match_create() makes it), its body the
--     first message, written directly;
--   * report_chat_evidence(): the messages a chat report is about, copied
--     into the report once they are durable.

-- ─── Sending a request ────────────────────────────────────────────────────
-- p_pay: the free quota is spent, take one direct message from the wallet
-- (the session store's balance first, then gifts; every store's with
-- p_cross_store). Returns {outcome: 'sent', paid, balance?, told, toCard} or
-- {outcome: 'not_found' | 'already_matched' | 'already_requested' | 'no_balance'}.
CREATE FUNCTION message_request_send(
  p_id          bigint,
  p_from        bigint,
  p_to          bigint,
  p_body        text,
  p_resend_days integer,
  p_pay         boolean,
  p_ledger_id   bigint,
  p_store       smallint,
  p_cross_store boolean
) RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_state   smallint;
  v_store   smallint;
  v_balance integer;
  v_id      bigint;
BEGIN
  IF p_from = p_to OR NOT can_see(p_from, p_to, 1) THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  SELECT m.state INTO v_state FROM matches m WHERE m.user_lo = least(p_from, p_to) AND m.user_hi = greatest(p_from, p_to);
  IF v_state = 1 THEN
    RETURN jsonb_build_object('outcome', 'already_matched');
  ELSIF v_state IS NOT NULL THEN
    -- They matched before and it ended (an unmatch, a block): never revealed.
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  IF EXISTS (SELECT 1 FROM message_requests r
              WHERE r.from_id = p_from AND r.to_id = p_to
                AND (r.status = 1 OR (r.status = 3 AND r.decided_at > now() - make_interval(days => p_resend_days)))) THEN
    RETURN jsonb_build_object('outcome', 'already_requested');
  END IF;
  IF p_pay THEN
    UPDATE wallet_balances b
       SET balance = b.balance - 1, updated_at = now()
      FROM (SELECT s.store FROM wallet_balances s
             WHERE s.user_id = p_from AND s.item = 4 AND s.balance >= 1
               AND (p_cross_store OR s.store = 0 OR s.store = p_store)
             ORDER BY (s.store = p_store) DESC, s.store DESC
             LIMIT 1
             FOR UPDATE) pick
     WHERE b.user_id = p_from AND b.item = 4 AND b.store = pick.store AND b.balance >= 1
    RETURNING b.store, b.balance INTO v_store, v_balance;
    IF v_store IS NULL THEN
      RETURN jsonb_build_object('outcome', 'no_balance');
    END IF;
  END IF;
  INSERT INTO message_requests (id, from_id, to_id, body)
  VALUES (p_id, p_from, p_to, p_body)
  ON CONFLICT (from_id, to_id) WHERE status = 1 DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    -- Another request of the pair committed first: nothing is paid for this one.
    RAISE EXCEPTION 'already_requested' USING ERRCODE = 'P0001';
  END IF;
  IF p_pay THEN
    INSERT INTO wallet_ledger (id, user_id, ref_id, delta, balance_after, item, store, reason)
    VALUES (p_ledger_id, p_from, p_id, -1, v_balance, 4, v_store, 2);
  END IF;
  RETURN jsonb_strip_nulls(jsonb_build_object(
    'outcome', 'sent',
    'paid', p_pay,
    'balance', v_balance,
    -- Whether the recipient may see the sender (a shadowbanned sender's request waits unseen).
    'told', can_see(p_to, p_from, 1),
    'toCard', profile_card(p_to)));
END
$$;

COMMENT ON FUNCTION message_request_send(bigint, bigint, bigint, text, integer, boolean, bigint, smallint, boolean) IS
  'POST /v1/message-requests in one statement: the checks, the wallet''s direct message when the free quota is spent, the request row.';

-- ─── Accepting a request ──────────────────────────────────────────────────
-- The recipient accepts: the pair's match (match_create(): the pair's lock,
-- share locks on both accounts, the INSERT only while each may see the
-- other in discovery; source 3), the request accepted (and the other
-- person's pending request to the recipient, if any), the body as the first
-- message (kind 1, sent by the requester) with the pre-minted id. A pair
-- that already has an active match gets the body in that conversation. An
-- accept repeated after it worked answers the same. Returns
-- {outcome: 'accepted', created, match: {...}, fromId, toId, body, messageId,
-- loCard, hiCard} or {outcome: 'not_found'}.
CREATE FUNCTION message_request_accept(p_request bigint, p_user bigint, p_match_id bigint, p_message_id bigint) RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  r       message_requests%ROWTYPE;
  m       record;
  v_msg   bigint;
BEGIN
  SELECT * INTO r FROM message_requests x WHERE x.id = p_request AND x.to_id = p_user FOR UPDATE;
  IF NOT FOUND OR r.status NOT IN (1, 2) THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  IF r.status = 2 THEN
    -- Already accepted: the same answer as the first time (its first message included).
    SELECT x.id, x.user_lo, x.user_hi, x.state, x.flags, x.source INTO m FROM matches x WHERE x.id = r.match_id;
    IF NOT FOUND OR m.state <> 1 THEN
      RETURN jsonb_build_object('outcome', 'not_found');
    END IF;
    SELECT y.id INTO v_msg FROM messages y
     WHERE y.match_id = m.id AND y.sender_id = r.from_id AND y.kind = 1 AND y.body = r.body
       AND y.id >= id_floor(r.decided_at - interval '1 minute')
     ORDER BY y.id LIMIT 1;
    RETURN jsonb_build_object(
      'outcome', 'accepted', 'created', false,
      'match', jsonb_build_object('id', m.id::text, 'lo', m.user_lo::text, 'hi', m.user_hi::text, 'state', m.state, 'flags', m.flags, 'source', m.source),
      'fromId', r.from_id::text, 'toId', r.to_id::text, 'body', r.body, 'messageId', coalesce(v_msg, p_message_id)::text,
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
   WHERE x.status = 1
     AND ((x.from_id = r.from_id AND x.to_id = r.to_id) OR (x.from_id = r.to_id AND x.to_id = r.from_id));
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
  'POST /v1/message-requests/:id/accept in one statement: the match (match_create, source 3), the request accepted, its body as the first message.';

-- ─── Chat evidence of a report ────────────────────────────────────────────
-- Once the write-behind stream is durable past the filing (the caller waits
-- for wb:msg's watermark), the messages the filing names and the last
-- p_context messages of the conversation before it are copied into the
-- report (evidence.chat, one snapshot per filing), with p_pending: messages
-- still in the stream (JSON rows from the caller after a long wait), merged
-- by id. A filing without a conversation (a message request) copies the
-- target's requests to the reporter. A filing already copied is not copied
-- again. evidence_at is set. Returns the number of messages copied, or -1
-- when the report does not exist.
CREATE FUNCTION report_chat_evidence(
  p_report   bigint,
  p_filing   bigint,
  p_match    bigint,
  p_messages bigint[],
  p_context  integer,
  p_pending  jsonb
) RETURNS integer
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_report   reports%ROWTYPE;
  v_rows     jsonb;
  v_requests jsonb;
  v_n        integer;
BEGIN
  SELECT * INTO v_report FROM reports x WHERE x.id = p_report FOR UPDATE;
  IF NOT FOUND THEN
    RETURN -1;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(v_report.evidence -> 'chat', '[]'::jsonb)) s
              WHERE s ->> 'filingId' = p_filing::text) THEN
    UPDATE reports x SET evidence_at = coalesce(x.evidence_at, now()) WHERE x.id = p_report;
    RETURN 0;
  END IF;

  IF p_match IS NOT NULL THEN
    WITH picked AS (
      SELECT y.id, y.sender_id, y.ref_id, y.kind, y.flags, y.body
        FROM messages y
       WHERE y.match_id = p_match AND y.id = ANY (coalesce(p_messages, '{}'))
      UNION
      SELECT z.id, z.sender_id, z.ref_id, z.kind, z.flags, z.body
        FROM (SELECT w.id, w.sender_id, w.ref_id, w.kind, w.flags, w.body
                FROM messages w
               WHERE w.match_id = p_match AND w.id < p_filing
               ORDER BY w.id DESC
               LIMIT p_context) z
    ), rows AS (
      SELECT p.id, jsonb_strip_nulls(jsonb_build_object(
               'id', p.id::text, 'senderId', p.sender_id::text, 'refId', p.ref_id::text,
               'kind', p.kind, 'flags', p.flags, 'body', p.body,
               'atMs', floor(extract(epoch FROM id_time(p.id)) * 1000)::bigint)) AS row
        FROM picked p
      UNION ALL
      SELECT (e ->> 'id')::bigint, e
        FROM jsonb_array_elements(coalesce(p_pending, '[]'::jsonb)) e
       WHERE NOT EXISTS (SELECT 1 FROM picked p WHERE p.id = (e ->> 'id')::bigint)
    )
    SELECT coalesce(jsonb_agg(x.row ORDER BY x.id), '[]'::jsonb), count(*)::integer INTO v_rows, v_n FROM rows x;
  ELSE
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'requestId', q.id::text, 'senderId', q.from_id::text, 'status', q.status, 'body', q.body,
             'atMs', floor(extract(epoch FROM id_time(q.id)) * 1000)::bigint) ORDER BY q.id), '[]'::jsonb),
           count(*)::integer
      INTO v_requests, v_n
      FROM (SELECT r.id, r.from_id, r.status, r.body FROM message_requests r
             WHERE r.from_id = v_report.target_id AND r.to_id = v_report.reporter_id AND r.id < p_filing
             ORDER BY r.id DESC LIMIT 5) q;
  END IF;

  UPDATE reports x
     SET evidence = jsonb_set(x.evidence, '{chat}',
                              coalesce(x.evidence -> 'chat', '[]'::jsonb) || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
                                'filingId', p_filing::text,
                                'conversationId', p_match::text,
                                'takenAtMs', floor(extract(epoch FROM now()) * 1000)::bigint,
                                'messages', v_rows,
                                'requests', v_requests)))),
         evidence_at = now()
   WHERE x.id = p_report;
  RETURN v_n;
END
$$;

COMMENT ON FUNCTION report_chat_evidence(bigint, bigint, bigint, bigint[], integer, jsonb) IS
  'The chat evidence of one report filing (the messages it names and the conversation''s last messages before it, or the target''s requests), copied once into reports.evidence; sets evidence_at.';

REVOKE ALL ON FUNCTION message_request_send(bigint, bigint, bigint, text, integer, boolean, bigint, smallint, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION message_request_accept(bigint, bigint, bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION report_chat_evidence(bigint, bigint, bigint, bigint[], integer, jsonb) FROM PUBLIC;

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    GRANT EXECUTE ON FUNCTION message_request_send(bigint, bigint, bigint, text, integer, boolean, bigint, smallint, boolean),
                              message_request_accept(bigint, bigint, bigint, bigint),
                              report_chat_evidence(bigint, bigint, bigint, bigint[], integer, jsonb) TO app_rw;
  ELSE
    RAISE NOTICE 'role app_rw does not exist: grants skipped (development database?)';
  END IF;
END
$grant$;
