import { reportContext, reportReason, type ReportRequest } from '@app/shared';
import { chatJobIds, evidenceJobNames, type ReportEvidenceJob, type ReportFileJob } from '@app/shared/server';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { HttpProblem } from '../lib/problem.js';

/**
 * The chat side of reports, as jobs for the worker:
 *
 * - `report-evidence`: the messages a chat report is about, copied into the
 *   report once the write-behind stream is durable past it (they are often
 *   seconds old and still in `wb:msg`);
 * - `report-file`: a report that arrived while PostgreSQL could not take it
 *   is accepted (202, its id minted already) and filed by the worker once
 *   PostgreSQL is back, its block and its evidence after it. A report is
 *   never lost to an outage; only when Valkey cannot take the job either
 *   does the request fail (503, the app sends it again).
 */

export async function queueChatEvidence(
  app: FastifyInstance,
  log: FastifyBaseLogger,
  e: Omit<ReportEvidenceJob, 'queuedAtMs'>,
): Promise<void> {
  const data: ReportEvidenceJob = { ...e, queuedAtMs: Date.now() };
  await app.jobs
    .add('safety', evidenceJobNames.reportEvidence, chatJobIds.reportEvidence(e.filingId), { ...data }, { attempts: 10, backoffMs: 30_000 })
    .catch((error: unknown) => log.error({ err: error, reportId: e.reportId }, 'report: chat evidence not queued'));
}

export interface DeferredReport {
  filingId: string;
  reporterId: string;
  targetId: string;
  body: ReportRequest;
  blockEventId: string | null;
}

export async function deferReport(app: FastifyInstance, log: FastifyBaseLogger, r: DeferredReport): Promise<void> {
  const data: ReportFileJob = {
    filingId: r.filingId,
    reporterId: r.reporterId,
    targetId: r.targetId,
    context: reportContext.code(r.body.context),
    reason: reportReason.code(r.body.reason),
    details: r.body.details ?? null,
    conversationId: r.body.conversationId ?? null,
    messageIds: r.body.messageIds ?? [],
    photoId: r.body.photoId ?? null,
    callId: r.body.callId ?? null,
    block: r.body.block === true,
    blockEventId: r.blockEventId,
    queuedAtMs: Date.now(),
  };
  try {
    await app.jobs.add('safety', evidenceJobNames.reportFile, chatJobIds.reportFile(r.filingId), { ...data }, { attempts: 20, backoffMs: 30_000 });
  } catch (error) {
    throw new HttpProblem('service_unavailable', { detail: 'Send the report again in a moment.', headers: { 'retry-after': '5' }, cause: error });
  }
  log.warn({ filingId: r.filingId }, 'report: the database is unavailable; filed by the worker when it is back');
}
