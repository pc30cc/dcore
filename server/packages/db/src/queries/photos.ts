import { maybeOne, one, sql } from '../query.js';
import { defineQuery } from './define.js';

/**
 * Photos (§3.4): the rows the upload routes write and the worker finishes.
 * A photo is written once by `complete` (status 1, processing), once by the
 * worker (status 2 waiting for a human, 3 approved or 4 rejected), moved by
 * a reorder and removed by a delete. Statement triggers of 0004 and 0006
 * bump the profile version (the card cache key), re-sync discovery and let a
 * verification lapse when its reference photo moves; nothing here repeats
 * that work.
 */

/** Positions 0-8: the photo limit is the position range. */
export const PHOTO_POSITIONS = 9;

export type PhotoInsertResult =
  | { kind: 'created'; position: number }
  /** The same photo was completed before (a retried request): its position. */
  | { kind: 'existing'; position: number }
  /** Every position is taken. */
  | { kind: 'full' };

/**
 * The row of a completed upload, at the position the upload asked for or,
 * when another photo took it meanwhile, at the lowest free one. Two
 * concurrent inserts can still pick the same free position: the unique
 * constraint refuses the second (23505 on photos_user_position_key) and the
 * caller tries once more.
 */
export const insertPhoto = defineQuery(
  { name: 'photos.insert', statements: 1 },
  async (db, userId: string, photoId: string, position: number): Promise<PhotoInsertResult> => {
    const row = await one<{ inserted: number | null; existing: number | null }>(
      db,
      sql`
WITH existing AS (
  SELECT position FROM photos WHERE id = ${photoId}::bigint AND user_id = ${userId}::bigint
), want AS (
  SELECT coalesce(
           (SELECT ${position}::smallint
             WHERE NOT EXISTS (SELECT 1 FROM photos WHERE user_id = ${userId}::bigint AND position = ${position}::smallint)),
           (SELECT g::smallint FROM generate_series(0, ${PHOTO_POSITIONS - 1}) AS g
             WHERE NOT EXISTS (SELECT 1 FROM photos WHERE user_id = ${userId}::bigint AND position = g)
             ORDER BY g LIMIT 1)) AS position
), ins AS (
  INSERT INTO photos (id, user_id, position)
  SELECT ${photoId}::bigint, ${userId}::bigint, w.position
    FROM want w
   WHERE w.position IS NOT NULL AND NOT EXISTS (SELECT 1 FROM existing)
  ON CONFLICT (id) DO NOTHING
  RETURNING position
)
SELECT (SELECT position FROM ins) AS inserted, (SELECT position FROM existing) AS existing`,
    );
    if (row.existing !== null) return { kind: 'existing', position: row.existing };
    if (row.inserted !== null) return { kind: 'created', position: row.inserted };
    return { kind: 'full' };
  },
);

/**
 * Puts the account's photos in the order given (position = index). The list
 * must name every photo of the account exactly once, or nothing moves
 * (`ok` false). One UPDATE: the unique (user_id, position) constraint is
 * deferrable, so a permutation is checked at the end of the statement.
 */
export const reorderPhotos = defineQuery(
  { name: 'photos.reorder', statements: 1 },
  async (db, userId: string, photoIds: readonly string[]): Promise<{ ok: boolean; moved: number }> => {
    const row = await one<{ ok: boolean; moved: number }>(
      db,
      sql`
WITH mine AS (
  SELECT array_agg(id ORDER BY id) AS ids FROM photos WHERE user_id = ${userId}::bigint
), given AS (
  SELECT array_agg(x ORDER BY x) AS ids FROM unnest(${photoIds}::bigint[]) AS x
), check_ AS (
  SELECT coalesce(m.ids = g.ids, false) AS ok FROM mine m, given g
), want AS (
  SELECT u.id, (u.ord - 1)::smallint AS position
    FROM unnest(${photoIds}::bigint[]) WITH ORDINALITY AS u(id, ord)
), up AS (
  UPDATE photos p SET position = w.position
    FROM want w, check_ c
   WHERE c.ok AND p.id = w.id AND p.user_id = ${userId}::bigint AND p.position <> w.position
  RETURNING p.id
)
SELECT (SELECT ok FROM check_) AS ok, (SELECT count(up.id) FROM up)::integer AS moved`,
    );
    return row;
  },
);

export type PhotoDeleteResult =
  | { kind: 'deleted'; blobVer: number }
  | { kind: 'missing' }
  /** It would leave fewer than the minimum of photos that are not rejected. */
  | { kind: 'minimum' };

/**
 * Deletes one of the account's photos. Once the sign-up is finished (status
 * other than 1, onboarding), a photo that is not rejected may go only while
 * at least `minimum` other photos that are not rejected stay. The account's
 * photo rows are locked first, so two deletes at once cannot both pass the
 * check. Returns the blob version, which the blob delete job needs.
 */
export const deletePhoto = defineQuery(
  { name: 'photos.delete', statements: 1 },
  async (db, userId: string, photoId: string, minimum: number): Promise<PhotoDeleteResult> => {
    const row = await one<{ found: boolean; blob_ver: number | null }>(
      db,
      sql`
WITH locked AS (
  SELECT id, status, blob_ver FROM photos WHERE user_id = ${userId}::bigint FOR UPDATE
), target AS (
  SELECT id, status, blob_ver FROM locked WHERE id = ${photoId}::bigint
), allowed AS (
  SELECT t.id
    FROM target t
   WHERE t.status = 4
      OR (SELECT status FROM users WHERE id = ${userId}::bigint) = 1
      OR (SELECT count(l.id) FROM locked l WHERE l.id <> t.id AND l.status <> 4) >= ${minimum}::integer
), gone AS (
  DELETE FROM photos p USING allowed a WHERE p.id = a.id RETURNING p.blob_ver
)
SELECT EXISTS (SELECT 1 FROM target) AS found, (SELECT blob_ver FROM gone) AS blob_ver`,
    );
    if (!row.found) return { kind: 'missing' };
    if (row.blob_ver === null) return { kind: 'minimum' };
    return { kind: 'deleted', blobVer: row.blob_ver };
  },
);

// ─── The worker's pipeline ─────────────────────────────────────────────────

export interface PhotoToProcess {
  userId: string;
  /** photos.status: only 1 (processing) is worked on. */
  status: number;
  blobVer: number;
  position: number;
}

/** The photo a `process` job works on, or null when it does not exist (yet, or any more). */
export const photoToProcess = defineQuery({ name: 'photos.toProcess', statements: 1 }, async (db, photoId: string) => {
  const row = await maybeOne<{ user_id: string; status: number; blob_ver: number; position: number }>(
    db,
    sql`SELECT user_id::text, status, blob_ver, position FROM photos WHERE id = ${photoId}::bigint`,
  );
  return row ? ({ userId: row.user_id, status: row.status, blobVer: row.blob_ver, position: row.position } satisfies PhotoToProcess) : null;
});

export interface PhotoOutcome {
  /** 2 waiting for a human, 3 approved, 4 rejected. */
  status: 2 | 3 | 4;
  rejectReason: number | null;
  /** photos.mod_flags from the automatic checks (the duplicate bit is added here). */
  modFlags: number;
  hasFace: boolean | null;
  width: number | null;
  height: number | null;
  blurhash: string | null;
  /** The 64-bit perceptual hash as a signed bigint (decimal), or null without pixels. */
  phash: string | null;
}

export interface FinishedPhoto {
  userId: string;
  status: number;
  modFlags: number;
}

/** Bit 32 of photos.mod_flags: the picture is (nearly) another account's. */
const DUPLICATE_FLAG = 32;

/**
 * Writes the pipeline's result to a photo still processing. A picture
 * within 3 bits of the perceptual hash of another account's photo that is
 * not rejected gets the duplicate flag and goes to a human instead of being
 * approved (one GIN probe on the hash bands, then the Hamming distance).
 * Returns null when the photo is gone or was finished already.
 */
export const finishPhoto = defineQuery(
  { name: 'photos.finish', statements: 1 },
  async (db, photoId: string, outcome: PhotoOutcome): Promise<FinishedPhoto | null> => {
    const row = await maybeOne<{ user_id: string; status: number; mod_flags: number }>(
      db,
      sql`
WITH dup AS (
  SELECT ${outcome.phash}::bigint IS NOT NULL AND EXISTS (
           SELECT 1 FROM photos o
            WHERE o.phash IS NOT NULL
              AND phash_bands(o.phash) && phash_bands(${outcome.phash}::bigint)
              AND bit_count(int8send(o.phash # ${outcome.phash}::bigint)) <= 3
              AND o.status <> 4
              AND o.user_id <> (SELECT user_id FROM photos WHERE id = ${photoId}::bigint)) AS hit
), decided AS (
  SELECT CASE WHEN ${outcome.status}::smallint = 3 AND d.hit THEN 2::smallint ELSE ${outcome.status}::smallint END AS status,
         (${outcome.modFlags}::integer | CASE WHEN d.hit THEN ${DUPLICATE_FLAG} ELSE 0 END)::smallint AS mod_flags
    FROM dup d
)
UPDATE photos p
   SET status = x.status,
       mod_flags = x.mod_flags,
       reject_reason = ${outcome.rejectReason}::smallint,
       has_face = ${outcome.hasFace}::boolean,
       width = ${outcome.width}::smallint,
       height = ${outcome.height}::smallint,
       blurhash = ${outcome.blurhash}::text,
       phash = ${outcome.phash}::bigint,
       decided_at = CASE WHEN x.status IN (3, 4) THEN now() END
  FROM decided x
 WHERE p.id = ${photoId}::bigint AND p.status = 1
RETURNING p.user_id::text, p.status, p.mod_flags`,
    );
    return row ? { userId: row.user_id, status: row.status, modFlags: row.mod_flags } : null;
  },
);

/** Whether the photo row exists (after a finish that wrote nothing: gone, or finished by another run). */
export const photoExists = defineQuery({ name: 'photos.exists', statements: 1 }, async (db, photoId: string) => {
  const row = await one<{ found: boolean }>(db, sql`SELECT EXISTS (SELECT 1 FROM photos WHERE id = ${photoId}::bigint) AS found`);
  return row.found;
});

/** Whether a legal hold names the account: its photos' blobs are then kept. */
export const photoBlobsHeld = defineQuery({ name: 'photos.blobsHeld', statements: 1 }, async (db, userId: string) => {
  const row = await one<{ held: boolean }>(db, sql`SELECT legal_hold_active(${userId}::bigint, NULL) AS held`);
  return row.held;
});
