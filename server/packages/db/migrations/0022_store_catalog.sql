-- 0022 — The store catalogue in the shape each store uses, and the purchase
-- core: one statement that applies a verified store purchase, the computed
-- subscription per user and store, and the rows entitlements are built from.
--
-- Catalogue:
--   * Google Play sells one subscription per tier (`sub.plus`, `sub.premium`)
--     with base plans `w1`, `m1`, `m3`, `m6`; the per-period Play rows of 0007
--     go (rows a purchase already references stay, inactive).
--   * Cafe Bazaar has no weekly period (30/60/90/180/365 days only): the
--     `.1w` rows go and `.12m` rows are added.
--   * Everything stays inactive until the product exists in that store's
--     console; the panel turns rows on. Prices are never sent to apps.
--
-- Functions (all called by the API and the worker, never by apps):
--   * entitlement_rows(user): the person's live subscription rows (every
--     store) and wallet balances in one jsonb, so building entitlements on a
--     cache miss is one statement;
--   * subscription_recompute(user, store): the subscriptions row of one
--     store (0 = admin grants) from store_purchases or entitlement_grants,
--     written only when the result differs, deleted when nothing counts;
--   * store_purchase_apply(p): a verified purchase state in one statement:
--     the store_purchases upsert by (store, token_hash), the store_events
--     row of the change, the linked token replaced, the subscription
--     recomputed or the wallet credited (or reversed once for a refund), and
--     the person's entitlement rows for the answer.
--
-- Indexes for the worker's hourly sweep (acknowledgements and consumes
-- still owed; live subscriptions without a next check).

-- ─── Catalogue ────────────────────────────────────────────────────────────
DELETE FROM store_products sp
 WHERE sp.store = 1 AND sp.kind = 1
   AND sp.product_id IN ('sub.plus.1w', 'sub.plus.1m', 'sub.plus.3m', 'sub.plus.6m',
                         'sub.premium.1w', 'sub.premium.1m', 'sub.premium.3m', 'sub.premium.6m')
   AND NOT EXISTS (SELECT 1 FROM store_purchases p WHERE p.product_ref = sp.id);
UPDATE store_products SET is_active = false, updated_at = now()
 WHERE store = 1 AND kind = 1 AND base_plan_id IS NULL;

INSERT INTO store_products (store, kind, plan_id, period, product_id, base_plan_id, sort)
SELECT 1::smallint, 1::smallint, p.id, c.period, c.product_id, c.base_plan_id, c.sort
  FROM (VALUES
    ('plus',    'P1W', 'sub.plus',    'w1', 10::smallint),
    ('plus',    'P1M', 'sub.plus',    'm1', 11),
    ('plus',    'P3M', 'sub.plus',    'm3', 12),
    ('plus',    'P6M', 'sub.plus',    'm6', 13),
    ('premium', 'P1W', 'sub.premium', 'w1', 20),
    ('premium', 'P1M', 'sub.premium', 'm1', 21),
    ('premium', 'P3M', 'sub.premium', 'm3', 22),
    ('premium', 'P6M', 'sub.premium', 'm6', 23)
  ) AS c(plan_key, period, product_id, base_plan_id, sort)
  JOIN plans p ON p.key = c.plan_key
ON CONFLICT ON CONSTRAINT store_products_key DO NOTHING;

DELETE FROM store_products sp
 WHERE sp.store = 2 AND sp.product_id IN ('sub.plus.1w', 'sub.premium.1w')
   AND NOT EXISTS (SELECT 1 FROM store_purchases p WHERE p.product_ref = sp.id);
UPDATE store_products SET is_active = false, updated_at = now()
 WHERE store = 2 AND product_id IN ('sub.plus.1w', 'sub.premium.1w');

INSERT INTO store_products (store, kind, plan_id, period, product_id, sort)
SELECT 2::smallint, 1::smallint, p.id, 'P12M', c.product_id, c.sort
  FROM (VALUES ('plus', 'sub.plus.12m', 14::smallint), ('premium', 'sub.premium.12m', 24)) AS c(plan_key, product_id, sort)
  JOIN plans p ON p.key = c.plan_key
ON CONFLICT ON CONSTRAINT store_products_key DO NOTHING;

-- ─── Entitlement rows ─────────────────────────────────────────────────────
CREATE FUNCTION entitlement_rows(p_user bigint) RETURNS jsonb
  LANGUAGE sql STABLE
  SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'subs', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'store', s.store, 'planId', s.plan_id, 'status', s.status, 'autoRenew', s.auto_renew,
               'startedAtMs', (extract(epoch FROM s.started_at) * 1000)::bigint,
               'expiresAtMs', (extract(epoch FROM s.expires_at) * 1000)::bigint,
               'productId', sp.product_id, 'basePlanId', sp.base_plan_id)
             ORDER BY s.store)
        FROM subscriptions s
        LEFT JOIN store_purchases p ON p.id = s.purchase_id
        LEFT JOIN store_products sp ON sp.id = p.product_ref
       WHERE s.user_id = p_user AND s.expires_at > now()), '[]'::jsonb),
    'wallet', coalesce((
      SELECT jsonb_agg(jsonb_build_object('item', w.item, 'store', w.store, 'balance', w.balance) ORDER BY w.item, w.store)
        FROM wallet_balances w
       WHERE w.user_id = p_user AND w.balance > 0), '[]'::jsonb));
$$;

COMMENT ON FUNCTION entitlement_rows(bigint) IS
  'A person''s live subscription rows (every store, 0 = grants, with the product of each store row) and positive wallet balances (every store): what entitlements are built from, in one statement.';

-- ─── The computed subscription of one store ───────────────────────────────
-- Store 0: the best live admin grant. Stores 1-3: the best store purchase
-- that gives access now (active, canceled until its expiry, grace period),
-- by plan rank, then the later expiry. The row is written only when the
-- result differs and deleted when nothing counts. True when it changed.
--
-- The person's advisory lock (the one store_purchase_apply() takes, so
-- re-entrant there) is taken before anything is read: a bare call (a
-- subscription's end, a grant) waits for a purchase of the same person to
-- commit and then reads its rows, instead of deleting a row a renewal just
-- wrote from a snapshot taken before it.
CREATE FUNCTION subscription_recompute(p_user bigint, p_store smallint) RETURNS boolean
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  cur      subscriptions%ROWTYPE;
  v_has    boolean;
  v_plan   smallint;
  v_start  timestamptz;
  v_end    timestamptz;
  v_purch  bigint;
  v_status smallint;
  v_renew  boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(1937008737, hashtext(p_user::text));
  IF p_store = 0 THEN
    SELECT g.plan_id, g.starts_at, g.ends_at, NULL::bigint, 4::smallint, false
      INTO v_plan, v_start, v_end, v_purch, v_status, v_renew
      FROM entitlement_grants g
      JOIN plans pl ON pl.id = g.plan_id
     WHERE g.user_id = p_user AND g.revoked_at IS NULL AND g.starts_at <= now() AND g.ends_at > now()
     ORDER BY pl.rank DESC, g.ends_at DESC
     LIMIT 1;
    v_has := FOUND;
  ELSE
    SELECT sp.plan_id, p.purchased_at, p.expires_at, p.id,
           (CASE WHEN p.state = 4 THEN 3 WHEN p.state = 3 OR NOT coalesce(p.auto_renew, false) THEN 2 ELSE 1 END)::smallint,
           (p.state = 2 AND coalesce(p.auto_renew, false))
      INTO v_plan, v_start, v_end, v_purch, v_status, v_renew
      FROM store_purchases p
      JOIN store_products sp ON sp.id = p.product_ref
      JOIN plans pl ON pl.id = sp.plan_id
     WHERE p.user_id = p_user AND p.store = p_store AND p.kind = 1 AND p.state IN (2, 3, 4) AND p.expires_at > now()
     ORDER BY pl.rank DESC, p.expires_at DESC
     LIMIT 1;
    v_has := FOUND;
  END IF;

  SELECT * INTO cur FROM subscriptions s WHERE s.user_id = p_user AND s.store = p_store FOR UPDATE;
  IF NOT FOUND THEN
    IF NOT v_has THEN
      RETURN false;
    END IF;
    INSERT INTO subscriptions (user_id, started_at, expires_at, purchase_id, plan_id, store, status, auto_renew)
    VALUES (p_user, v_start, v_end, v_purch, v_plan, p_store, v_status, v_renew);
    RETURN true;
  END IF;
  IF NOT v_has THEN
    DELETE FROM subscriptions s WHERE s.user_id = p_user AND s.store = p_store;
    RETURN true;
  END IF;
  IF cur.plan_id = v_plan AND cur.started_at = v_start AND cur.expires_at = v_end AND cur.purchase_id IS NOT DISTINCT FROM v_purch
     AND cur.status = v_status AND cur.auto_renew = v_renew THEN
    RETURN false;
  END IF;
  UPDATE subscriptions s
     SET started_at = v_start, expires_at = v_end, purchase_id = v_purch, plan_id = v_plan,
         status = v_status, auto_renew = v_renew, updated_at = now()
   WHERE s.user_id = p_user AND s.store = p_store;
  RETURN true;
END
$$;

COMMENT ON FUNCTION subscription_recompute(bigint, smallint) IS
  'The subscriptions row of one person and store (0 = admin grants) from store_purchases (active, canceled until expiry, grace) or entitlement_grants, best plan rank first; written only when it differs, deleted when nothing counts. True when the row changed.';

-- ─── Amounts ──────────────────────────────────────────────────────────────
-- list_price_minor is in the currency's ISO 4217 minor unit; events carry micros.
CREATE FUNCTION store_minor_to_micros(p_minor bigint, p_currency char(3)) RETURNS bigint
  LANGUAGE sql IMMUTABLE
AS $$
  SELECT p_minor * CASE
    WHEN p_currency IN ('BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF') THEN 1000000
    WHEN p_currency IN ('BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND') THEN 1000
    ELSE 10000
  END;
$$;

-- ─── Applying a verified purchase ─────────────────────────────────────────
-- p (jsonb; ids as decimal text, times in epoch ms):
--   id, eventId, ledgerId     ids minted by the caller (the row, its event, a wallet ledger row)
--   linkedEventId             the id of the linked token's `replaced` event
--   store, tokenHash (hex), token, linkedTokenHash (hex | null)
--   callerId                  the signed-in person who sent the token (null in jobs)
--   accountUserId             the person the store's account reference decodes to (null: none)
--   productRef, kind, state   store_products.id, 1/2, the verified store_purchases.state
--   purchasedAtMs, expiresAtMs, autoRenew, quantity, isTest, region, orderId
--   acknowledged, consumed    what the store reports
--   eventMs                   the store's time of this state (older than last_event_ms: ignored)
--   nextCheckAtMs             when the worker asks the store again (null: never)
--   source                    store_events.source
--   amountMicros, currency    what the store reported (null: the list price, estimated)
--
-- The person a token belongs to is fixed by its first attribution: the
-- existing row's owner, else the store's account reference, else the
-- linked token's owner, else the caller; with none of them the row is
-- `unclaimed` (11) and grants nothing. An account reference that names no
-- account is refused without a write (`foreign_account`).
--
-- Concurrency: the token's row (and the linked token's) is locked first,
-- then the person's advisory lock, so two purchases of one person never
-- compute their subscription from each other's half-written state.
--
-- The server's own end states hold against later reads of the token: a
-- replaced token (9) stays replaced unless the store shows it giving access
-- again (2, 3, 4); a revoked consumable (8) stays revoked; a revoked
-- subscription stays revoked unless the store shows a later paid period
-- (a granting state with a later expiry). A pinned row is left as it is.
--
-- A pending purchase (1) that completes takes the store's time of the
-- completion as purchased_at (the acknowledgement window starts there).
--
-- `replacedUserId` / `replacedRows`: the owner of a replaced linked token
-- when it is someone else, and their entitlement rows (their subscription
-- was recomputed too), so the caller moves their entitlements as well.
CREATE FUNCTION store_purchase_apply(p jsonb) RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  cur          store_purchases%ROWTYPE;
  lnk          store_purchases%ROWTYPE;
  prod         store_products%ROWTYPE;
  v_store      smallint := (p->>'store')::smallint;
  v_hash       bytea := decode(p->>'tokenHash', 'hex');
  v_linked     bytea := CASE WHEN p->>'linkedTokenHash' IS NULL THEN NULL ELSE decode(p->>'linkedTokenHash', 'hex') END;
  v_caller     bigint := (p->>'callerId')::bigint;
  v_account    bigint := (p->>'accountUserId')::bigint;
  v_state      smallint := (p->>'state')::smallint;
  v_kind       smallint := (p->>'kind')::smallint;
  v_event_ms   bigint := (p->>'eventMs')::bigint;
  v_expires    timestamptz := CASE WHEN p->>'expiresAtMs' IS NULL THEN NULL ELSE to_timestamp((p->>'expiresAtMs')::bigint / 1000.0) END;
  v_next       timestamptz := CASE WHEN p->>'nextCheckAtMs' IS NULL THEN NULL ELSE to_timestamp((p->>'nextCheckAtMs')::bigint / 1000.0) END;
  v_renew      boolean := (p->>'autoRenew')::boolean;
  v_ack        boolean := coalesce((p->>'acknowledged')::boolean, false);
  v_consumed   boolean := coalesce((p->>'consumed')::boolean, false);
  v_qty        smallint := coalesce((p->>'quantity')::smallint, 1);
  v_order      text := p->>'orderId';
  v_exists     boolean;
  v_created    boolean := false;
  v_user       bigint;
  v_from       smallint;
  v_changed    boolean := false;
  v_event      smallint;
  v_credit     integer := 0;
  v_debited    integer := 0;
  v_shortfall  integer := 0;
  v_balance    integer;
  v_sub        boolean := false;
  v_amount     bigint;
  v_currency   char(3);
  v_estimated  boolean := false;
  v_linked_uid bigint;
  v_pinned     boolean := false;
  v_other      bigint;
  v_other_rows jsonb;
BEGIN
  SELECT * INTO prod FROM store_products sp WHERE sp.id = (p->>'productRef')::smallint;
  IF NOT FOUND OR prod.store <> v_store OR prod.kind <> v_kind THEN
    RAISE EXCEPTION 'store_purchase_apply: product % does not match store % kind %', p->>'productRef', v_store, v_kind
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO cur FROM store_purchases x WHERE x.store = v_store AND x.token_hash = v_hash FOR UPDATE;
  v_exists := FOUND;
  IF v_exists AND cur.last_event_ms IS NOT NULL AND v_event_ms < cur.last_event_ms THEN
    RETURN jsonb_build_object('outcome', 'stale', 'purchaseId', cur.id::text, 'userId', cur.user_id::text, 'state', cur.state,
                              'productRef', cur.product_ref, 'kind', cur.kind,
                              'expiresAtMs', (extract(epoch FROM cur.expires_at) * 1000)::bigint,
                              'rows', CASE WHEN cur.user_id IS NULL THEN NULL ELSE entitlement_rows(cur.user_id) END);
  END IF;

  IF v_linked IS NOT NULL AND v_linked <> v_hash THEN
    SELECT * INTO lnk FROM store_purchases x WHERE x.store = v_store AND x.token_hash = v_linked FOR UPDATE;
    IF FOUND THEN
      v_linked_uid := lnk.user_id;
    END IF;
  END IF;

  IF v_account IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = v_account) THEN
    IF NOT v_exists OR cur.user_id IS NULL THEN
      RETURN jsonb_build_object('outcome', 'foreign_account');
    END IF;
  END IF;

  v_user := CASE WHEN v_exists AND cur.user_id IS NOT NULL THEN cur.user_id
                 WHEN v_account IS NOT NULL AND EXISTS (SELECT 1 FROM users u WHERE u.id = v_account) THEN v_account
                 ELSE coalesce(v_linked_uid, v_caller) END;
  IF v_user IS NULL THEN
    v_state := 11;
  END IF;

  IF NOT v_exists THEN
    INSERT INTO store_purchases (id, user_id, purchased_at, expires_at, acknowledged_at, consumed_at, next_check_at, last_event_ms,
                                 product_ref, store, kind, state, quantity, auto_renew, is_test, region, token_hash,
                                 linked_token_hash, token, order_id)
    VALUES ((p->>'id')::bigint, v_user, to_timestamp((p->>'purchasedAtMs')::bigint / 1000.0), v_expires,
            CASE WHEN v_ack THEN now() END, CASE WHEN v_consumed THEN now() END, v_next, v_event_ms,
            prod.id, v_store, v_kind, v_state, v_qty, v_renew, coalesce((p->>'isTest')::boolean, false), p->>'region', v_hash,
            v_linked, p->>'token', v_order)
    ON CONFLICT ON CONSTRAINT store_purchases_token_key DO NOTHING
    RETURNING * INTO cur;
    IF FOUND THEN
      v_created := true;
      v_changed := true;
    ELSE
      -- Another transaction inserted the same token first: start again from its row.
      SELECT * INTO cur FROM store_purchases x WHERE x.store = v_store AND x.token_hash = v_hash FOR UPDATE;
      IF cur.last_event_ms IS NOT NULL AND v_event_ms < cur.last_event_ms THEN
        RETURN jsonb_build_object('outcome', 'stale', 'purchaseId', cur.id::text, 'userId', cur.user_id::text, 'state', cur.state,
                                  'productRef', cur.product_ref, 'kind', cur.kind,
                                  'expiresAtMs', (extract(epoch FROM cur.expires_at) * 1000)::bigint,
                                  'rows', CASE WHEN cur.user_id IS NULL THEN NULL ELSE entitlement_rows(cur.user_id) END);
      END IF;
      v_exists := true;
      IF cur.user_id IS NOT NULL THEN
        v_user := cur.user_id;
        IF v_state = 11 THEN
          v_state := (p->>'state')::smallint;
        END IF;
      END IF;
    END IF;
  END IF;

  -- The person's lock before anything of theirs is read or written (after the token rows' locks).
  -- Two people (a linked token of someone else): in id order, so two such transactions cannot wait on each other.
  PERFORM pg_advisory_xact_lock(1937008737, hashtext(u::text))
     FROM (SELECT DISTINCT u FROM unnest(ARRAY[v_user, lnk.user_id]) AS t(u) WHERE u IS NOT NULL ORDER BY u) o;

  v_from := CASE WHEN v_created THEN NULL ELSE cur.state END;
  IF NOT v_created THEN
    -- A consumable that was consumed stays consumed; a refund still reaches it.
    IF cur.state = 10 AND v_state = 12 THEN
      v_state := 10;
    END IF;
    IF cur.state = 9 AND v_state NOT IN (2, 3, 4) THEN
      v_pinned := true;
    ELSIF cur.state = 8 AND (cur.kind = 2 OR v_state NOT IN (2, 3, 4) OR v_expires IS NULL OR cur.expires_at IS NULL
                             OR v_expires <= cur.expires_at) THEN
      v_pinned := true;
    END IF;
    IF v_pinned THEN
      v_state := cur.state;
    ELSIF cur.state IS DISTINCT FROM v_state OR cur.user_id IS DISTINCT FROM v_user OR cur.expires_at IS DISTINCT FROM v_expires
       OR cur.auto_renew IS DISTINCT FROM v_renew OR (v_ack AND cur.acknowledged_at IS NULL)
       OR (v_consumed AND cur.consumed_at IS NULL) OR cur.next_check_at IS DISTINCT FROM v_next
       OR (v_order IS NOT NULL AND cur.order_id IS DISTINCT FROM v_order) OR cur.product_ref <> prod.id THEN
      v_changed := true;
      UPDATE store_purchases x
         SET user_id = v_user, state = v_state, expires_at = v_expires, auto_renew = v_renew,
             purchased_at = CASE WHEN x.state = 1 AND v_state NOT IN (1, 11)
                                 THEN to_timestamp((p->>'purchasedAtMs')::bigint / 1000.0) ELSE x.purchased_at END,
             acknowledged_at = CASE WHEN v_ack THEN coalesce(x.acknowledged_at, now()) ELSE x.acknowledged_at END,
             consumed_at = CASE WHEN v_consumed THEN coalesce(x.consumed_at, now()) ELSE x.consumed_at END,
             next_check_at = v_next, order_id = coalesce(v_order, x.order_id), product_ref = prod.id,
             linked_token_hash = coalesce(v_linked, x.linked_token_hash),
             last_event_ms = greatest(coalesce(x.last_event_ms, v_event_ms), v_event_ms), updated_at = now()
       WHERE x.id = cur.id;
    END IF;
  END IF;

  -- The event of the change: one row per applied state change, never per notification.
  IF v_pinned THEN
    v_event := NULL;
  ELSIF v_created THEN
    v_event := 1;
  ELSIF v_from IS DISTINCT FROM v_state THEN
    v_event := CASE v_state
      WHEN 2 THEN CASE WHEN v_from = 1 OR v_from = 11 THEN 1 WHEN v_from = 3 THEN 4 WHEN v_from IN (4, 5, 6) THEN 7 ELSE 2 END
      WHEN 3 THEN 3 WHEN 4 THEN 5 WHEN 5 THEN 6 WHEN 6 THEN 8 WHEN 7 THEN 9 WHEN 8 THEN 10 WHEN 9 THEN 11
      WHEN 10 THEN CASE WHEN v_from IN (1, 11) THEN 1 ELSE 13 END
      WHEN 12 THEN CASE WHEN v_from IN (1, 11) THEN 1 ELSE 99 END
      ELSE 99 END;
  ELSIF v_state IN (2, 3, 4) AND v_expires > cur.expires_at THEN
    v_event := 2;
  ELSIF cur.auto_renew IS DISTINCT FROM v_renew AND v_renew IS NOT NULL THEN
    v_event := CASE WHEN v_renew THEN 4 ELSE 3 END;
  ELSIF v_ack AND cur.acknowledged_at IS NULL THEN
    v_event := 12;
  ELSIF v_consumed AND cur.consumed_at IS NULL THEN
    v_event := 13;
  END IF;

  IF v_event IS NOT NULL THEN
    -- Revenue: the first payment, each renewal, a payment recovered after grace, account hold or a pause (a move
    -- back to active or canceled with a later expiry) and a refund carry the amount (reported, else the list price
    -- of now).
    IF v_state NOT IN (1, 11)
       AND (v_event IN (1, 2, 10)
            OR (v_state IN (2, 3) AND v_from IS NOT NULL AND v_expires > cur.expires_at)) THEN
      IF p->>'amountMicros' IS NOT NULL AND p->>'currency' IS NOT NULL THEN
        v_amount := (p->>'amountMicros')::bigint;
        v_currency := p->>'currency';
      ELSIF prod.list_price_minor IS NOT NULL THEN
        v_amount := store_minor_to_micros(prod.list_price_minor * v_qty, prod.list_currency);
        v_currency := prod.list_currency;
        v_estimated := true;
      END IF;
    END IF;
    INSERT INTO store_events (id, purchase_id, user_id, occurred_at, expires_at, amount_micros, store, event, source,
                              state_from, state_to, amount_estimated, currency, order_id)
    VALUES ((p->>'eventId')::bigint, cur.id, v_user, to_timestamp(v_event_ms / 1000.0), v_expires, v_amount, v_store, v_event,
            (p->>'source')::smallint, v_from, v_state, v_estimated, v_currency, coalesce(v_order, cur.order_id));
  END IF;

  -- A linked token (an upgrade, a downgrade, a plan change) is replaced by this one.
  IF lnk.id IS NOT NULL AND lnk.state <> 9 THEN
    v_changed := true;
    UPDATE store_purchases x SET state = 9, next_check_at = NULL, updated_at = now() WHERE x.id = lnk.id;
    INSERT INTO store_events (id, purchase_id, user_id, occurred_at, expires_at, store, event, source, state_from, state_to, order_id)
    VALUES ((p->>'linkedEventId')::bigint, lnk.id, lnk.user_id, to_timestamp(v_event_ms / 1000.0), lnk.expires_at, v_store, 11,
            (p->>'source')::smallint, lnk.state, 9, lnk.order_id);
    IF lnk.user_id IS NOT NULL AND lnk.user_id IS DISTINCT FROM v_user THEN
      PERFORM subscription_recompute(lnk.user_id, v_store);
      v_other := lnk.user_id;
      v_other_rows := entitlement_rows(lnk.user_id);
    END IF;
  END IF;

  IF v_user IS NOT NULL AND v_kind = 1 THEN
    v_sub := subscription_recompute(v_user, v_store);
    IF v_sub THEN
      v_changed := true;
    END IF;
  END IF;

  -- Consumables: credited once when verified, reversed once when refunded (never below zero).
  IF v_user IS NOT NULL AND v_kind = 2 THEN
    IF v_state IN (10, 12) AND cur.credited_at IS NULL THEN
      v_credit := prod.grant_qty * v_qty;
      INSERT INTO wallet_balances AS b (user_id, item, store, balance) VALUES (v_user, prod.grant_item, v_store, v_credit)
      ON CONFLICT (user_id, item, store) DO UPDATE SET balance = b.balance + EXCLUDED.balance, updated_at = now()
      RETURNING b.balance INTO v_balance;
      INSERT INTO wallet_ledger (id, user_id, ref_id, delta, balance_after, item, store, reason)
      VALUES ((p->>'ledgerId')::bigint, v_user, cur.id, v_credit, v_balance, prod.grant_item, v_store, 1);
      UPDATE store_purchases x SET credited_at = now() WHERE x.id = cur.id;
    ELSIF v_state = 8 AND v_from IS DISTINCT FROM 8 AND cur.credited_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM wallet_ledger l WHERE l.reason = 3 AND l.ref_id = cur.id) THEN
      SELECT b.balance INTO v_balance FROM wallet_balances b
       WHERE b.user_id = v_user AND b.item = prod.grant_item AND b.store = v_store FOR UPDATE;
      v_debited := least(coalesce(v_balance, 0), prod.grant_qty * cur.quantity);
      v_shortfall := prod.grant_qty * cur.quantity - v_debited;
      IF v_debited > 0 THEN
        UPDATE wallet_balances b SET balance = b.balance - v_debited, updated_at = now()
         WHERE b.user_id = v_user AND b.item = prod.grant_item AND b.store = v_store
        RETURNING b.balance INTO v_balance;
        INSERT INTO wallet_ledger (id, user_id, ref_id, delta, balance_after, item, store, reason)
        VALUES ((p->>'ledgerId')::bigint, v_user, cur.id, -v_debited, v_balance, prod.grant_item, v_store, 3);
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'outcome', CASE WHEN v_changed THEN 'applied' ELSE 'unchanged' END,
    'purchaseId', cur.id::text, 'userId', v_user::text, 'state', v_state, 'stateFrom', v_from,
    'created', v_created, 'event', v_event, 'productRef', prod.id, 'kind', v_kind,
    'expiresAtMs', (extract(epoch FROM v_expires) * 1000)::bigint,
    'acknowledged', v_ack OR cur.acknowledged_at IS NOT NULL,
    'consumed', v_consumed OR cur.consumed_at IS NOT NULL OR v_state = 10,
    'credited', v_credit, 'debited', v_debited, 'shortfall', v_shortfall,
    'subscriptionChanged', v_sub,
    'replaced', CASE WHEN lnk.id IS NOT NULL AND lnk.state <> 9 THEN lnk.id::text END,
    'replacedUserId', v_other::text,
    'replacedRows', v_other_rows,
    'rows', CASE WHEN v_user IS NULL THEN NULL ELSE entitlement_rows(v_user) END);
END
$$;

COMMENT ON FUNCTION store_purchase_apply(jsonb) IS
  'A verified store purchase state in one statement: the store_purchases upsert by (store, token_hash) (an event older than last_event_ms is ignored), its store_events row, the linked token replaced, the subscription recomputed, the wallet credited once or reversed once (never below zero), and entitlement_rows() of the person.';

-- ─── The worker's hourly sweep ────────────────────────────────────────────
-- Acknowledgements and consumes the server may still owe (Play subscriptions
-- not acknowledged, consumables not consumed), by purchase time: the sweep
-- reads only the last 60 hours of it. Overdue re-checks use
-- store_purchases_check_idx (0007).
CREATE INDEX store_purchases_owed_idx ON store_purchases (purchased_at)
  WHERE (kind = 1 AND store = 1 AND acknowledged_at IS NULL) OR (kind = 2 AND consumed_at IS NULL);
-- Subscriptions in a granting state without a next check (the store
-- integrations always set one; the sweep catches a row whose expiry passed).
CREATE INDEX store_purchases_unchecked_idx ON store_purchases (expires_at)
  WHERE kind = 1 AND state IN (2, 3, 4) AND next_check_at IS NULL;

REVOKE ALL ON FUNCTION entitlement_rows(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION subscription_recompute(bigint, smallint) FROM PUBLIC;
REVOKE ALL ON FUNCTION store_purchase_apply(jsonb) FROM PUBLIC;

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    GRANT EXECUTE ON FUNCTION entitlement_rows(bigint), subscription_recompute(bigint, smallint), store_purchase_apply(jsonb) TO app_rw;
  ELSE
    RAISE NOTICE 'role app_rw does not exist: grants skipped (development database?)';
  END IF;
END
$grant$;
