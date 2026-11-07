import { z } from 'zod';
import { many, maybeOne, one, query, sql, type Queryable } from '../query.js';
import { defineQuery } from './define.js';

/**
 * Sign-in, sessions and the refusals that go with them (auth_identities,
 * devices, sessions, device_bans, users). Subjects are only ever keyed
 * hashes (and the phone number sealed); tokens only SHA-256 hashes.
 *
 * Codes: auth_identities.provider 1 phone, 2 Google; device_bans.kind 1
 * device key, 2 phone, 3 Google account; sessions.revoke_reason as in
 * 0002's comment. Times leave as epoch milliseconds.
 */

const id = z.string().regex(/^[1-9][0-9]{0,18}$/);
const epochMs = z.number().int().nonnegative();

/** One keyed hash under one pepper. */
export interface HashedValue {
  kid: number;
  hash: Buffer;
}

// ─── Restrictions ──────────────────────────────────────────────────────────

/** The suspension or ban behind status 5 or 6: the newest active one, with what the person sees. */
export const restrictionSchema = z.object({
  actionId: id,
  kind: z.number().int(),
  reasonText: z.string(),
  endsAtMs: epochMs.optional(),
  appealable: z.boolean(),
});
export type Restriction = z.infer<typeof restrictionSchema>;

/**
 * The SQL of a user's account state, as a jsonb `state`: status,
 * onboarding step, flags, the deletion's purge time (status 7, from
 * app_config `retention.deleted_account_days`) and the active restriction
 * (status 5 or 6). `u` is the users row in the surrounding statement.
 */
const accountState = sql`jsonb_strip_nulls(jsonb_build_object(
    'status', u.status,
    'onboardingStep', u.onboarding_step,
    'flags', u.flags,
    'purgeAtMs', CASE WHEN u.status = 7 THEN (extract(epoch FROM u.deleted_at + make_interval(days => coalesce(
        (SELECT (c.value #>> '{}')::integer FROM app_config c WHERE c.key = 'retention.deleted_account_days'), 30))) * 1000)::bigint END,
    'restriction', CASE WHEN u.status IN (5, 6) THEN (
      SELECT jsonb_strip_nulls(jsonb_build_object(
               'actionId', a.id::text,
               'kind', a.kind,
               'reasonText', a.reason_text,
               'endsAtMs', (extract(epoch FROM a.ends_at) * 1000)::bigint,
               'appealable', NOT EXISTS (SELECT 1 FROM appeals ap WHERE ap.action_id = a.id)))
        FROM moderation_actions a
       WHERE a.user_id = u.id AND a.revoked_at IS NULL
         AND ((a.kind = 3 AND u.status = 6) OR (a.kind = 2 AND u.status = 5 AND a.ends_at > now()))
       ORDER BY a.id DESC
       LIMIT 1) END))`;

export const accountStateSchema = z.object({
  status: z.number().int().min(1).max(8),
  onboardingStep: z.number().int().min(0).max(50),
  flags: z.number().int(),
  purgeAtMs: epochMs.optional(),
  restriction: restrictionSchema.optional(),
});
export type AccountState = z.infer<typeof accountStateSchema>;

/** A user's status and, when restricted or deleted, why and until when. Null when there is no such user. */
export const accountRestriction = defineQuery(
  { name: 'auth.restriction', statements: 1 },
  async (db, userId: string): Promise<AccountState | null> => {
    const row = await maybeOne<{ state: unknown }>(db, sql`SELECT ${accountState} AS state FROM users u WHERE u.id = ${userId}::bigint`);
    return row ? accountStateSchema.parse(row.state) : null;
  },
);

// ─── Sign-in ───────────────────────────────────────────────────────────────

export interface SignInLookupInput {
  /** 1 phone, 2 Google. */
  provider: 1 | 2;
  /** The subject's hash under every pepper (current first). */
  subjectHashes: readonly Buffer[];
  /** The device key's hash under every pepper. */
  deviceHashes: readonly Buffer[];
  /** The store code of the build signing in (device-key bans name their build). */
  store: number;
}

export interface SignInIdentity {
  identityId: string;
  userId: string;
  hashKid: number;
  state: AccountState;
}

export interface SignInLookup {
  /** The account the subject signs in to, or null (a new account; a purged account counts as none). */
  identity: SignInIdentity | null;
  /** A purged account still holding this subject: the new account takes the identity over. */
  tombstoneIdentityId: string | null;
  /** Active bans that refuse this sign-in: device_bans kinds (1 device, 2 phone, 3 Google). */
  bans: number[];
}

/**
 * One statement: the identity (with its account's state) and the active
 * bans of the subject and of this build's device key.
 */
export const signInLookup = defineQuery({ name: 'auth.signInLookup', statements: 1 }, async (db, input: SignInLookupInput): Promise<SignInLookup> => {
  const banKind = input.provider === 1 ? 2 : 3;
  const row = await one<{ identity: unknown; tombstone: string | null; bans: number[] | null }>(
    db,
    sql`SELECT
          (SELECT jsonb_build_object('identityId', ai.id::text, 'userId', ai.user_id::text, 'hashKid', ai.hash_kid, 'state', ${accountState})
             FROM auth_identities ai JOIN users u ON u.id = ai.user_id
            WHERE ai.provider = ${input.provider} AND ai.subject_hash = ANY(${input.subjectHashes}::bytea[]) AND u.status <> 8
            ORDER BY ai.id
            LIMIT 1) AS identity,
          (SELECT ai.id::text
             FROM auth_identities ai JOIN users u ON u.id = ai.user_id
            WHERE ai.provider = ${input.provider} AND ai.subject_hash = ANY(${input.subjectHashes}::bytea[]) AND u.status = 8
            LIMIT 1) AS tombstone,
          (SELECT array_agg(DISTINCT b.kind ORDER BY b.kind)
             FROM device_bans b
            WHERE (b.expires_at IS NULL OR b.expires_at > now())
              AND ((b.kind = ${banKind} AND b.value_hash = ANY(${input.subjectHashes}::bytea[]))
                OR (b.kind = 1 AND b.store = ${input.store} AND b.value_hash = ANY(${input.deviceHashes}::bytea[])))) AS bans`,
  );
  const identity =
    row.identity === null
      ? null
      : z.object({ identityId: id, userId: id, hashKid: z.number().int(), state: accountStateSchema }).parse(row.identity);
  return { identity, tombstoneIdentityId: row.tombstone, bans: row.bans ?? [] };
});

export interface DeviceInput {
  /** A fresh id, used when the device row is new. */
  newId: string;
  /** The device key's hash under the current pepper (devices.fingerprint_hash). */
  fingerprint: Buffer;
  store: number;
  appVersion: number;
  locale: string | null;
}

export interface SessionInput {
  id: string;
  /** SHA-256 of the refresh token. */
  refreshHash: Buffer;
  idleDays: number;
  store: number;
  appVersion: number;
}

export interface CreatedSession {
  sessionId: string;
  deviceId: string;
  expiresAtMs: number;
}

/**
 * Signs in to an existing account, inside the caller's transaction (3
 * statements): the device row (found by its key, else created; written only
 * when something changed), the session, the identity's last use.
 */
export const signInExisting = defineQuery(
  { name: 'auth.signInExisting', statements: 3 },
  async (tx, input: { userId: string; identityId: string; device: DeviceInput; session: SessionInput }): Promise<CreatedSession> => {
    const deviceId = await upsertDevice(tx, input.userId, input.device);
    const session = await insertSession(tx, input.userId, deviceId, input.session);
    await query(tx, sql`UPDATE auth_identities SET last_used_at = now() WHERE id = ${input.identityId}::bigint`);
    return session;
  },
);

async function upsertDevice(tx: Queryable, userId: string, device: DeviceInput): Promise<string> {
  const row = await one<{ id: string }>(
    tx,
    sql`WITH found AS (
          SELECT d.id FROM devices d
           WHERE d.user_id = ${userId}::bigint AND d.fingerprint_hash = ${device.fingerprint} AND d.store = ${device.store}
           ORDER BY d.id DESC
           LIMIT 1
             FOR UPDATE
        ), changed AS (
          UPDATE devices d
             SET app_version = ${device.appVersion}, locale = ${device.locale}, disabled_at = NULL, updated_at = now()
            FROM found
           WHERE d.id = found.id
             AND (d.app_version, d.locale, d.disabled_at) IS DISTINCT FROM (${device.appVersion}::integer, ${device.locale}::text, NULL::timestamptz)
        ), created AS (
          INSERT INTO devices (id, user_id, app_version, platform, store, fingerprint_hash, locale)
          SELECT ${device.newId}::bigint, ${userId}::bigint, ${device.appVersion}, 1, ${device.store}, ${device.fingerprint}, ${device.locale}
           WHERE NOT EXISTS (SELECT 1 FROM found)
          RETURNING id
        )
        SELECT id::text FROM found UNION ALL SELECT id::text FROM created`,
  );
  return row.id;
}

async function insertSession(tx: Queryable, userId: string, deviceId: string, session: SessionInput): Promise<CreatedSession> {
  const row = await one<{ expires_ms: string }>(
    tx,
    sql`INSERT INTO sessions (id, user_id, device_id, expires_at, store, refresh_hash, app_version)
        VALUES (${session.id}::bigint, ${userId}::bigint, ${deviceId}::bigint, now() + make_interval(days => ${session.idleDays}),
                ${session.store}, ${session.refreshHash}, ${session.appVersion})
        RETURNING (extract(epoch FROM expires_at) * 1000)::bigint::text AS expires_ms`,
  );
  return { sessionId: session.id, deviceId, expiresAtMs: Number(row.expires_ms) };
}

export interface NewAccountInput {
  userId: string;
  identityId: string;
  provider: 1 | 2;
  subject: HashedValue;
  /** The phone number sealed (provider 1); null for Google (the e-mail is not kept). */
  subjectSealed: Buffer | null;
  /** A purged account's identity of the same subject, taken over by the new account. */
  tombstoneIdentityId: string | null;
  /** users.flags (1 test account). */
  flags: number;
  locale: string;
  device: DeviceInput;
  session: SessionInput;
}

/** Thrown when the subject was signed up by someone else meanwhile: retry as a sign-in. */
export class IdentityTakenError extends Error {
  constructor() {
    super('the identity belongs to another account');
    this.name = 'IdentityTakenError';
  }
}

/**
 * Creates an account and signs it in, inside the caller's transaction (4
 * statements): users, the identity, the device, the session. A purged
 * account's identity of the same subject is moved to the new account; a
 * live account's makes it throw {@link IdentityTakenError} (two first
 * sign-ins at once: the caller rolls back and signs in to the winner).
 */
export const createAccount = defineQuery({ name: 'auth.createAccount', statements: 4 }, async (tx, input: NewAccountInput): Promise<CreatedSession> => {
  await query(
    tx,
    sql`INSERT INTO users (id, status, flags, locale) VALUES (${input.userId}::bigint, 1, ${input.flags}, ${input.locale})`,
  );
  const identity = await maybeOne<{ id: string }>(
    tx,
    input.tombstoneIdentityId === null
      ? sql`INSERT INTO auth_identities (id, user_id, last_used_at, provider, hash_kid, subject_hash, subject_enc)
            VALUES (${input.identityId}::bigint, ${input.userId}::bigint, now(), ${input.provider}, ${input.subject.kid}, ${input.subject.hash}, ${input.subjectSealed})
            ON CONFLICT (provider, subject_hash) DO NOTHING
            RETURNING id::text`
      : sql`UPDATE auth_identities ai
               SET user_id = ${input.userId}::bigint, last_used_at = now(), hash_kid = ${input.subject.kid},
                   subject_hash = ${input.subject.hash}, subject_enc = ${input.subjectSealed}
              FROM users u
             WHERE ai.id = ${input.tombstoneIdentityId}::bigint AND u.id = ai.user_id AND u.status = 8
            RETURNING ai.id::text`,
  );
  if (identity === null) throw new IdentityTakenError();
  const deviceId = await upsertDevice(tx, input.userId, input.device);
  return insertSession(tx, input.userId, deviceId, input.session);
});

// ─── Refresh ───────────────────────────────────────────────────────────────

export interface RefreshInput {
  sessionId: string;
  oldHash: Buffer;
  newHash: Buffer;
  idleDays: number;
  /** A rotated token used again within this many seconds is a concurrent refresh, not a reuse. */
  graceSeconds: number;
  appVersion: number | null;
}

export type RefreshOutcome =
  | { outcome: 'rotated'; userId: string; deviceId: string | null; store: number; expiresAtMs: number; state: AccountState }
  | { outcome: 'reused'; userId: string }
  | { outcome: 'invalid' };

const refreshRow = z.object({
  outcome: z.enum(['rotated', 'reused', 'invalid']),
  user_id: id.nullable(),
  device_id: id.nullable(),
  store: z.number().int().nullable(),
  expires_ms: z.string().nullable(),
  state: z.unknown(),
});

/**
 * Rotates a refresh token in one statement: a HOT update of the session
 * when `oldHash` is its current token (`prev_hash` keeps the old one), or a
 * revocation (reason 3, reuse) when `oldHash` is its previous token and the
 * rotation is older than the grace; nothing otherwise (an unknown, revoked
 * or expired session, or a rotated token used again inside the grace). The
 * two updates exclude each other (a token is never both). Returns the
 * account's state with a rotation.
 */
export const refreshSession = defineQuery({ name: 'auth.refresh', statements: 1 }, async (db, input: RefreshInput): Promise<RefreshOutcome> => {
  const row = await one(
    db,
    sql`WITH rotated AS (
          UPDATE sessions s
             SET prev_hash = s.refresh_hash, refresh_hash = ${input.newHash}, generation = s.generation + 1,
                 refreshed_at = now(), expires_at = now() + make_interval(days => ${input.idleDays}),
                 app_version = coalesce(${input.appVersion}::integer, s.app_version)
           WHERE s.id = ${input.sessionId}::bigint AND s.refresh_hash = ${input.oldHash}
             AND s.revoked_at IS NULL AND s.expires_at > now()
          RETURNING s.user_id, s.device_id, s.store, s.expires_at
        ), reused AS (
          UPDATE sessions s
             SET revoked_at = now(), revoke_reason = 3
           WHERE s.id = ${input.sessionId}::bigint AND s.prev_hash = ${input.oldHash}
             AND s.revoked_at IS NULL AND s.refreshed_at <= now() - make_interval(secs => ${input.graceSeconds})
          RETURNING s.user_id
        )
        SELECT CASE WHEN r.user_id IS NOT NULL THEN 'rotated' WHEN x.user_id IS NOT NULL THEN 'reused' ELSE 'invalid' END AS outcome,
               coalesce(r.user_id, x.user_id)::text AS user_id, r.device_id::text AS device_id, r.store::integer AS store,
               (extract(epoch FROM r.expires_at) * 1000)::bigint::text AS expires_ms,
               CASE WHEN r.user_id IS NOT NULL THEN (SELECT ${accountState} FROM users u WHERE u.id = r.user_id) END AS state
          FROM (SELECT 1) one
          LEFT JOIN rotated r ON true
          LEFT JOIN reused x ON true`,
  );
  const parsed = refreshRow.parse(row);
  if (parsed.outcome === 'rotated' && parsed.user_id !== null && parsed.store !== null && parsed.expires_ms !== null) {
    return {
      outcome: 'rotated',
      userId: parsed.user_id,
      deviceId: parsed.device_id,
      store: parsed.store,
      expiresAtMs: Number(parsed.expires_ms),
      state: accountStateSchema.parse(parsed.state),
    };
  }
  if (parsed.outcome === 'reused' && parsed.user_id !== null) return { outcome: 'reused', userId: parsed.user_id };
  return { outcome: 'invalid' };
});

/** Revokes one session, or every live session of a user; returns the revoked session ids. */
export const revokeSessions = defineQuery(
  { name: 'auth.revokeSessions', statements: 1 },
  async (db, target: { sessionId: string } | { userId: string }, reason: number): Promise<string[]> => {
    const rows = await many<{ id: string }>(
      db,
      'sessionId' in target
        ? sql`UPDATE sessions SET revoked_at = now(), revoke_reason = ${reason}
               WHERE id = ${target.sessionId}::bigint AND revoked_at IS NULL RETURNING id::text`
        : sql`UPDATE sessions SET revoked_at = now(), revoke_reason = ${reason}
               WHERE user_id = ${target.userId}::bigint AND revoked_at IS NULL RETURNING id::text`,
    );
    return rows.map((r) => r.id);
  },
);

// ─── Adding or changing the phone ──────────────────────────────────────────

export interface PhoneProbe {
  /** Who holds the number now: null, this user, another live account, or a purged one. */
  holder: { userId: string; identityId: string; purged: boolean } | null;
  banned: boolean;
}

/** One statement: the number's holder and whether a phone ban refuses it. */
export const phoneProbe = defineQuery({ name: 'auth.phoneProbe', statements: 1 }, async (db, hashes: readonly Buffer[]): Promise<PhoneProbe> => {
  const row = await one<{ holder: { userId: string; identityId: string; purged: boolean } | null; banned: boolean }>(
    db,
    sql`SELECT
          (SELECT jsonb_build_object('userId', ai.user_id::text, 'identityId', ai.id::text, 'purged', u.status = 8)
             FROM auth_identities ai JOIN users u ON u.id = ai.user_id
            WHERE ai.provider = 1 AND ai.subject_hash = ANY(${hashes}::bytea[])
            ORDER BY (u.status = 8), ai.id
            LIMIT 1) AS holder,
          EXISTS (SELECT 1 FROM device_bans b
                   WHERE b.kind = 2 AND b.value_hash = ANY(${hashes}::bytea[]) AND (b.expires_at IS NULL OR b.expires_at > now())) AS banned`,
  );
  return { holder: row.holder, banned: row.banned };
});

/**
 * Gives `userId` the phone identity `subject` (replacing its earlier
 * number), inside the caller's transaction: 1 statement, or 2 when a purged
 * account's identity of the number is removed first. A live account taking
 * the number meanwhile fails on the unique key (23505).
 */
export const attachPhone = defineQuery(
  { name: 'auth.attachPhone', statements: 2 },
  async (tx, input: { userId: string; newIdentityId: string; subject: HashedValue; sealed: Buffer; purgedIdentityId: string | null }): Promise<void> => {
    if (input.purgedIdentityId !== null) {
      await query(tx, sql`DELETE FROM auth_identities WHERE id = ${input.purgedIdentityId}::bigint AND provider = 1`);
    }
    await query(
      tx,
      sql`WITH changed AS (
            UPDATE auth_identities
               SET hash_kid = ${input.subject.kid}, subject_hash = ${input.subject.hash}, subject_enc = ${input.sealed}, last_used_at = now()
             WHERE user_id = ${input.userId}::bigint AND provider = 1
            RETURNING id
          )
          INSERT INTO auth_identities (id, user_id, last_used_at, provider, hash_kid, subject_hash, subject_enc)
          SELECT ${input.newIdentityId}::bigint, ${input.userId}::bigint, now(), 1, ${input.subject.kid}, ${input.subject.hash}, ${input.sealed}
           WHERE NOT EXISTS (SELECT 1 FROM changed)`,
    );
  },
);

// ─── Under 18 ──────────────────────────────────────────────────────────────

export interface UnderAgeInput {
  userId: string;
  /** The session's device row, whose key is refused for a year in its build; null when unknown. */
  deviceId: string | null;
  /** Fresh ids for the ban rows: one per identity (at most 2) and one for the device. */
  banIds: readonly string[];
  reason: string;
}

export interface UnderAgeResult {
  closed: boolean;
  /** The refused hashes, for the Valkey cache: phone numbers (kind 2) and device keys (kind 1). */
  phoneHashes: Buffer[];
  deviceHashes: Buffer[];
  /** Sessions that were open. */
  sessionIds: string[];
}

/**
 * An under-age sign-up, inside the caller's transaction (4 statements):
 * the account becomes a tombstone at once (status 8, `deleted_via` 4; no
 * birth date or gender was ever stored); its phone and Google identities
 * and this build's device key are refused for a year (`device_bans`,
 * renewed by upsert, so an earlier expired ban never blocks it and a
 * permanent one is never shortened); then its sessions, devices and
 * identities are deleted, so nothing personal stays. Only an account still
 * in onboarding (status 1) is closed this way.
 */
export const closeUnderAge = defineQuery({ name: 'auth.closeUnderAge', statements: 4 }, async (tx, input: UnderAgeInput): Promise<UnderAgeResult> => {
  const closed = await maybeOne<{ id: string }>(
    tx,
    sql`UPDATE users SET status = 8, deleted_at = now(), deleted_via = 4, birth_date = NULL, gender = NULL, country = NULL
         WHERE id = ${input.userId}::bigint AND status = 1
        RETURNING id::text`,
  );
  if (closed === null) return { closed: false, phoneHashes: [], deviceHashes: [], sessionIds: [] };
  const renew = sql`ON CONFLICT (kind, value_hash) DO UPDATE
        SET expires_at = CASE WHEN device_bans.expires_at IS NULL THEN NULL
                              ELSE greatest(device_bans.expires_at, EXCLUDED.expires_at) END,
            reason = CASE WHEN device_bans.expires_at IS NULL OR device_bans.expires_at > now() THEN device_bans.reason ELSE EXCLUDED.reason END,
            store = EXCLUDED.store`;
  const identityBans = await many<{ kind: number; value_hash: Buffer }>(
    tx,
    sql`INSERT INTO device_bans (id, expires_at, kind, value_hash, reason)
        SELECT (${input.banIds}::bigint[])[row_number() OVER (ORDER BY ai.id)], now() + interval '1 year',
               CASE ai.provider WHEN 1 THEN 2 ELSE 3 END, ai.subject_hash, ${input.reason}
          FROM auth_identities ai
         WHERE ai.user_id = ${input.userId}::bigint AND ai.provider IN (1, 2)
        ${renew}
        RETURNING kind::integer, value_hash`,
  );
  const deviceBans =
    input.deviceId === null
      ? []
      : await many<{ value_hash: Buffer }>(
          tx,
          sql`INSERT INTO device_bans (id, expires_at, kind, store, value_hash, reason)
              SELECT (${input.banIds}::bigint[])[cardinality(${input.banIds}::bigint[])], now() + interval '1 year', 1, d.store, d.fingerprint_hash, ${input.reason}
                FROM devices d
               WHERE d.id = ${input.deviceId}::bigint AND d.user_id = ${input.userId}::bigint AND d.fingerprint_hash IS NOT NULL
              ${renew}
              RETURNING value_hash`,
        );
  // Sessions, devices and identities in one statement: every data-modifying
  // WITH runs to completion, and the foreign keys are checked at its end.
  const removed = await many<{ id: string }>(
    tx,
    sql`WITH s AS (DELETE FROM sessions WHERE user_id = ${input.userId}::bigint RETURNING id, revoked_at),
             d AS (DELETE FROM devices WHERE user_id = ${input.userId}::bigint),
             i AS (DELETE FROM auth_identities WHERE user_id = ${input.userId}::bigint)
        SELECT s.id::text AS id FROM s WHERE s.revoked_at IS NULL`,
  );
  return {
    closed: true,
    phoneHashes: identityBans.filter((b) => b.kind === 2).map((b) => b.value_hash),
    deviceHashes: deviceBans.map((b) => b.value_hash),
    sessionIds: removed.map((r) => r.id),
  };
});
