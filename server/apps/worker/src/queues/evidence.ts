import { configNumber, deleteDecidedRequests, expireMessageRequests, fileReport, isTransientDatabaseError, writeChatEvidence } from '@app/db';
import { idTime, realtimeEnvelope, userChannel } from '@app/shared';
import {
  ACCOUNT_QUEUE,
  applyBlockKv,
  chatJobIds,
  EVIDENCE_CONTEXT_MESSAGES,
  EVIDENCE_MAX_WAIT_MS,
  evidenceJobNames,
  jobId,
  parseMessageEntry,
  readWatermark,
  reportEvidenceJobSchema,
  reportFileJobSchema,
  type ReportEvidenceJob,
} from '@app/shared/server';
import { DelayedError, type Job } from 'bullmq';
import { endCallsOf } from '../calls/queue.js';
import { takeLease } from '../lease.js';
import { queueJob } from '../social/jobs.js';
import type { JobContext } from './types.js';

/**
 * The chat side of reports (queue `safety`):
 *
 * - `report-evidence`: a chat report's messages, copied into the report.
 *   The messages are usually seconds old and may still be in `wb:msg`, so
 *   the job waits (checking every two seconds) until the stream's
 *   watermark has passed the filing, then one statement copies the
 *   messages the filing names and the conversation's last 50 before it
 *   (`report_chat_evidence()`, once per filing). If the watermark does not
 *   pass within ten minutes, what is still in the stream from the ten
 *   minutes before the filing is read too and copied with them.
 * - `report-file`: a report accepted while PostgreSQL could not take it,
 *   filed with its own id once it can (its block's Valkey side and events
 *   follow, as the API does them; then its evidence).
 * - `requests-sweep` (daily, under a lease): pending message requests
 *   expire after 14 days, decided ones are deleted once their retention is
 *   over, 5,000 per statement.
 *
 * A database that cannot be reached only delays them (no attempt is used up).
 */

const RECHECK_MS = 2_000;
const OUTAGE_RECHECK_MS = 5_000;
const SWEEP_CHUNK = 5_000;
const DAY_MS = 86_400_000;
/** app_config `retention.unmatched_messages_days` as seeded, when it cannot be read. */
const DEFAULT_UNMATCHED_DAYS = 7;

async function later(job: Job, context: JobContext, delayMs: number): Promise<never> {
  if (!context.token) throw new Error('a delayed retry needs the job token');
  await job.moveToDelayed(Date.now() + delayMs, context.token);
  throw new DelayedError();
}

/** Stream entries read per page, newest first, and at most this many in all, when the evidence is taken from the stream. */
const STREAM_PAGE = 1_000;
const STREAM_SCAN_MAX = 200_000;

/**
 * Messages of a conversation still in the stream from the ten minutes
 * before the filing, as evidence rows (oldest first): the 50 just before the
 * filing and any the filing names. Read newest first, a page at a time, so
 * a backlog (the outage this path is for) never cuts off the messages right
 * before the report; it stops once it has those, at the window's start, or
 * after {@link STREAM_SCAN_MAX} entries.
 */
async function pendingRows(context: JobContext, data: ReportEvidenceJob): Promise<Record<string, unknown>[]> {
  if (!data.conversationId) return [];
  const filedMs = idTime(data.filingId).getTime();
  const stream = context.services.keys.stream('msg');
  const start = String(filedMs - EVIDENCE_MAX_WAIT_MS);
  const named = new Set(data.messageIds);
  const found = new Set<string>();
  const rows: Record<string, unknown>[] = [];
  let recent = 0;
  let end = String(filedMs + 5_000);
  let scanned = 0;
  for (;;) {
    const entries = (await context.redis.xrevrange(stream, end, start, 'COUNT', STREAM_PAGE)) as [string, string[]][];
    for (const [, flat] of entries) {
      const fields: Record<string, string> = {};
      for (let i = 0; i + 1 < flat.length; i += 2) fields[flat[i]!] = flat[i + 1]!;
      if (fields['m'] !== data.conversationId) continue;
      try {
        const m = parseMessageEntry(fields);
        if (BigInt(m.id) >= BigInt(data.filingId)) continue;
        const isNamed = named.has(m.id);
        if (recent >= EVIDENCE_CONTEXT_MESSAGES && !isNamed) continue;
        if (isNamed) found.add(m.id);
        else recent += 1;
        rows.push({
          id: m.id,
          senderId: m.senderId,
          ...(m.refId ? { refId: m.refId } : {}),
          kind: m.kind,
          flags: m.flags,
          ...(m.body !== null ? { body: m.body } : {}),
          atMs: idTime(m.id).getTime(),
          fromStream: true,
        });
      } catch {
        // A malformed entry is the writer's to dead-letter.
      }
    }
    scanned += entries.length;
    const done = recent >= EVIDENCE_CONTEXT_MESSAGES && found.size >= named.size;
    if (done || entries.length < STREAM_PAGE || scanned >= STREAM_SCAN_MAX) {
      if (!done && scanned >= STREAM_SCAN_MAX) context.log.warn({ reportId: data.reportId, scanned }, 'report evidence: stream scan stopped at its cap');
      break;
    }
    // The next page ends just before the oldest entry of this one.
    end = `(${entries.at(-1)![0]}`;
  }
  return rows.reverse();
}

export type ReportEvidenceResult = { outcome: 'copied' | 'gone'; messages: number; waitedMs: number; fromStream: number };

export async function reportEvidenceJob(job: Job, context: JobContext, now: () => number = Date.now): Promise<ReportEvidenceResult> {
  const { services, redis, log } = context;
  const data = reportEvidenceJobSchema.parse(job.data);
  const waited = now() - data.queuedAtMs;
  const watermark = await readWatermark(redis, services.keys, 'msg');
  const durable = watermark !== null && watermark > BigInt(data.filingId);
  if (!durable && waited < EVIDENCE_MAX_WAIT_MS) await later(job, context, RECHECK_MS);
  const pending = durable ? [] : await pendingRows(context, data);
  if (!durable) log.warn({ reportId: data.reportId, pending: pending.length }, 'report evidence: the stream is not durable yet; its messages are copied from it');
  let copied: number;
  try {
    copied = await writeChatEvidence(services.pg, {
      reportId: data.reportId,
      filingId: data.filingId,
      matchId: data.conversationId,
      messageIds: data.messageIds,
      context: EVIDENCE_CONTEXT_MESSAGES,
      pending,
    });
  } catch (error) {
    if (isTransientDatabaseError(error)) return later(job, context, OUTAGE_RECHECK_MS);
    throw error;
  }
  return { outcome: copied < 0 ? 'gone' : 'copied', messages: Math.max(0, copied), waitedMs: waited, fromStream: pending.length };
}

export type ReportFileResult = { outcome: 'filed' | 'not_found'; reportId?: string };

export async function reportFileJob(job: Job, context: JobContext): Promise<ReportFileResult> {
  const { services, redis, log } = context;
  const data = reportFileJobSchema.parse(job.data);
  let outcome;
  try {
    outcome = await fileReport(services.pg, {
      reportId: data.filingId,
      reporterId: data.reporterId,
      targetId: data.targetId,
      context: data.context,
      reason: data.reason,
      details: data.details ?? undefined,
      conversationId: data.conversationId ?? undefined,
      messageIds: data.messageIds.length > 0 ? data.messageIds : undefined,
      photoId: data.photoId ?? undefined,
      callId: data.callId ?? undefined,
      block: data.block,
    });
  } catch (error) {
    if (isTransientDatabaseError(error)) return later(job, context, OUTAGE_RECHECK_MS);
    throw error;
  }
  if (outcome.outcome === 'not_found') {
    log.info({ filingId: data.filingId }, 'deferred report: nothing to report (the person or what it named is not theirs)');
    return { outcome: 'not_found' };
  }
  const block = outcome.block;
  if (block?.found) {
    // The block's Valkey side and events, as the API does them for a report filed at once.
    const ended = block.match?.state === 3 ? block.match : null;
    await applyBlockKv({ redis, cache: services.cache, keys: services.keys }, data.reporterId, data.targetId, ended);
    // A call the two are in ends with the conversation.
    if (ended) await endCallsOf(context, [ended]);
    if (ended && block.endedNow) {
      if (services.realtime && data.blockEventId) {
        const channels = [ended.lo, ended.hi].map((uid) => userChannel(services.publicIds.user.encode(uid)));
        await services.realtime
          .broadcast(channels, realtimeEnvelope('conversation_end', data.blockEventId, Date.now(), { conversationId: ended.matchId }))
          .catch((error: unknown) => log.warn({ err: error }, 'deferred report: block event not published'));
      }
      const days = (await configNumber(services.pg, 'retention.unmatched_messages_days').catch(() => null)) ?? DEFAULT_UNMATCHED_DAYS;
      await queueJob(redis, context.config.queuePrefix, {
        queue: ACCOUNT_QUEUE,
        name: 'unmatch-purge',
        id: jobId('unmatch-purge', ended.matchId),
        data: { matchId: ended.matchId },
        delayMs: days * DAY_MS,
        attempts: 5,
        backoffMs: 60_000,
      });
    }
  }
  if (data.context === 2) {
    await queueJob(redis, context.config.queuePrefix, {
      queue: 'safety',
      name: evidenceJobNames.reportEvidence,
      id: chatJobIds.reportEvidence(data.filingId),
      data: {
        reportId: outcome.reportId,
        filingId: data.filingId,
        reporterId: data.reporterId,
        targetId: data.targetId,
        conversationId: data.conversationId,
        messageIds: data.messageIds,
        queuedAtMs: data.queuedAtMs,
      },
      attempts: 10,
      backoffMs: 30_000,
    });
  }
  log.info({ filingId: data.filingId, reportId: outcome.reportId, waitedMs: Date.now() - data.queuedAtMs }, 'deferred report: filed');
  return { outcome: 'filed', reportId: outcome.reportId };
}

export interface RequestsSweepResult {
  leased: boolean;
  expired: number;
  deleted: number;
}

export async function requestsSweepJob(context: JobContext): Promise<RequestsSweepResult> {
  const { services, redis, log } = context;
  const result: RequestsSweepResult = { leased: false, expired: 0, deleted: 0 };
  if (!(await takeLease(redis, services.keys.jobLease('requests-sweep'), 3_600_000, context.config.workerId))) return result;
  result.leased = true;
  for (;;) {
    const n = await expireMessageRequests(services.pg, SWEEP_CHUNK);
    result.expired += n;
    if (n < SWEEP_CHUNK) break;
  }
  for (;;) {
    const n = await deleteDecidedRequests(services.pg, SWEEP_CHUNK);
    result.deleted += n;
    if (n < SWEEP_CHUNK) break;
  }
  log.info(result, 'requests sweep: done');
  return result;
}
