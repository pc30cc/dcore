import { z } from 'zod';
import { idSchema } from './common.js';

/**
 * `POST /v1/me/export`: a copy of the account's data, built by the worker.
 * The answer names the export; when the archive is ready the person hears
 * `account` with `export: { url, expiresAt }` (a link valid 24 h).
 */
export const exportStartedSchema = z.object({ exportId: idSchema });
export type ExportStarted = z.infer<typeof exportStartedSchema>;
