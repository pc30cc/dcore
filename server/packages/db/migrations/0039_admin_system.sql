-- 0039 - Admin: jobs and health (the partitions overview) and the rules of
-- the role editor, kept by the database too.
--
-- partitions_overview(): every partition of every registered parent, read
-- from the catalog only: its bounds, the planner's estimates (reltuples,
-- relpages: no scan) and the age of its relfrozenxid. It opens no
-- relation, so it never waits behind a lock on a partition or a parent (a
-- VACUUM FULL, REINDEX or ALTER run by hand): both bounds are parsed from
-- pg_get_expr(relpartbound, 0), which reads the catalog row only, whereas
-- the partition's oid as its second argument (as partition_upper_id()
-- passes it) opens the partition with AccessShareLock. Partitions live in
-- schema part, which no application role may name; pg_class and
-- pg_inherits are readable by every role, so the function needs no
-- privilege of its own. One statement for the panel's partitions card.
--
-- admin_role_rules(): the role editor's rules, checked on every row written
-- to admin_role_permissions and on every change of admin_roles, so a bug, a
-- hand-written statement or a later migration cannot break them:
--   - the owner role (key superadmin) holds '*' for good: its grants are
--     never added, changed or removed, and the role is never renamed or
--     deleted (HINT owner_role);
--   - '*' is never granted to any other role (HINT owner_grant);
--   - users.chats (a person's conversations) is held by the admin role only
--     (HINT chats_admin_only); '*' covers it too, which the rule above keeps
--     with the owner role;
--   - the analyst role holds dashboard permissions only (dashboard.* or a
--     dashboard.<verb>; HINT analyst_dashboards_only);
--   - the keys these rules name (superadmin, admin, analyst) are never given
--     to another role or taken from theirs (HINT role_key).
-- Rows that broke a rule before this migration are left as they are and
-- named in a WARNING; the editor refuses to keep them. The trigger does not
-- fire on TRUNCATE (no application role may truncate these tables).
--
-- No table, column or index; no audit_log change (the role and system
-- writes use the existing targets config and none); no seed. Idempotent.

-- ─── Partitions ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION partitions_overview()
RETURNS TABLE (parent text, period text, premake smallint,
               retention_months integer, retention_days integer,
               partition_name text, from_ms bigint, to_ms bigint, drop_after_ms bigint,
               rows_estimate bigint, bytes_estimate bigint, xid_age integer)
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT p.parent, p.period, p.premake,
         CASE WHEN p.retention IS NULL THEN NULL
              ELSE (extract(year FROM p.retention) * 12 + extract(month FROM p.retention))::integer END,
         CASE WHEN p.retention IS NULL THEN NULL ELSE extract(day FROM p.retention)::integer END,
         c.relname::text,
         id_ms(lo.id), id_ms(hi.id),
         CASE WHEN p.retention IS NULL OR hi.id IS NULL THEN NULL
              ELSE (extract(epoch FROM id_time(hi.id) + p.retention) * 1000)::bigint END,
         CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END,
         c.relpages::bigint * current_setting('block_size')::bigint,
         age(c.relfrozenxid)
    FROM partitioned_tables p
    JOIN pg_inherits i ON i.inhparent = to_regclass(format('public.%I', p.parent))
    JOIN pg_class c ON c.oid = i.inhrelid
    -- The bound has no column references, so no relation is named (0): the partition is not opened.
    CROSS JOIN LATERAL (SELECT pg_get_expr(c.relpartbound, 0) AS expr) b
    CROSS JOIN LATERAL (SELECT (regexp_match(b.expr, 'FROM \(''?(-?[0-9]+)''?\)'))[1]::bigint AS id) lo
    CROSS JOIN LATERAL (SELECT (regexp_match(b.expr, 'TO \(''?(-?[0-9]+)''?\)'))[1]::bigint AS id) hi
   ORDER BY p.parent, c.relname
$$;

COMMENT ON FUNCTION partitions_overview() IS
  'Every partition of the parents in partitioned_tables, from the catalog: bounds (epoch ms of the ids), the drop time its parent''s retention gives (NULL: kept), the planner''s row and size estimates (rows NULL before the first ANALYZE) and age(relfrozenxid). Opens no relation (bounds from pg_get_expr(relpartbound, 0)), so it never waits behind a lock on a partition or a parent, and scans none. EXECUTE for app_rw.';

REVOKE ALL ON FUNCTION partitions_overview() FROM PUBLIC;

-- ─── The role editor's rules ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION admin_role_rules() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_key text;
BEGIN
  IF TG_TABLE_NAME = 'admin_roles' THEN
    IF TG_OP = 'DELETE' THEN
      IF OLD.key = 'superadmin' THEN
        RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'the owner role cannot be deleted', HINT = 'owner_role';
      END IF;
      RETURN OLD;
    END IF;
    IF NEW.key IS DISTINCT FROM OLD.key THEN
      IF OLD.key = 'superadmin' THEN
        RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'the owner role cannot be renamed', HINT = 'owner_role';
      END IF;
      IF OLD.key IN ('admin', 'analyst') OR NEW.key IN ('superadmin', 'admin', 'analyst') THEN
        RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = format('the role key %s is named by the role rules and cannot move', OLD.key), HINT = 'role_key';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- admin_role_permissions
  IF TG_OP <> 'INSERT' THEN
    SELECT r.key INTO v_key FROM admin_roles r WHERE r.id = OLD.role_id;
    IF v_key = 'superadmin' THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'the owner role always holds every permission', HINT = 'owner_role';
    END IF;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
  END IF;
  SELECT r.key INTO v_key FROM admin_roles r WHERE r.id = NEW.role_id;
  IF v_key = 'superadmin' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'the owner role always holds every permission', HINT = 'owner_role';
  END IF;
  IF NEW.permission = '*' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = format('''*'' belongs to the owner role only, not to %s', v_key), HINT = 'owner_grant';
  END IF;
  IF NEW.permission = 'users.chats' AND v_key IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = format('users.chats is held by the admin role only, not by %s', v_key), HINT = 'chats_admin_only';
  END IF;
  IF v_key = 'analyst' AND NEW.permission NOT LIKE 'dashboard.%' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = format('the analyst role holds dashboard permissions only, not %s', NEW.permission), HINT = 'analyst_dashboards_only';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION admin_role_rules() IS
  'The role editor''s rules (0039), on admin_role_permissions (INSERT, UPDATE, DELETE) and admin_roles (UPDATE, DELETE): the owner role (superadmin) never changes; ''*'' is never granted to another role; users.chats only on the admin role; the analyst role holds dashboard.* permissions only; the keys superadmin, admin and analyst never move. Refusals raise check_violation with the rule in HINT (owner_role, owner_grant, chats_admin_only, analyst_dashboards_only, role_key).';

DROP TRIGGER IF EXISTS admin_role_permissions_rules ON admin_role_permissions;
CREATE TRIGGER admin_role_permissions_rules
  BEFORE INSERT OR UPDATE OR DELETE ON admin_role_permissions
  FOR EACH ROW EXECUTE FUNCTION admin_role_rules();

DROP TRIGGER IF EXISTS admin_roles_rules ON admin_roles;
CREATE TRIGGER admin_roles_rules
  BEFORE UPDATE OR DELETE ON admin_roles
  FOR EACH ROW EXECUTE FUNCTION admin_role_rules();

-- Rows written before the rules existed are named, never changed.
DO $check$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT ro.key, p.permission
      FROM admin_role_permissions p
      JOIN admin_roles ro ON ro.id = p.role_id
     WHERE (p.permission = '*' AND ro.key <> 'superadmin')
        OR (p.permission = 'users.chats' AND ro.key <> 'admin')
        OR (ro.key = 'analyst' AND p.permission NOT LIKE 'dashboard.%')
     ORDER BY ro.id, p.permission
  LOOP
    RAISE WARNING 'admin role % holds %, which the role rules no longer allow: remove it in the role editor', r.key, r.permission;
  END LOOP;
END
$check$;

-- ─── Grants ───────────────────────────────────────────────────────────────
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    GRANT EXECUTE ON FUNCTION partitions_overview() TO app_rw;
  ELSE
    RAISE NOTICE 'role app_rw does not exist: grants skipped';
  END IF;
END
$grants$;
