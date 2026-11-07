import { purgeUnmatched } from '@app/db';
import { DelayedError, type Job } from 'bullmq';
import { z } from 'zod';
import type { JobContext } from './types.js';

/**
 * `unmatch-purge` (queue `account`), `retention.unmatched_messages_days`
 * after an unmatch: the conversation's messages and calls are deleted in
 * one statement; the match row stays for good (it keeps the two out of
 * each other's deck). A legal hold on the conversation or on either person
 * keeps everything and the job looks again a day later; a conversation that
 * is active again (it cannot be today, but the rule is the database's) is
 * left alone. Chat media (`m/<matchId>/`) arrive with W4.
 */

export const UNMATCH_HOLD_RECHECK_MS = 24 * 3_600_000;

const dataSchema = z.object({ matchId: z.string().regex(/^[1-9][0-9]{0,18}$/) });

export type UnmatchPurgeResult = { outcome: 'purged' | 'active' | 'missing' };

export async function unmatchPurgeJob(job: Job, context: JobContext): Promise<UnmatchPurgeResult> {
  const { matchId } = dataSchema.parse(job.data);
  const outcome = await purgeUnmatched(context.services.pg, matchId);
  if (outcome === 'held') {
    if (!context.token) throw new Error('a delayed retry needs the job token');
    context.log.info({ matchId }, 'unmatch purge: under a legal hold; looked at again tomorrow');
    await job.moveToDelayed(Date.now() + UNMATCH_HOLD_RECHECK_MS, context.token);
    throw new DelayedError();
  }
  return { outcome };
}
