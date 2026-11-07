import { z } from 'zod';
import { reportReason, type reportContext } from '../codes.js';
import { cursorSchema } from '../pagination.js';
import { idSchema, peerSummarySchema, publicUidSchema, timeSchema } from './common.js';

/** Blocks and reports (`/v1/blocks`, `/v1/reports`). */

export const REPORT_DETAILS_MAX = 2_000;
export const REPORT_MESSAGES_MAX = 20;

export const blockRequestSchema = z.object({ target: publicUidSchema });
export type BlockRequest = z.infer<typeof blockRequestSchema>;

/** `DELETE /v1/blocks/:target`: any string; one that names nobody removes nothing. */
export const blockParamsSchema = z.object({ target: z.string().min(1).max(40) });

export const blocksQuerySchema = z.object({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const blockedUserSchema = z.object({
  user: peerSummarySchema,
  blockedAt: timeSchema,
});
export type BlockedUser = z.infer<typeof blockedUserSchema>;

/** The people this account blocked, newest first (a block made by the other side is never listed). */
export const blockListSchema = z.object({
  items: z.array(blockedUserSchema),
  nextCursor: cursorSchema.nullable().optional(),
});
export type BlockList = z.infer<typeof blockListSchema>;

/** Contexts a person can report from (`social` is P1). */
export const reportContextSchema = z.enum(['profile', 'chat', 'photo', 'call'] as const satisfies readonly (typeof reportContext.names)[number][]);
export type ReportContext = z.infer<typeof reportContextSchema>;
export const reportReasonSchema = reportReason.schema;

export const reportRequestSchema = z
  .object({
    target: publicUidSchema,
    context: reportContextSchema,
    reason: reportReasonSchema,
    details: z.string().trim().min(1).max(REPORT_DETAILS_MAX).optional(),
    conversationId: idSchema.optional(),
    messageIds: z.array(idSchema).min(1).max(REPORT_MESSAGES_MAX).optional(),
    photoId: idSchema.optional(),
    callId: idSchema.optional(),
    /** Also block the person (in the same transaction). */
    block: z.boolean().optional(),
  })
  .refine((r) => r.context !== 'photo' || r.photoId !== undefined, { message: 'a photo report names the photo', path: ['photoId'] })
  .refine((r) => r.context !== 'call' || r.callId !== undefined, { message: 'a call report names the call', path: ['callId'] })
  .refine((r) => r.messageIds === undefined || r.context === 'chat', { message: 'messages belong to a chat report', path: ['messageIds'] });
export type ReportRequest = z.infer<typeof reportRequestSchema>;

export const reportReceiptSchema = z.object({ reportId: idSchema });
export type ReportReceipt = z.infer<typeof reportReceiptSchema>;
