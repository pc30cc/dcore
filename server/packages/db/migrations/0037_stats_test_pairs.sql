-- 0037 - Statistics: a match or a call leaves the figures when either person is a test account.
--
-- 0035 left a match out only when its user_lo was a test account, and a call
-- only when its caller was. Test accounts see only each other, so the two
-- sides differ only after a flip of the flag; such a match or call is now
-- out whichever side it was. Same functions otherwise (CREATE OR REPLACE
-- keeps their owner and grants: EXECUTE for app_maint only). Each added
-- NOT IN is one more hashed SubPlan over users_test_idx (statistics
-- users_test_flag_stats, 0035). No table, index or row changes.

-- ─── Live counts (stats/live, once a minute) ──────────────────────────────
CREATE OR REPLACE FUNCTION stats_live(p_cap integer) RETURNS jsonb
  LANGUAGE plpgsql STABLE
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_day date := (now() AT TIME ZONE 'UTC')::date;
  v_lo  bigint := id_floor(v_day::timestamp AT TIME ZONE 'UTC');
  v_cap integer := greatest(coalesce(p_cap, 10000), 1) + 1;
BEGIN
  RETURN jsonb_build_object(
    'day', v_day::text,
    'signups', (SELECT count(*) FROM users u WHERE u.id >= v_lo AND (u.flags & 1) = 0),
    'matches', (SELECT count(*) FROM matches m WHERE m.id >= v_lo
                   AND m.user_lo NOT IN (SELECT t.id FROM users t WHERE (t.flags & 1) <> 0)
                   AND m.user_hi NOT IN (SELECT t.id FROM users t WHERE (t.flags & 1) <> 0)),
    'calls', (SELECT count(*) FROM calls c WHERE c.id >= v_lo
                 AND c.caller_id NOT IN (SELECT t.id FROM users t WHERE (t.flags & 1) <> 0)
                 AND c.callee_id NOT IN (SELECT t.id FROM users t WHERE (t.flags & 1) <> 0)),
    'callsAnswered', (SELECT count(*) FROM calls c WHERE c.id >= v_lo AND c.outcome = 1
                         AND c.caller_id NOT IN (SELECT t.id FROM users t WHERE (t.flags & 1) <> 0)
                         AND c.callee_id NOT IN (SELECT t.id FROM users t WHERE (t.flags & 1) <> 0)),
    'reports', (SELECT count(*) FROM reports r WHERE r.id >= v_lo AND r.reporter_id IS NOT NULL
                   AND r.reporter_id NOT IN (SELECT t.id FROM users t WHERE (t.flags & 1) <> 0)),
    'photos', (SELECT count(*) FROM (SELECT 1 FROM photos p WHERE p.status = 2 LIMIT v_cap) q),
    'texts', (SELECT count(*) FROM (SELECT x.user_id FROM (
                 SELECT p.user_id FROM profiles p
                  WHERE p.text_state = 1 AND (p.about IS NOT NULL OR p.job_title IS NOT NULL)
                 UNION
                 SELECT pp.user_id FROM profile_prompts pp WHERE pp.status = 1) x LIMIT v_cap) q),
    'reportsOpen', (SELECT count(*) FROM (SELECT 1 FROM reports r WHERE r.status IN (1, 2) LIMIT v_cap) q),
    'reportsUrgent', (SELECT count(*) FROM (SELECT 1 FROM reports r WHERE r.status IN (1, 2) AND r.reason IN (6, 8) LIMIT v_cap) q),
    'appeals', (SELECT count(*) FROM (SELECT 1 FROM appeals a WHERE a.status = 1 LIMIT v_cap) q),
    'tickets', (SELECT count(*) FROM (SELECT 1 FROM support_tickets s WHERE s.status = 1 LIMIT v_cap) q),
    'revenue', coalesce((
      SELECT jsonb_agg(jsonb_build_object('currency', g.currency, 'micros', g.micros::text, 'estimated', g.estimated) ORDER BY g.currency)
        FROM (SELECT e.currency::text AS currency, sum(e.amount_micros) AS micros, bool_or(e.amount_estimated) AS estimated
                FROM store_events e JOIN store_purchases p ON p.id = e.purchase_id
               WHERE e.id >= v_lo AND e.amount_micros IS NOT NULL AND e.event <> 10 AND NOT p.is_test
                 AND (e.user_id IS NULL OR e.user_id NOT IN (SELECT t.id FROM users t WHERE (t.flags & 1) <> 0))
               GROUP BY e.currency) g), '[]'::jsonb));
END;
$$;

-- ─── Nightly rollup (stats/rollup): matches, conversations, calls, reports ─
CREATE OR REPLACE FUNCTION stats_rollup_social(p_day date) RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_lo    bigint := id_floor(p_day::timestamp AT TIME ZONE 'UTC');
  v_hi    bigint := id_floor((p_day + 1)::timestamp AT TIME ZONE 'UTC');
  v_lo7   bigint := id_floor((p_day - 6)::timestamp AT TIME ZONE 'UTC');
  v_lo2   bigint := id_floor((p_day - 1)::timestamp AT TIME ZONE 'UTC');
  v_today bigint := id_floor((now() AT TIME ZONE 'UTC')::date::timestamp AT TIME ZONE 'UTC');
  v_n     integer;
  v_total integer := 0;
BEGIN
  DELETE FROM stats_daily WHERE metric = 'matches' AND day = p_day;
  INSERT INTO stats_daily (metric, day, dim, value)
  SELECT 'matches', p_day, m.source::text, count(*)
    FROM matches m
   WHERE m.id >= v_lo AND m.id < v_hi
     AND m.user_lo NOT IN (SELECT t.id FROM users t WHERE (t.flags & 1) <> 0)
     AND m.user_hi NOT IN (SELECT t.id FROM users t WHERE (t.flags & 1) <> 0)
   GROUP BY m.source;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;

  DELETE FROM stats_daily WHERE metric IN ('conversations', 'replied') AND day BETWEEN p_day - 6 AND p_day;
  INSERT INTO stats_daily (metric, day, dim, value)
  SELECT x.metric, x.day, '', x.n
    FROM (
      SELECT s.day, count(*) FILTER (WHERE s.lo_wrote OR s.hi_wrote) AS conversations,
             count(*) FILTER (WHERE s.lo_wrote AND s.hi_wrote) AS replied
        FROM (SELECT w.day,
                     EXISTS (SELECT 1 FROM messages x
                              WHERE x.match_id = w.id AND x.id >= w.id AND x.id < w.until
                                AND x.sender_id = w.user_lo AND x.kind BETWEEN 1 AND 4) AS lo_wrote,
                     EXISTS (SELECT 1 FROM messages x
                              WHERE x.match_id = w.id AND x.id >= w.id AND x.id < w.until
                                AND x.sender_id = w.user_hi AND x.kind BETWEEN 1 AND 4) AS hi_wrote
                FROM (SELECT m.id, m.user_lo, m.user_hi, c.day,
                             least(id_floor((c.day + 7)::timestamp AT TIME ZONE 'UTC'), v_today) AS until
                        FROM matches m
                       CROSS JOIN LATERAL (SELECT (id_time(m.id) AT TIME ZONE 'UTC')::date AS day) c
                       WHERE m.id >= v_lo7 AND m.id < v_hi
                         AND m.user_lo NOT IN (SELECT t.id FROM users t WHERE (t.flags & 1) <> 0)
                         AND m.user_hi NOT IN (SELECT t.id FROM users t WHERE (t.flags & 1) <> 0)) w) s
       GROUP BY s.day) c
   CROSS JOIN LATERAL (VALUES ('conversations', c.day, c.conversations), ('replied', c.day, c.replied)) AS x(metric, day, n)
   WHERE x.n > 0;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;

  DELETE FROM stats_daily WHERE metric IN ('calls', 'calls_answered', 'call_minutes') AND day BETWEEN p_day - 1 AND p_day;
  INSERT INTO stats_daily (metric, day, dim, value)
  SELECT x.metric, x.day, x.dim, x.n
    FROM (
      SELECT (id_time(c.id) AT TIME ZONE 'UTC')::date AS day, c.kind::text AS dim, count(*) AS calls,
             count(*) FILTER (WHERE c.outcome = 1) AS answered, sum(c.duration_s) / 60 AS minutes
        FROM calls c
       WHERE c.id >= v_lo2 AND c.id < v_hi
         AND c.caller_id NOT IN (SELECT t.id FROM users t WHERE (t.flags & 1) <> 0)
         AND c.callee_id NOT IN (SELECT t.id FROM users t WHERE (t.flags & 1) <> 0)
       GROUP BY 1, 2) g
   CROSS JOIN LATERAL (VALUES ('calls', g.day, g.dim, g.calls), ('calls_answered', g.day, g.dim, g.answered),
                              ('call_minutes', g.day, g.dim, g.minutes)) AS x(metric, day, dim, n)
   WHERE x.n > 0;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;

  DELETE FROM stats_daily WHERE metric IN ('reports', 'reports_auto') AND day = p_day;
  INSERT INTO stats_daily (metric, day, dim, value)
  SELECT CASE WHEN r.reporter_id IS NULL THEN 'reports_auto' ELSE 'reports' END, p_day, r.reason::text, count(*)
    FROM reports r
   WHERE r.id >= v_lo AND r.id < v_hi
     AND coalesce(r.reporter_id, r.target_id) NOT IN (SELECT t.id FROM users t WHERE (t.flags & 1) <> 0)
   GROUP BY 1, r.reason;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  RETURN jsonb_build_object('rows', v_total);
END;
$$;
