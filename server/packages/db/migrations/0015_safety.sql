-- 0015 - Safety: when each side of a block blocked; moderation actions the
-- server applies (what a suspension or ban returns to when it stops, and
-- penalties for accounts that never finished their basics).

-- ─── blocks: each side's time ─────────────────────────────────────────────
-- A person's block list shows when they blocked someone. created_at is the
-- pair's first block, which may be the other side's: shown to the second
-- blocker it would tell them they had been blocked first. Each side keeps
-- its own time; an unblock clears it.
ALTER TABLE blocks
  ADD COLUMN lo_at timestamptz,
  ADD COLUMN hi_at timestamptz;

UPDATE blocks
   SET lo_at = CASE WHEN (blocked_by & 1) <> 0 THEN created_at END,
       hi_at = CASE WHEN (blocked_by & 2) <> 0 THEN created_at END;

-- Kept by a trigger, so every writer of blocked_by (an upsert that adds a
-- side, an unblock that removes one) gets the times right without naming them.
CREATE FUNCTION blocks_side_times() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.lo_at := CASE WHEN (NEW.blocked_by & 1) = 0 THEN NULL
                    WHEN TG_OP = 'UPDATE' AND (OLD.blocked_by & 1) <> 0 THEN coalesce(OLD.lo_at, NEW.lo_at, now())
                    ELSE coalesce(NEW.lo_at, now()) END;
  NEW.hi_at := CASE WHEN (NEW.blocked_by & 2) = 0 THEN NULL
                    WHEN TG_OP = 'UPDATE' AND (OLD.blocked_by & 2) <> 0 THEN coalesce(OLD.hi_at, NEW.hi_at, now())
                    ELSE coalesce(NEW.hi_at, now()) END;
  RETURN NEW;
END
$$;

CREATE TRIGGER blocks_side_times BEFORE INSERT OR UPDATE ON blocks
  FOR EACH ROW EXECUTE FUNCTION blocks_side_times();

ALTER TABLE blocks
  ADD CONSTRAINT blocks_side_times CHECK (((blocked_by & 1) <> 0) = (lo_at IS NOT NULL)
                                          AND ((blocked_by & 2) <> 0) = (hi_at IS NOT NULL));

COMMENT ON COLUMN blocks.lo_at IS 'When user_lo blocked user_hi (NULL while blocked_by has no bit 1).';
COMMENT ON COLUMN blocks.hi_at IS 'When user_hi blocked user_lo (NULL while blocked_by has no bit 2).';

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_ro') THEN
    GRANT SELECT (lo_at, hi_at) ON blocks TO app_ro;
  END IF;
END
$grant$;

-- users.status holds the current effect of the penalties
-- (moderation_actions is the record): 5 while a suspension stands, 6 while a
-- ban stands, is_shadowbanned while a shadowban stands. When one stops (it is
-- lifted, overturned on appeal, or a suspension ends), the account returns
-- to the status it had before the penalties began, unless another penalty
-- still stands.

-- ─── moderation_actions.prior_status ──────────────────────────────────────
ALTER TABLE moderation_actions
  ADD COLUMN prior_status smallint CHECK (prior_status BETWEEN 1 AND 7);

COMMENT ON COLUMN moderation_actions.prior_status IS
  'users.status when the action was applied (suspensions and bans; NULL for the other kinds). The status an account returns to is the prior_status of its newest suspension or ban that began outside a penalty (1-4), so penalties that overlap unwind in any order.';

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_ro') THEN
    GRANT SELECT (prior_status) ON moderation_actions TO app_ro;
  END IF;
END
$grant$;

-- ─── Penalties of accounts in onboarding ──────────────────────────────────
-- A ban or a suspension must also reach an account that never finished its
-- basics (a spam sign-up): statuses 5 and 6 no longer require a birth date
-- and gender. Every other status keeps the rule. Checked without a long
-- lock: the new constraint is added NOT VALID, then validated.
ALTER TABLE users DROP CONSTRAINT users_profile_after_onboarding;
ALTER TABLE users
  ADD CONSTRAINT users_profile_after_onboarding
  CHECK (status IN (1, 5, 6, 7, 8) OR (birth_date IS NOT NULL AND gender IS NOT NULL)) NOT VALID;
ALTER TABLE users VALIDATE CONSTRAINT users_profile_after_onboarding;

-- ─── Standing penalties ───────────────────────────────────────────────────
-- An action stands while it is not revoked and its period covers now.
CREATE FUNCTION moderation_standing(p_user bigint, p_kind smallint, p_except bigint) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  RETURN EXISTS (SELECT 1 FROM moderation_actions a
                  WHERE a.user_id = p_user AND a.kind = p_kind AND a.revoked_at IS NULL
                    AND a.id IS DISTINCT FROM p_except
                    AND a.starts_at <= now() AND (a.ends_at IS NULL OR a.ends_at > now()));

-- The users.status an account in status 5 or 6 takes when the action
-- p_except stops standing (NULL: none stops; the standing ones decide):
-- 6 while another ban stands, 5 while another suspension stands, else the
-- status before its penalties began (active when unknown).
CREATE FUNCTION moderation_resting_status(p_user bigint, p_except bigint) RETURNS smallint
  LANGUAGE sql STABLE PARALLEL SAFE
  RETURN (CASE
            WHEN moderation_standing(p_user, 3::smallint, p_except) THEN 6
            WHEN moderation_standing(p_user, 2::smallint, p_except) THEN 5
            ELSE coalesce((SELECT a.prior_status FROM moderation_actions a
                            WHERE a.user_id = p_user AND a.kind IN (2, 3) AND a.prior_status BETWEEN 1 AND 4
                            ORDER BY a.id DESC
                            LIMIT 1), 3)
          END)::smallint;
