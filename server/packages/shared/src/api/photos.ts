import { z } from 'zod';
import { idSchema, timeSchema } from './common.js';

/**
 * Photo uploads: a presigned PUT to the private bucket, then `complete`,
 * after which the worker strips EXIF/GPS, makes the variants and moderates.
 * Nothing is public until approved.
 */

export const PHOTO_MAX_BYTES = 15 * 1024 * 1024;
export const photoMimes = ['image/jpeg', 'image/webp', 'image/heic'] as const;
export const photoMimeSchema = z.enum(photoMimes);

export const photoUploadRequestSchema = z.object({
  position: z.number().int().min(0).max(8),
  mime: photoMimeSchema,
  bytes: z.number().int().positive().max(PHOTO_MAX_BYTES),
});
export type PhotoUploadRequest = z.infer<typeof photoUploadRequestSchema>;

export const uploadTargetSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  method: z.literal('PUT'),
  /** Headers the PUT must carry exactly as given (they are part of the signature). */
  headers: z.record(z.string(), z.string()),
  expiresAt: timeSchema,
});

export const photoUploadTicketSchema = z.object({
  photoId: idSchema,
  upload: uploadTargetSchema,
});
export type PhotoUploadTicket = z.infer<typeof photoUploadTicketSchema>;

export const photoParamsSchema = z.object({ photoId: idSchema });

export const photoCompletedSchema = z.object({
  photo: z.object({ id: idSchema, position: z.number().int().min(0).max(8), status: z.literal('processing') }),
});

export const photoOrderRequestSchema = z.object({
  photoIds: z
    .array(idSchema)
    .min(1)
    .max(9)
    .refine((ids) => new Set(ids).size === ids.length, 'photoIds must not repeat'),
});
