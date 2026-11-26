import {
  adminAssignReport,
  adminCloseReports,
  adminCreateHold,
  adminEvidencePhotos,
  adminHoldAndFile,
  adminHoldList,
  adminReleaseHold,
  adminReportChat,
  adminReportDetail,
  adminReportList,
  type AdminEvidenceItem,
  type AdminReportCursor,
  type ChatSnapshot,
  type EvidencePhotoRow,
} from '@app/db';
import {
  ACTION_RESOLUTIONS,
  CLOSE_RESOLUTIONS,
  adminEvidenceSchema,
  adminHoldAndFileRequestSchema,
  adminHoldAndFileSchema,
  adminHoldCreateRequestSchema,
  adminHoldListQuerySchema,
  adminHoldPageSchema,
  adminHoldReleaseRequestSchema,
  adminHoldSchema,
  adminReportAssignRequestSchema,
  adminReportCloseRequestSchema,
  adminReportCloseSchema,
  adminReportDetailSchema,
  adminReportListQuerySchema,
  adminReportPageSchema,
  adminReportSummarySchema,
  filingAuthority,
  idSchema,
  legalHoldKind,
  messageFlags,
  messageKind,
  photoStatus,
  reportContext,
  reportReason,
  reportResolution,
  reportStatus,
  requestStatus,
  textState,
  wireTime,
  type AdminEvidence,
  type AdminReportDetail,
  type AdminReportFiling,
  type EvidenceRole,
  type ReportResolution,
} from '@app/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { adminWrite } from '../admin/audit.js';
import { fieldInvalid, pageOf, readCursorKey } from '../admin/cursors.js';
import { withIdLease } from '../admin/effects.js';
import { takeAdminLimit } from '../admin/limits.js';
import { actionOf, adminRefOf, filingOf, holdOf, photoUrls, promptQuestion, reportSummaryOf } from '../admin/refs.js';
import { HttpProblem } from '../lib/problem.js';
import type { ConfigSnapshot } from '../services/cfg.js';
import { adminIdOf } from './adminAuth.js';

/**
 * Reports, their evidence and legal holds in the admin panel:
 *
 *   GET  /v1/admin/reports?view=queue|mine|unassigned|resolved
 *   GET  /v1/admin/reports/{id}                  the report's page (never chat messages)
 *   POST /v1/admin/reports/{id}/evidence         the chat snapshots, audited (reports.view_chat; 60/h per admin)
 *   POST /v1/admin/reports/{id}/assign           { to, from }
 *   POST /v1/admin/reports/{id}/resolve          { resolution (with an action), note?, sameTarget? }
 *   POST /v1/admin/reports/{id}/dismiss          { resolution (without one), note?, sameTarget? }
 *   POST /v1/admin/reports/{id}/hold-and-file    { authority, externalRef? }
 *   GET  /v1/admin/holds?state=active|released
 *   POST /v1/admin/holds                         { user?, conversationId?, reportId?, kind, authorityRef? }
 *   POST /v1/admin/holds/{id}/release            { reason }
 *
 * Each write is one statement and its audit rows. The reporter is not told
 * of the outcome; the reported person hears only of an action an admin
 * takes on them (the user routes, with `reportId`). A hold changes nothing
 * the person sees: every purge path asks legal_hold_active() first.
 */

const reportParams = z.object({ id: idSchema });
const holdParams = z.object({ id: idSchema });
const openCursor = z.object({ p: z.number().int().min(0).max(100), id: idSchema });
const closedCursor = z.object({ at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/), id: idSchema });
const idCursor = z.object({ id: idSchema });

const noSuchReport = () => new HttpProblem('not_found', { detail: 'No such report.' });
/** Audited chat views per admin and hour (the other sensitive view, the phone, allows 20). */
export const VIEW_CHAT_PER_HOUR = 60;

function modFlags(mask: number | undefined): string[] {
  if (!mask) return [];
  return messageFlags.names.filter((name) => (mask & messageFlags.code(name)) !== 0);
}

/** The filings of a report's evidence (its chat aside), with the photos they name as they are now. */
function filingsOf(app: FastifyInstance, cfg: ConfigSnapshot, items: readonly AdminEvidenceItem[], photos: ReadonlyMap<string, EvidencePhotoRow>): AdminReportFiling[] {
  const photoRef = (id: string, size: 'url' | 'thumbUrl') => {
    const now = photos.get(id);
    if (!now) return { id };
    const status = photoStatus.nameOrUndefined(now.status);
    const link = status && status !== 'processing' ? photoUrls(app, id, now.blobVer)[size] : undefined;
    return { id, ...(status ? { status } : {}), ...(link ? { [size]: link } : {}) };
  };
  return items.map((item) => {
    const profile = item.profile;
    return {
      id: item.reportId,
      at: wireTime(item.atMs),
      context: reportContext.nameOrUndefined(item.context) ?? 'profile',
      reason: reportReason.nameOrUndefined(item.reason) ?? 'other',
      details: item.details ?? null,
      ...(item.conversationId ? { conversationId: item.conversationId } : {}),
      messages: item.messageIds?.length ?? 0,
      ...(item.callId ? { callId: item.callId } : {}),
      ...(item.photo ? { photo: photoRef(item.photo.id, 'url') } : {}),
      ...(profile
        ? {
            profile: {
              name: profile.name ?? null,
              about: profile.about ?? null,
              job: profile.job ?? null,
              textState: textState.nameOrUndefined(profile.textState) ?? null,
              prompts: (profile.prompts ?? []).map((p) => ({
                promptId: p.promptId,
                question: promptQuestion(cfg, p.promptId),
                answer: p.answer ?? null,
                status: textState.nameOrUndefined(p.status) ?? null,
              })),
              photos: (profile.photos ?? []).map((id) => photoRef(id, 'thumbUrl')),
            },
          }
        : {}),
    };
  });
}

function evidencePhotoIds(items: readonly AdminEvidenceItem[]): string[] {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.photo) ids.add(item.photo.id);
    for (const id of item.profile?.photos ?? []) ids.add(id);
  }
  return [...ids];
}

function chatOf(snapshots: readonly ChatSnapshot[], reporterId: string | null, targetId: string, named: ReadonlySet<string>): AdminEvidence['chat'] {
  // The raw sender never leaves: who wrote it, as the report sees them.
  const role = (senderId: string): EvidenceRole => (senderId === reporterId ? 'reporter' : senderId === targetId ? 'reported' : 'other');
  return snapshots.map((s) => ({
    filingId: s.filingId,
    conversationId: s.conversationId ?? null,
    takenAt: wireTime(s.takenAtMs),
    messages: (s.messages ?? []).map((m) => ({
      id: m.id,
      from: role(m.senderId),
      kind: messageKind.nameOrUndefined(m.kind) ?? 'text',
      flags: modFlags(m.flags),
      body: m.body ?? null,
      at: wireTime(m.atMs),
      late: m.fromStream === true,
      named: named.has(m.id),
    })),
    requests: (s.requests ?? []).map((r) => ({
      id: r.requestId,
      from: role(r.senderId),
      status: requestStatus.nameOrUndefined(r.status) ?? 'pending',
      body: r.body ?? null,
      at: wireTime(r.atMs),
    })),
  }));
}

/** The record kind (moderation_actions.kind) a penalty resolution stands for. */
const PENALTY_OF_RESOLUTION: Partial<Record<ReportResolution, number>> = { warning: 1, suspension: 2, ban: 3, shadowban: 4 };

async function closeReport(app: FastifyInstance, request: FastifyRequest, reportId: string, kind: 'resolve' | 'dismiss', body: { resolution: ReportResolution; note?: string | undefined; sameTarget?: boolean | undefined }) {
  const group: readonly ReportResolution[] = kind === 'resolve' ? ACTION_RESOLUTIONS : CLOSE_RESOLUTIONS;
  if (!group.includes(body.resolution)) {
    throw fieldInvalid('/resolution', 'wrong_resolution', kind === 'resolve' ? 'This resolution closes a report without an action.' : 'This resolution closes a report with an action.');
  }
  const status = kind === 'resolve' ? 3 : body.resolution === 'duplicate' ? 5 : 4;
  const adminId = adminIdOf(request);
  const note = body.note ? body.note : null;
  const sameTarget = body.sameTarget ?? false;
  const reports = await adminWrite(app, request, async (tx, trail) => {
    const closed = await adminCloseReports(tx, {
      reportId,
      status,
      resolution: reportResolution.code(body.resolution),
      adminId,
      sameTarget,
      retentionDays: app.cfg.get().app['retention.report_evidence_days'],
      penaltyKind: PENALTY_OF_RESOLUTION[body.resolution] ?? null,
    });
    if (closed.outcome === 'missing') throw noSuchReport();
    if (closed.outcome === 'closed_already') throw new HttpProblem('conflict', { detail: 'Already closed.' });
    // A report never reads "closed with a ban" (or a warning, a suspension, a shadowban) that was not taken.
    if (closed.outcome === 'no_action') throw fieldInvalid('/resolution', 'wrong_resolution', 'No such action was taken on this person since the report.');
    for (const report of closed.reports) {
      trail.record({
        action: kind === 'resolve' ? 'report.resolve' : 'report.dismiss',
        target: 'report',
        targetId: report.id,
        detail: { status: reportStatus.name(status), resolution: body.resolution, note, sameTarget },
      });
    }
    return closed.reports;
  });
  return { items: reports.map((row) => reportSummaryOf(app, row)) };
}

export const adminReportRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['admin'];
  const read = app.requirePermission('reports.read');
  const hold = app.requirePermission('reports.hold');

  app.get(
    '/v1/admin/reports',
    {
      preHandler: read,
      config: { pgBudget: 1 },
      schema: { tags, summary: 'Reports: the queue, mine, unassigned, or closed', querystring: adminReportListQuerySchema, response: { 200: adminReportPageSchema } },
    },
    async (request) => {
      const { view, limit, cursor } = request.query;
      let key: AdminReportCursor | null = null;
      if (cursor !== undefined) key = view === 'resolved' ? readCursorKey(closedCursor, cursor) : readCursorKey(openCursor, cursor);
      const rows = await adminReportList(app.pg, { view, adminId: adminIdOf(request), cursor: key, limit: limit + 1 });
      return pageOf(
        rows,
        limit,
        (row) => reportSummaryOf(app, row.report),
        (row) => (view === 'resolved' ? { at: row.resolvedKey ?? '', id: row.report.id } : { p: row.priority, id: row.report.id }),
      );
    },
  );

  app.get(
    '/v1/admin/reports/:id',
    {
      preHandler: read,
      config: { pgBudget: 2 },
      schema: { tags, summary: "A report's page: filings, holds, actions, other reports, history", params: reportParams, response: { 200: adminReportDetailSchema } },
    },
    async (request): Promise<AdminReportDetail> => {
      const cfg = app.cfg.get();
      const row = await adminReportDetail(app.pg, request.params.id);
      if (!row) throw noSuchReport();
      const ids = evidencePhotoIds(row.items);
      const photos = ids.length > 0 ? await adminEvidencePhotos(app.pg, ids) : [];
      const summary = reportSummaryOf(app, row.report);
      const contact = cfg.app['safety.child_safety_contact'];
      return {
        ...summary,
        details: row.details,
        conversationId: row.conversationId,
        evidenceAt: row.evidenceAtMs === null ? null : wireTime(row.evidenceAtMs),
        filings: filingsOf(app, cfg, row.items, new Map(photos.map((p) => [p.id, p]))),
        holds: row.holds.map((h) => holdOf(app, h)),
        filing: row.filing ? filingOf(row.filing) : null,
        actions: row.actions.map((a) => actionOf(a)),
        otherOpen: row.otherOpen.map((r) => reportSummaryOf(app, r)),
        history: row.history.map((a) => ({ id: a.id, at: wireTime(a.atMs), admin: adminRefOf(a.admin), action: a.action })),
        ...(summary.reason === 'child_safety' && (contact.name || contact.email) ? { childSafetyContact: { name: contact.name, email: contact.email } } : {}),
      };
    },
  );

  app.post(
    '/v1/admin/reports/:id/evidence',
    {
      preHandler: app.requirePermission('reports.view_chat'),
      config: { pgBudget: 2 },
      schema: { tags, summary: "A report's chat snapshots (each view is audited)", params: reportParams, response: { 200: adminEvidenceSchema } },
    },
    async (request, reply): Promise<AdminEvidence> => {
      const reportId = request.params.id;
      // Each admin reads at most VIEW_CHAT_PER_HOUR chats an hour; a call that shows nothing gives its count back.
      const ticket = await takeAdminLimit(app, request, 'admin_view_chat', VIEW_CHAT_PER_HOUR);
      let evidence: Awaited<ReturnType<typeof adminReportChat>> = null;
      try {
        evidence = await adminWrite(app, request, async (tx, trail) => {
          const found = await adminReportChat(tx, reportId);
          if (!found) throw noSuchReport();
          if (found.chat.length === 0) {
            // Nothing to show is nothing seen: no row.
            trail.unchanged();
          } else {
            const messages = found.chat.reduce((n, s) => n + (s.messages?.length ?? 0) + (s.requests?.length ?? 0), 0);
            trail.record({ action: 'report.view_chat', target: 'report', targetId: reportId, detail: { snapshots: found.chat.length, messages } });
          }
          return found;
        });
      } finally {
        // Counted only once committed with its audit row (a 404, a refused row or nothing to show gives it back).
        if (!evidence || evidence.chat.length === 0) await ticket.refund();
      }
      reply.header('cache-control', 'no-store');
      return {
        evidenceAt: evidence.evidenceAtMs === null ? null : wireTime(evidence.evidenceAtMs),
        chat: chatOf(evidence.chat, evidence.reporterId, evidence.targetId, new Set(evidence.named)),
      };
    },
  );

  app.post(
    '/v1/admin/reports/:id/assign',
    {
      preHandler: app.requirePermission('reports.assign'),
      config: { pgBudget: 2 },
      schema: { tags, summary: 'Take a report, give it to an admin, or give it back', params: reportParams, body: adminReportAssignRequestSchema, response: { 200: adminReportSummarySchema } },
    },
    async (request) => {
      const reportId = request.params.id;
      const to = request.body.to === null ? null : Number(request.body.to);
      const from = request.body.from === null ? null : Number(request.body.from);
      const report = await adminWrite(app, request, async (tx, trail) => {
        const outcome = await adminAssignReport(tx, { reportId, to, from });
        switch (outcome.outcome) {
          case 'missing':
            throw noSuchReport();
          case 'closed':
            throw new HttpProblem('conflict', { detail: 'Already closed.' });
          case 'unknown_admin':
            throw fieldInvalid('/to', 'unknown_admin', 'No such admin, or the account is disabled.');
          case 'taken':
            throw new HttpProblem('conflict', { detail: 'Someone else took it.' });
          case 'unchanged':
            trail.unchanged();
            return outcome.report;
          case 'assigned':
            trail.record({
              action: 'report.assign',
              target: 'report',
              targetId: reportId,
              detail: {
                before: { assignee: outcome.before.assignee === null ? null : String(outcome.before.assignee), status: reportStatus.name(outcome.before.status) },
                after: { assignee: to === null ? null : String(to), status: reportStatus.name(outcome.report.status) },
              },
            });
            return outcome.report;
        }
      });
      return reportSummaryOf(app, report);
    },
  );

  for (const kind of ['resolve', 'dismiss'] as const) {
    app.post(
      `/v1/admin/reports/:id/${kind}`,
      {
        preHandler: app.requirePermission('reports.resolve'),
        config: { pgBudget: 2 },
        schema: {
          tags,
          summary: kind === 'resolve' ? 'Close a report with an action' : 'Close a report without an action',
          params: reportParams,
          body: adminReportCloseRequestSchema,
          response: { 200: adminReportCloseSchema },
        },
      },
      async (request) => closeReport(app, request, request.params.id, kind, request.body),
    );
  }

  app.post(
    '/v1/admin/reports/:id/hold-and-file',
    {
      preHandler: hold,
      config: { pgBudget: 2 },
      schema: { tags, summary: 'File a report with an authority and keep what it is about', params: reportParams, body: adminHoldAndFileRequestSchema, response: { 200: adminHoldAndFileSchema } },
    },
    async (request) => {
      const reportId = request.params.id;
      const adminId = adminIdOf(request);
      const externalRef = request.body.externalRef ?? null;
      const [userHoldId, matchHoldId] = await withIdLease(() => [app.ids.nextId(), app.ids.nextId()] as const);
      const filed = await adminWrite(app, request, async (tx, trail) => {
        const outcome = await adminHoldAndFile(tx, { reportId, adminId, authority: filingAuthority.code(request.body.authority), externalRef, userHoldId, matchHoldId });
        if (outcome.outcome === 'missing') throw noSuchReport();
        if (outcome.outcome === 'filed_already') throw new HttpProblem('conflict', { detail: 'Already filed.' });
        trail.record({
          action: 'report.file',
          target: 'report',
          targetId: reportId,
          detail: { authority: request.body.authority, externalRef, holds: outcome.created.map((h) => h.id) },
        });
        for (const h of outcome.created) {
          trail.record({
            action: 'hold.create',
            target: 'legal_hold',
            targetId: h.id,
            detail: {
              kind: legalHoldKind.nameOrUndefined(h.kind) ?? null,
              ...(h.user ? { user: app.publicIds.user.encode(h.user.id) } : {}),
              conversationId: h.conversationId,
              reportId,
              authorityRef: h.authorityRef,
            },
          });
        }
        return outcome;
      });
      return { filing: filingOf(filed.filing), holds: filed.holds.map((h) => holdOf(app, h)) };
    },
  );

  app.get(
    '/v1/admin/holds',
    {
      preHandler: hold,
      config: { pgBudget: 1 },
      schema: { tags, summary: 'Legal holds, newest first: active or released', querystring: adminHoldListQuerySchema, response: { 200: adminHoldPageSchema } },
    },
    async (request) => {
      const { state, limit, cursor } = request.query;
      const key = readCursorKey(idCursor, cursor);
      const rows = await adminHoldList(app.pg, { state, beforeId: key?.id ?? null, limit: limit + 1 });
      return pageOf(rows, limit, (row) => holdOf(app, row), (row) => ({ id: row.id }));
    },
  );

  app.post(
    '/v1/admin/holds',
    {
      preHandler: hold,
      config: { pgBudget: 2 },
      schema: { tags, summary: 'Place a legal hold on an account or a conversation', body: adminHoldCreateRequestSchema, response: { 201: adminHoldSchema } },
    },
    async (request, reply) => {
      const body = request.body;
      if (body.user === undefined && body.conversationId === undefined) throw fieldInvalid('', 'no_target', 'Name a person or a conversation.');
      const userId = body.user === undefined ? null : app.publicIds.user.decodeId(body.user);
      if (body.user !== undefined && userId === null) throw fieldInvalid('/user', 'unknown_user', 'No such person.');
      const adminId = adminIdOf(request);
      const holdId = await withIdLease(() => app.ids.nextId());
      const created = await adminWrite(app, request, async (tx, trail) => {
        const outcome = await adminCreateHold(tx, {
          id: holdId,
          userId,
          matchId: body.conversationId ?? null,
          reportId: body.reportId ?? null,
          kind: legalHoldKind.code(body.kind),
          adminId,
          authorityRef: body.authorityRef ?? null,
        });
        if (outcome.outcome !== 'created') {
          const [pointer, message] =
            outcome.outcome === 'unknown_user' ? ['/user', 'No such person.'] : outcome.outcome === 'unknown_conversation' ? ['/conversationId', 'No such conversation.'] : ['/reportId', 'No such report.'];
          throw fieldInvalid(pointer, outcome.outcome, message);
        }
        trail.record({
          action: 'hold.create',
          target: 'legal_hold',
          targetId: holdId,
          detail: {
            kind: body.kind,
            ...(body.user ? { user: body.user } : {}),
            conversationId: body.conversationId ?? null,
            reportId: body.reportId ?? null,
            authorityRef: body.authorityRef ?? null,
          },
        });
        return outcome.hold;
      });
      reply.code(201);
      return holdOf(app, created);
    },
  );

  app.post(
    '/v1/admin/holds/:id/release',
    {
      preHandler: hold,
      config: { pgBudget: 2 },
      schema: { tags, summary: 'Release a legal hold, with the reason', params: holdParams, body: adminHoldReleaseRequestSchema, response: { 200: adminHoldSchema } },
    },
    async (request) => {
      const holdId = request.params.id;
      const adminId = adminIdOf(request);
      const reason = request.body.reason;
      const released = await adminWrite(app, request, async (tx, trail) => {
        const outcome = await adminReleaseHold(tx, { holdId, adminId, reason });
        if (outcome.outcome === 'missing') throw new HttpProblem('not_found', { detail: 'No such hold.' });
        if (outcome.outcome === 'unchanged') trail.unchanged();
        else trail.record({ action: 'hold.release', target: 'legal_hold', targetId: holdId, detail: { reason } });
        return outcome.hold;
      });
      return holdOf(app, released);
    },
  );

};
