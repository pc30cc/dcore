import { execute, maybeOne, one, sql } from '../query.js';
import { defineQuery } from './define.js';

/**
 * Calls in PostgreSQL. A live call is never here (it is a Valkey hash);
 * what is here: the pair a placement checks when its caches are cold, the
 * finished call with its line in the chat (one transaction, written once),
 * and the RTC settings the admin panel saves.
 */

export interface CallPairRow {
  id: string;
  lo: string;
  hi: string;
  /** matches.state (1 active). */
  state: number;
  /** matches.flags (1/2: user_lo/user_hi allow calls). */
  flags: number;
  source: number;
  /** The visibility rule of conversations (context 2), both ways. */
  loSeesHi: boolean;
  hiSeesLo: boolean;
}

/** A conversation and whether its two people may see each other there: one statement. */
export const callPair = defineQuery({ name: 'calls.pair', statements: 1 }, async (db, matchId: string): Promise<CallPairRow | null> => {
  const row = await maybeOne<{ id: string; lo: string; hi: string; state: number; flags: number; source: number; lo_sees_hi: boolean; hi_sees_lo: boolean }>(
    db,
    sql`SELECT m.id::text AS id, m.user_lo::text AS lo, m.user_hi::text AS hi, m.state, m.flags, m.source,
               can_see(m.user_lo, m.user_hi, 2) AS lo_sees_hi, can_see(m.user_hi, m.user_lo, 2) AS hi_sees_lo
          FROM matches m
         WHERE m.id = ${matchId}::bigint`,
  );
  if (!row) return null;
  return {
    id: row.id,
    lo: row.lo,
    hi: row.hi,
    state: Number(row.state),
    flags: Number(row.flags),
    source: Number(row.source),
    loSeesHi: row.lo_sees_hi === true,
    hiSeesLo: row.hi_sees_lo === true,
  };
});

export interface FinishedCallRow {
  id: string;
  matchId: string;
  callerId: string;
  calleeId: string;
  rangAtMs: number | null;
  answeredAtMs: number | null;
  endedAtMs: number;
  durationSeconds: number;
  /** calls.kind, calls.outcome, calls.ended_by, calls.end_reason codes. */
  kind: number;
  outcome: number;
  endedBy: number;
  endReason: number;
  relayed: boolean;
}

export interface CallLineRow {
  id: string;
  /** The summary JSON (callLine.ts). */
  body: string;
}

/**
 * The finished call and its line in the chat (messages kind 5, from the
 * caller, ref = the call): two INSERTs, run by the caller inside one
 * transaction. The line goes in only with a new call row, so a replay
 * writes nothing and sends one statement, which reads back the line an
 * earlier run wrote (`lineId`: the line of this call as it is stored, null
 * when there is none). The caller mints `line.id` right before each try: a
 * try that did not commit leaves no id behind, and one that did is found by
 * the next. A conversation purged meanwhile gets neither row. `active`
 * says whether the conversation is still active (read with the first
 * statement): a line of a conversation that ended is stored, never shown.
 */
export const writeFinishedCall = defineQuery(
  { name: 'calls.writeFinished', statements: 2 },
  async (tx, call: FinishedCallRow, line: CallLineRow): Promise<{ call: boolean; line: boolean; lineId: string | null; active: boolean }> => {
    const ms = (value: number | null) => (value === null ? null : new Date(value).toISOString());
    const first = await one<{ inserted: boolean; kept: string | null; match_state: number | null }>(
      tx,
      sql`WITH ins AS (
            INSERT INTO calls (id, match_id, caller_id, callee_id, rang_at, answered_at, ended_at, duration_s,
                               kind, outcome, ended_by, end_reason, relayed)
            SELECT ${call.id}::bigint, m.id, ${call.callerId}::bigint, ${call.calleeId}::bigint,
                   ${ms(call.rangAtMs)}::timestamptz, ${ms(call.answeredAtMs)}::timestamptz, ${ms(call.endedAtMs)}::timestamptz,
                   ${call.durationSeconds}::integer, ${call.kind}::smallint, ${call.outcome}::smallint, ${call.endedBy}::smallint,
                   ${call.endReason}::smallint, ${call.relayed}::boolean
              FROM matches m
             WHERE m.id = ${call.matchId}::bigint
            ON CONFLICT (id) DO NOTHING
            RETURNING id
          )
          SELECT EXISTS (SELECT 1 FROM ins) AS inserted,
                 -- A replay: the line an earlier run wrote (minted after the call ended; a day of clock slack).
                 (SELECT l.id::text FROM messages l
                   WHERE NOT EXISTS (SELECT 1 FROM ins)
                     AND l.match_id = ${call.matchId}::bigint AND l.kind = 5 AND l.ref_id = ${call.id}::bigint
                     AND l.id >= id_floor(${ms(call.endedAtMs)}::timestamptz - interval '1 day')
                   ORDER BY l.id LIMIT 1) AS kept,
                 (SELECT m.state FROM matches m WHERE m.id = ${call.matchId}::bigint) AS match_state`,
    );
    const active = Number(first.match_state) === 1;
    if (!first.inserted) return { call: false, line: false, lineId: first.kept, active };
    const lines = await execute(
      tx,
      sql`INSERT INTO messages (match_id, id, sender_id, ref_id, kind, flags, body)
          SELECT m.id, ${line.id}::bigint, ${call.callerId}::bigint, ${call.id}::bigint, 5, 0, ${line.body}::text
            FROM matches m
           WHERE m.id = ${call.matchId}::bigint
          ON CONFLICT (match_id, id) DO NOTHING`,
    );
    return { call: true, line: lines === 1, lineId: lines === 1 ? line.id : null, active };
  },
);

/** The stored RTC settings (app_config `providers.rtc`), or null when none were saved. */
export const rtcSettingsValue = defineQuery({ name: 'calls.rtcSettings', statements: 1 }, async (db, key: string): Promise<unknown> => {
  const row = await maybeOne<{ value: unknown }>(db, sql`SELECT c.value FROM app_config c WHERE c.key = ${key}::text`);
  return row?.value ?? null;
});

/** The stored RTC settings, locked for the save that follows in the same transaction. */
export const rtcSettingsForUpdate = defineQuery({ name: 'calls.rtcSettingsForUpdate', statements: 1 }, async (tx, key: string): Promise<unknown> => {
  const row = await maybeOne<{ value: unknown }>(tx, sql`SELECT c.value FROM app_config c WHERE c.key = ${key}::text FOR UPDATE`);
  return row?.value ?? null;
});

export interface ConfigAudit {
  auditId: string;
  adminId: number | null;
  sessionId: string | null;
  ip: string | null;
  /** What changed, by name only: never a value. */
  detail: Record<string, unknown>;
}

/** Saves an app_config value and its audit row (config.update) in one statement. */
export const saveConfigWithAudit = defineQuery(
  { name: 'calls.saveConfigWithAudit', statements: 1 },
  async (tx, key: string, value: unknown, audit: ConfigAudit): Promise<void> => {
    await execute(
      tx,
      sql`WITH saved AS (
            INSERT INTO app_config (key, value, updated_at, updated_by)
            VALUES (${key}::text, ${JSON.stringify(value)}::jsonb, now(), ${audit.adminId}::integer)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by
            RETURNING key)
          INSERT INTO audit_log (id, target_id, session_id, admin_id, target_type, ip, action, detail)
          SELECT ${audit.auditId}::bigint, NULL, ${audit.sessionId}::bigint, ${audit.adminId}::integer, 6, ${audit.ip}::inet,
                 'config.update', ${JSON.stringify({ key, ...audit.detail })}::jsonb
            FROM saved`,
    );
  },
);
