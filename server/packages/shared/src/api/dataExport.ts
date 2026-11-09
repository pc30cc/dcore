import { z } from 'zod';
import { httpUrl, idSchema, timeSchema } from './common.js';

/**
 * `POST /v1/me/export`: a copy of the account's data, built by the worker.
 * The answer names the export; when the archive is ready the person hears
 * `account` with `export: { url, expiresAt }` (a link valid 24 h).
 */
export const exportStartedSchema = z.object({ exportId: idSchema });
export type ExportStarted = z.infer<typeof exportStartedSchema>;

/**
 * `GET /v1/me/export`: the export's state, so a link announced while the
 * phone was offline is not lost. `none`: nothing asked for this week, or the
 * link ran out; `pending`: being built; `ready`: `url` and `expiresAt`, only
 * while the link is valid.
 */
export const exportStateSchema = z.enum(['none', 'pending', 'ready']);
export type ExportState = z.infer<typeof exportStateSchema>;

export const exportStatusSchema = z
  .object({
    status: exportStateSchema,
    url: httpUrl.optional(),
    expiresAt: timeSchema.optional(),
  })
  .refine((value) => (value.status === 'ready') === (value.url !== undefined) && (value.url !== undefined) === (value.expiresAt !== undefined), {
    message: 'url and expiresAt come together, with status ready only',
  });
export type ExportStatus = z.infer<typeof exportStatusSchema>;
