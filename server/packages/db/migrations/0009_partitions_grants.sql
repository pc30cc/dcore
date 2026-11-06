-- 0009 - The first partitions, partition retention, and the privileges of
-- the application roles.
--
-- Roles are cluster objects with passwords, so they are not created here:
-- the operator creates them once. This file grants to the group roles when
-- they exist and says so when they do not (a development database may run
-- everything as the schema's own role):
--
--   app_rw     NOLOGIN group of the API and worker login roles: DML on the
--              application tables in public, except UPDATE/DELETE on the
--              append-only ledgers and DELETE on legal holds and filings.
--   app_maint  NOLOGIN group of the worker's login role only: EXECUTE on
--              partitions_maintain() and partition_drop_expired(). The API
--              cannot run partition maintenance.
--   app_ro     NOLOGIN group for analysts and a read replica's reporting
--              user: SELECT through column grants, never on secrets
--              (tokens, hashes, encrypted numbers, admin credentials), never
--              on what people wrote (messages, requests, like comments,
--              prompts, profile text, report evidence, appeals, support
--              threads, moderation notes, audit details), and never on
--              special-category or location data (cells, centres, cities,
--              gender preferences, sensitive profile fields). Tables created
--              by later migrations get nothing until they grant explicitly.
--
-- Partitions live in the schema `part` (0001), where no role has USAGE, so
-- every grant below applies through the parent tables only.

-- ─── Retention ────────────────────────────────────────────────────────────
-- Drops the oldest partition of p_parent whose upper bound is older than the
-- registered retention, at most one per call (each drop takes ACCESS
-- EXCLUSIVE on the parent; with a 200 ms lock_timeout a reader holding the
-- parent delays the drop by a day, never the traffic behind it by more than
-- that). Returns `dropped`, `drop_deferred` (lock timeout) or nothing when
-- nothing is due; the worker calls again while it gets `dropped`.
-- A messages partition that still holds rows of a conversation under an
-- active legal hold whose messages were not yet copied into the report
-- evidence is reported `drop_held` and kept.
CREATE FUNCTION partition_drop_expired(p_parent text) RETURNS TABLE (action text, partition_name text)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  SET lock_timeout = '200ms'
AS $$
DECLARE
  v_reg   partitioned_tables;
  v_cut   bigint;
  v_child record;
  v_held  boolean;
BEGIN
  SELECT * INTO STRICT v_reg FROM partitioned_tables WHERE parent = p_parent;
  IF v_reg.retention IS NULL THEN
    RETURN;
  END IF;
  v_cut := id_floor(now() - v_reg.retention);
  FOR v_child IN
    SELECT c.oid::regclass AS rel, c.relname
      FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = format('public.%I', v_reg.parent)::regclass
     ORDER BY c.relname
  LOOP
    CONTINUE WHEN partition_upper_id(v_child.rel) > v_cut;
    partition_name := v_child.relname;
    IF v_reg.parent = 'messages' THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM legal_holds h
                                      WHERE h.released_at IS NULL AND h.match_id IS NOT NULL
                                        AND h.evidence_copied_at IS NULL
                                        AND EXISTS (SELECT 1 FROM %s m WHERE m.match_id = h.match_id))',
                     v_child.rel)
        INTO v_held;
      IF v_held THEN
        action := 'drop_held';
        RETURN NEXT;
        CONTINUE;
      END IF;
    END IF;
    BEGIN
      EXECUTE format('DROP TABLE %s', v_child.rel);
      action := 'dropped';
    EXCEPTION WHEN lock_not_available THEN
      action := 'drop_deferred';
    END;
    RETURN NEXT;
    RETURN;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION partition_drop_expired(text) FROM PUBLIC;

-- The current period and the periods ahead, for every registered table.
SELECT p.parent, m.action, count(*) AS partitions
  FROM partitioned_tables p, LATERAL partitions_maintain(p.parent) m
 GROUP BY p.parent, m.action;

-- ─── The analytics view of profile fields ─────────────────────────────────
-- Choice and number values of fields that are not special categories; free
-- text is left out. app_ro reads this view, never profile_field_values.
CREATE VIEW field_values_ro WITH (security_barrier) AS
  SELECT v.user_id, v.field_id, v.num, v.opt, v.opts
    FROM profile_field_values v
    JOIN profile_field_defs f ON f.id = v.field_id
   WHERE NOT f.is_sensitive;

-- ─── Grants ───────────────────────────────────────────────────────────────
DO $grants$
DECLARE
  r      record;
  v_cols text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    GRANT USAGE ON SCHEMA public TO app_rw;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rw;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rw;
    -- Append-only ledgers: rows are added, never changed or removed by the app.
    REVOKE UPDATE, DELETE, TRUNCATE ON store_events, wallet_ledger, audit_log FROM app_rw;
    -- Holds are released and filings kept: never deleted by the app.
    REVOKE DELETE, TRUNCATE ON legal_holds, report_filings FROM app_rw;
    -- The partition registry and the migration ledger belong to the schema's role.
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON partitioned_tables, _schema_migrations FROM app_rw;
    -- Tables created later in public get the same DML grants (partitions do
    -- not: they are created in part).
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_rw;
  ELSE
    RAISE NOTICE 'role app_rw does not exist: grants skipped (development database?)';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_maint') THEN
    GRANT EXECUTE ON FUNCTION partitions_maintain(text), partition_drop_expired(text) TO app_maint;
  ELSE
    RAISE NOTICE 'role app_maint does not exist: grants skipped';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_ro') THEN
    GRANT USAGE ON SCHEMA public TO app_ro;
    -- Every column of every table and view in public except the ones listed
    -- ('*' = the whole table). Objects that belong to an extension (PostGIS)
    -- are left alone.
    FOR r IN
      SELECT c.oid, c.relname, d.deny
        FROM pg_class c
        LEFT JOIN (VALUES
          ('auth_identities',      '{subject_hash,subject_enc}'::text[]),
          ('sessions',             '{refresh_hash,prev_hash}'),
          ('devices',              '{push_token,push_token_hash,fingerprint_hash}'),
          ('store_purchases',      '{token,token_hash,linked_token_hash}'),
          ('admin_users',          '{email,password_hash,totp_secret_enc,failed_logins,locked_until,totp_enabled_at}'),
          ('admin_passkeys',       '{*}'),
          ('admin_sessions',       '{*}'),
          ('app_config',           '{value}'),
          ('messages',             '{body}'),
          ('message_requests',     '{body}'),
          ('likes',                '{comment}'),
          ('reports',              '{details,evidence}'),
          ('appeals',              '{body,decision_text}'),
          ('moderation_actions',   '{reason_text,note}'),
          ('support_tickets',      '{subject}'),
          ('support_messages',     '{body,attachments}'),
          ('audit_log',            '{ip,detail}'),
          ('entitlement_grants',   '{reason}'),
          ('device_bans',          '{value_hash,reason}'),
          ('blocks',               '{user_lo,user_hi}'),
          ('legal_holds',          '{*}'),
          ('report_filings',       '{*}'),
          ('profiles',             '{display_name,about,job_title}'),
          ('profile_prompts',      '{answer}'),
          ('profile_field_values', '{*}'),
          ('photos',               '{blurhash}'),
          ('verifications',        '{provider_ref}'),
          ('preferences',          '{interested_in,filters}'),
          ('user_locations',       '{home_h3,travel_h3,home_geo,travel_geo,home_city_id,travel_city_id,travel_country,travel_until}'),
          ('discovery',            '{h3_r7,h3_r5,h3_r3,geo,city_id,interested_in,attrs}')
        ) AS d(relname, deny) ON d.relname = c.relname
       WHERE c.relnamespace = 'public'::regnamespace
         AND c.relkind IN ('r', 'p', 'v')
         AND NOT EXISTS (SELECT 1 FROM pg_depend e
                          WHERE e.classid = 'pg_class'::regclass AND e.objid = c.oid AND e.deptype = 'e')
       ORDER BY c.relname
    LOOP
      CONTINUE WHEN r.deny = '{*}';
      SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum)
        INTO v_cols
        FROM pg_attribute a
       WHERE a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped
         AND a.attname <> ALL (coalesce(r.deny, '{}'));
      IF v_cols IS NOT NULL THEN
        EXECUTE format('GRANT SELECT (%s) ON public.%I TO app_ro', v_cols, r.relname);
      END IF;
    END LOOP;
  ELSE
    RAISE NOTICE 'role app_ro does not exist: grants skipped';
  END IF;
END
$grants$;
