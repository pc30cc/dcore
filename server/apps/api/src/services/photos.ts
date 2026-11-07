import type { KeyBuilder } from '@app/shared/server';
import type { Redis } from 'ioredis';

/**
 * Upload intents: what `POST /v1/me/photos` handed out, kept in Valkey as
 * `up:<photoId>` = {uid, pos, mime, bytes} for an hour (the life of the
 * presigned URL). `complete` reads it back: the photo id belongs to the
 * caller only if the intent says so, and the stored object must have the
 * type and size that were signed. Nothing reaches PostgreSQL before
 * `complete`.
 */

export const UPLOAD_TTL_SECONDS = 3_600;

/** What the server accepts for processing: JPEG and WebP (the app always sends JPEG). */
export const ACCEPTED_PHOTO_MIMES: ReadonlySet<string> = new Set(['image/jpeg', 'image/webp']);

export interface UploadIntent {
  userId: string;
  position: number;
  mime: string;
  bytes: number;
}

export async function saveUploadIntent(redis: Redis, keys: KeyBuilder, photoId: string, intent: UploadIntent): Promise<void> {
  const key = keys.upload(photoId);
  const replies = await redis
    .multi()
    .hset(key, { uid: intent.userId, pos: String(intent.position), mime: intent.mime, bytes: String(intent.bytes) })
    .expire(key, UPLOAD_TTL_SECONDS)
    .exec();
  const failed = replies?.find(([error]) => error);
  if (!replies || failed) throw failed?.[0] ?? new Error('upload intent not stored');
}

/** The intent, or null when it expired, never existed or does not parse. */
export async function readUploadIntent(redis: Redis, keys: KeyBuilder, photoId: string): Promise<UploadIntent | null> {
  const fields = await redis.hgetall(keys.upload(photoId));
  const { uid, pos, mime, bytes } = fields;
  if (!uid || !/^[1-9][0-9]{0,18}$/.test(uid) || !pos || !mime || !bytes) return null;
  const position = Number(pos);
  const size = Number(bytes);
  if (!Number.isInteger(position) || position < 0 || position > 8 || !Number.isSafeInteger(size) || size < 1) return null;
  return { userId: uid, position, mime, bytes: size };
}
