import { z } from 'zod';
import { appStoreNameSchema, httpUrl, timeSchema } from './common.js';

/**
 * Account deletion in the app (`/v1/me/deletion*`). The public routes the
 * website posts to (no sign-in) are in `accountDeletion.ts`, next to the
 * website's form contract; their JSON answers are below.
 */

/** `GET /v1/me/deletion/preflight`: a live store subscription that deleting does not cancel. */
export const deletionPreflightSchema = z.object({
  subscription: z
    .object({ store: appStoreNameSchema, active: z.literal(true), manageUrl: httpUrl.optional() })
    .optional(),
});

/** `POST /v1/me/deletion`. */
export const deletionRequestSchema = z.object({ reason: z.string().trim().min(1).max(500).optional() });

/** The answer to an in-app or a confirmed public deletion: when the account is purged for good. */
export const deletionScheduledSchema = z.object({ purgeAt: timeSchema });

/** The JSON answer to `POST /v1/public/account-deletion/start`: the same whether or not an account exists. */
export const publicDeletionChallengeSchema = z.object({
  requestToken: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/),
  codeLength: z.number().int().min(4).max(8),
});
