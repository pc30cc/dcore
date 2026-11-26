import { hashDomains } from '@app/shared/server';
import { newRefreshToken } from '../src/auth/sessions.js';
import { row, type Harness, type SeededUser } from './accountSupport.js';

/**
 * Seeds for the admin moderation suites, in plain SQL: photos in any state,
 * profile texts and prompt answers waiting for a decision, reports, a phone
 * identity (hashed and sealed as sign-in writes it) and a refresh token for
 * a seeded session.
 */

export interface PhotoSeed {
  position?: number;
  status?: 1 | 2 | 3 | 4;
  rejectReason?: number | null;
  modFlags?: number;
}

export async function seedPhoto(h: Harness, userId: string, options: PhotoSeed = {}): Promise<string> {
  const id = h.app.ids.nextId();
  const status = options.status ?? 2;
  await h.db.sql.query(
    `INSERT INTO photos (id, user_id, position, status, reject_reason, mod_flags, width, height, blurhash, blob_ver, has_face)
     VALUES ($1, $2, $3, $4::smallint, $5, $6, CASE WHEN $4::smallint > 1 THEN 1080 END, CASE WHEN $4::smallint > 1 THEN 1350 END, CASE WHEN $4::smallint > 1 THEN 'L6PZfSi_.AyE' END, 1, CASE WHEN $4::smallint > 1 THEN true END)`,
    [id, userId, options.position ?? 0, status, status === 4 ? (options.rejectReason ?? 2) : null, options.modFlags ?? 0],
  );
  return id;
}

let promptSeq = 0;

/** A text prompt in the catalogue (its question in English and Persian). */
export async function seedPromptDef(h: Harness, question = 'A good day'): Promise<number> {
  promptSeq += 1;
  const created = await row<{ id: number }>(h.db, `INSERT INTO prompt_defs (kind, i18n) VALUES (1, $1::jsonb) RETURNING id`, [
    JSON.stringify({ en: `${question} ${promptSeq}`, fa: `روز خوب ${promptSeq}` }),
  ]);
  return Number(created.id);
}

export interface PromptSeed {
  position: number;
  answer: string;
  status?: 1 | 2 | 3;
  promptId?: number;
}

export async function seedPrompts(h: Harness, userId: string, prompts: readonly PromptSeed[]): Promise<number[]> {
  const ids: number[] = [];
  for (const p of prompts) {
    const promptId = p.promptId ?? (await seedPromptDef(h));
    ids.push(promptId);
    await h.db.sql.query(`INSERT INTO profile_prompts (user_id, position, prompt_id, answer, status) VALUES ($1, $2, $3, $4, $5)`, [
      userId,
      p.position,
      promptId,
      p.answer,
      p.status ?? 1,
    ]);
  }
  return ids;
}

/** The person's about and job texts in a state (1 waiting for a human). */
export async function seedTexts(h: Harness, userId: string, texts: { about?: string | null; job?: string | null; textState?: 1 | 2 | 3 }): Promise<number> {
  const updated = await row<{ version: number }>(
    h.db,
    `UPDATE profiles SET about = $2, job_title = $3, text_state = $4 WHERE user_id = $1 RETURNING version`,
    [userId, texts.about ?? null, texts.job ?? null, texts.textState ?? 1],
  );
  return updated.version;
}

export async function profileVersion(h: Harness, userId: string): Promise<number> {
  return (await row<{ version: number }>(h.db, `SELECT version FROM profiles WHERE user_id = $1`, [userId])).version;
}

export interface ReportSeed {
  targetId: string;
  reporterId?: string | null;
  reason?: number;
  context?: number;
  status?: 1 | 2 | 3 | 4 | 5;
  priority?: number;
}

export async function seedReport(h: Harness, options: ReportSeed): Promise<string> {
  const id = h.app.ids.nextId();
  const status = options.status ?? 1;
  await h.db.sql.query(
    `INSERT INTO reports (id, target_id, reporter_id, context, reason, status, priority, resolved_at, evidence_at)
     VALUES ($1, $2, $3, $4, $5, $6::smallint, $7, CASE WHEN $6::smallint IN (3, 4, 5) THEN now() END, now())`,
    [id, options.targetId, options.reporterId ?? null, options.context ?? 1, options.reason ?? 2, status, options.priority ?? 40],
  );
  return id;
}

/** A phone identity for the person, as sign-in stores it (keyed hash, sealed number). */
export async function seedPhone(h: Harness, userId: string, e164: string): Promise<void> {
  const { kid, hash } = h.app.secrets.hasher.hash(hashDomains.phone, e164);
  const sealed = h.app.secrets.sealer.seal(e164, 'auth_identities.subject_enc');
  await h.db.sql.query(`INSERT INTO auth_identities (id, user_id, provider, hash_kid, subject_hash, subject_enc) VALUES ($1, $2, 1, $3, $4, $5)`, [
    h.app.ids.nextId(),
    userId,
    kid,
    hash,
    sealed,
  ]);
}

/** A refresh token for the seeded user's session (the stored hash replaced). */
export async function refreshTokenFor(h: Harness, user: SeededUser): Promise<string> {
  const refresh = newRefreshToken(user.sessionId);
  await h.db.sql.query(`UPDATE sessions SET refresh_hash = $2 WHERE id = $1`, [user.sessionId, refresh.hash]);
  return refresh.token;
}

/** Every process of the harness loads the configuration again (prompts and terms seeded after start). */
export async function reloadConfig(h: Harness): Promise<void> {
  const before = h.app.cfg.peek()?.loadedAt.getTime() ?? 0;
  const version = await h.redis.incr(`${h.prefix}cfg:v`);
  await h.redis.publish(`${h.prefix}cfg:changed`, String(version));
  for (let i = 0; i < 300; i += 1) {
    const snapshot = h.app.cfg.peek();
    if (snapshot && snapshot.version >= version && snapshot.loadedAt.getTime() >= before) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`configuration version ${version} was not loaded`);
}

/** An active match of the two (a conversation), lo/hi ordered as the table wants. */
export async function seedMatch(h: Harness, a: string, b: string): Promise<string> {
  const id = h.app.ids.nextId();
  const [lo, hi] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  await h.db.sql.query(`INSERT INTO matches (id, user_lo, user_hi, source) VALUES ($1, $2, $3, 1)`, [id, lo, hi]);
  return id;
}

export interface EvidenceReportSeed extends ReportSeed {
  matchId?: string | null;
  details?: string | null;
  /** reports.evidence as report_file() and the chat evidence job write it. */
  evidence?: Record<string, unknown>;
  /** false: the chat evidence is still being collected (evidence_at NULL). */
  complete?: boolean;
}

/** A report with its evidence (filings, chat snapshots) as the app and the worker leave it. */
export async function seedEvidenceReport(h: Harness, options: EvidenceReportSeed): Promise<string> {
  const id = h.app.ids.nextId();
  const status = options.status ?? 1;
  await h.db.sql.query(
    `INSERT INTO reports (id, target_id, reporter_id, match_id, context, reason, status, priority, resolved_at, evidence_at, details, evidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7::smallint, $8, CASE WHEN $7::smallint IN (3, 4, 5) THEN now() END, CASE WHEN $9 THEN now() END, $10, $11::jsonb)`,
    [
      id,
      options.targetId,
      options.reporterId ?? null,
      options.matchId ?? null,
      options.context ?? 1,
      options.reason ?? 2,
      status,
      options.priority ?? 40,
      options.complete ?? true,
      options.details ?? null,
      JSON.stringify(options.evidence ?? {}),
    ],
  );
  return id;
}

/** A moderation record through moderation_apply() (1 warning, 2 suspension, 3 ban, 4 shadowban); its id. */
export async function seedAction(h: Harness, userId: string, kind: 1 | 2 | 3 | 4, reasonText = 'You broke the rules.', options: { endsAt?: Date; reportId?: string } = {}): Promise<string> {
  const id = h.app.ids.nextId();
  await h.db.sql.query(`SELECT moderation_apply($1, $2, $3::smallint, 2::smallint, $4, $5::timestamptz, NULL, $6, NULL)`, [
    id,
    userId,
    kind,
    reasonText,
    options.endsAt?.toISOString() ?? (kind === 2 ? new Date(Date.now() + 7 * 86_400_000).toISOString() : null),
    options.reportId ?? null,
  ]);
  return id;
}

/** An open appeal of the person against one of their records. */
export async function seedAppeal(h: Harness, userId: string, actionId: string, body = 'Please look at it again.'): Promise<string> {
  const id = h.app.ids.nextId();
  await h.db.sql.query(`INSERT INTO appeals (id, user_id, action_id, body) VALUES ($1, $2, $3, $4)`, [id, userId, actionId, body]);
  return id;
}
