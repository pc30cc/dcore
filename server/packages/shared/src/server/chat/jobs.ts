import { z } from 'zod';
import { jobId } from '../queues.js';

/**
 * The chat's jobs, as the API adds them and the worker runs them:
 *
 * - `chat/unsend-clear` (`unsend-clear.<m>.<target>`), `retention.unsent_body_hours`
 *   after an unsend: the taken-back message's body is removed (flag 8) and
 *   the list preview rewritten when it was the newest;
 * - `chat/read-flush` (every minute, under a lease): the read pointers that
 *   moved, one UPDATE for all of them;
 * - `safety/report-evidence` (`report-evidence.<filing>`): the messages a
 *   chat report is about, copied into the report once the write-behind
 *   stream is durable past the report;
 * - `safety/report-file` (`report-file.<filing>`): a report accepted while
 *   PostgreSQL could not take it, filed once it can;
 * - `safety/requests-sweep` (daily, under a lease): pending message
 *   requests expire after 14 days, decided ones are deleted
 *   `retention.message_requests_days` after the decision.
 */

export const CHAT_QUEUE_NAME = 'chat' as const;
export const chatJobNames = { unsendClear: 'unsend-clear', readFlush: 'read-flush' } as const;
export const evidenceJobNames = { reportEvidence: 'report-evidence', reportFile: 'report-file', requestsSweep: 'requests-sweep' } as const;

export const chatJobIds = {
  unsendClear: (matchId: string, targetId: string) => jobId('unsend-clear', matchId, targetId),
  reportEvidence: (filingId: string) => jobId('report-evidence', filingId),
  reportFile: (filingId: string) => jobId('report-file', filingId),
};

const ID = z.string().regex(/^[1-9][0-9]{0,18}$/);

export const unsendClearJobSchema = z.object({ matchId: ID, targetId: ID, senderId: ID });
export type UnsendClearJob = z.infer<typeof unsendClearJobSchema>;

/**
 * `reportId` is the report's row (a second filing about the same person
 * joins the open one); `filingId` is this filing's own id, minted when it
 * was made: its time is the moment the evidence is taken up to.
 */
export const reportEvidenceJobSchema = z.object({
  reportId: ID,
  filingId: ID,
  reporterId: ID,
  targetId: ID,
  conversationId: ID.nullable(),
  messageIds: z.array(ID).max(20),
  queuedAtMs: z.number().int().nonnegative(),
});
export type ReportEvidenceJob = z.infer<typeof reportEvidenceJobSchema>;

export const reportFileJobSchema = z.object({
  filingId: ID,
  reporterId: ID,
  targetId: ID,
  context: z.number().int().min(1).max(5),
  reason: z.number().int().min(1).max(99),
  details: z.string().max(2_000).nullable(),
  conversationId: ID.nullable(),
  messageIds: z.array(ID).max(20),
  photoId: ID.nullable(),
  callId: ID.nullable(),
  block: z.boolean(),
  /** Event id of the `conversation_end` a block sends (minted with the request). */
  blockEventId: ID.nullable(),
  queuedAtMs: z.number().int().nonnegative(),
});
export type ReportFileJob = z.infer<typeof reportFileJobSchema>;

/** The evidence job waits for the stream this long, then also reads what is still in it. */
export const EVIDENCE_MAX_WAIT_MS = 10 * 60_000;
/** How many of the conversation's messages before the report are kept as its context. */
export const EVIDENCE_CONTEXT_MESSAGES = 50;
