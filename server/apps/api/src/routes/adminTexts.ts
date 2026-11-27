import { adminDecideTexts, adminTextQueue, type AdminTextRow, type TextStateSnapshot } from '@app/db';
import {
  adminTextApproveRequestSchema,
  adminTextDecisionSchema,
  adminTextQueueQuerySchema,
  adminTextQueueSchema,
  adminTextRejectRequestSchema,
  publicUidSchema,
  textRejectReason,
  textState,
  type RealtimePayload,
} from '@app/shared';
import type { FastifyInstance } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { adminWrite } from '../admin/audit.js';
import { badCursor, pageOf, readCursorKey } from '../admin/cursors.js';
import { afterCommit, publishToUser, withIdLease } from '../admin/effects.js';
import { englishReason } from '../admin/reasons.js';
import { noSuchUser, personLocale, readUserParam, textItemOf } from '../admin/refs.js';
import { adminConflict } from '../admin/problems.js';
import { HttpProblem } from '../lib/problem.js';
import type { ConfigSnapshot } from '../services/cfg.js';
import { textRejectText } from '../services/me.js';
import { adminIdOf } from './adminAuth.js';

/**
 * The text queue and the decisions on a person's texts (about, job title,
 * prompt answers), from the queue and the user page:
 *
 *   GET  /v1/admin/moderation/texts                people with a text waiting, by account
 *   POST /v1/admin/moderation/texts/{id}/approve   { version }
 *   POST /v1/admin/moderation/texts/{id}/reject    { version, reason, profile?, prompts? }
 *
 * `{id}` is the person's public id and `version` the profile version the
 * admin read (a decision on texts they did not see is a 409). A rejection
 * names the parts it rejects (none named: every part that waits); the parts
 * that wait and are not named are approved. The person reads the reason in
 * their language in `GET /v1/me` and the `profile` event.
 */

const userParams = z.object({ id: publicUidSchema });
// The queue goes by account: its cursor carries the last person's public id, never their raw id.
const queueCursor = z.object({ u: publicUidSchema });

/** The `profile` event of a decision: the states after it, and the reason's text in the person's language. */
function profileEvent(cfg: ConfigSnapshot, after: TextStateSnapshot, locale: string): RealtimePayload<'profile'> {
  const lang = personLocale(locale);
  const rejected = textState.code('rejected');
  return {
    textState: textState.name(after.textState),
    ...(after.textState === rejected ? { textRejectReason: textRejectText(cfg, after.textRejectReason, lang) } : {}),
    prompts: after.prompts.map((p) => ({
      position: p.position,
      status: textState.name(p.status),
      ...(p.status === rejected ? { rejectReason: textRejectText(cfg, p.rejectReason, lang) } : {}),
    })),
  };
}

/** The states of a person's texts as a decision answers them, from the text view. */
function snapshotOf(texts: AdminTextRow): TextStateSnapshot {
  return {
    textState: texts.textState,
    ...(texts.textRejectReason !== null ? { textRejectReason: texts.textRejectReason } : {}),
    prompts: texts.prompts.map((p) => ({ position: p.position, status: p.status, ...(p.rejectReason !== null ? { rejectReason: p.rejectReason } : {}) })),
  };
}

async function decide(
  app: FastifyInstance,
  request: Parameters<typeof adminWrite>[1],
  input: { publicUid: string; version: number; reject: null | { reason: number; profile: boolean | null; prompts: number[] | null; bodyPrompts: number[] } },
) {
  const userId = readUserParam(app, input.publicUid);
  const cfg = app.cfg.get();
  const adminId = adminIdOf(request);
  const actionId = await withIdLease(() => app.ids.nextId());
  const reject = input.reject;
  const result = await adminWrite(app, request, async (tx, trail) => {
    const decided = await adminDecideTexts(tx, {
      userId,
      version: input.version,
      adminId,
      rejectProfile: reject ? reject.profile : false,
      rejectPrompts: reject ? reject.prompts : [],
      reasonCode: reject ? reject.reason : null,
      actionId,
      reasonText: reject ? englishReason(cfg, 'text', reject.reason) : null,
    });
    const outcome = decided.outcome;
    switch (outcome.outcome) {
      case 'missing':
        throw noSuchUser();
      case 'stale':
        throw adminConflict('stale', 'The profile changed; reload it.');
      case 'invalid_part': {
        const errors =
          outcome.part === 'profile'
            ? [{ in: 'body' as const, pointer: '/profile', code: 'not_a_part', message: 'There is no about or job text to reject.' }]
            : (outcome.positions ?? []).map((position) => ({
                in: 'body' as const,
                pointer: `/prompts/${Math.max(0, reject?.bodyPrompts.indexOf(position) ?? 0)}`,
                code: 'not_a_part',
                message: 'There is no text answer at this position.',
              }));
        throw new HttpProblem('field_invalid', { detail: 'A part named is not there.', errors });
      }
      case 'unchanged':
        trail.unchanged();
        break;
      case 'decided':
        trail.record({
          action: reject ? 'text.reject' : 'text.approve',
          target: 'user',
          targetId: userId,
          detail: {
            reason: reject ? textRejectReason.name(reject.reason) : null,
            parts: outcome.rejected,
            before: outcome.before,
            after: outcome.after,
            actionId: outcome.actionId,
          },
        });
        break;
    }
    if (!decided.texts) throw noSuchUser();
    return { outcome, texts: decided.texts };
  });
  const outcome = result.outcome;
  if (outcome.outcome !== 'decided' && outcome.outcome !== 'unchanged') throw new Error('unreachable');
  // A repeated decision (unchanged) runs the side again with the texts as they are: it is idempotent, and so
  // repairs a side that failed before (the own view would otherwise be served stale until it expires).
  const after = outcome.outcome === 'decided' ? outcome.after : snapshotOf(result.texts);
  const sideEffects = await afterCommit(
    request,
    'text decision',
    async () => {
      if ((await app.account.changed(userId)) === null) throw new Error('account version not bumped');
      await publishToUser(app, userId, 'profile', profileEvent(cfg, after, outcome.locale));
    },
    { userId: input.publicUid },
  );
  return { texts: textItemOf(app, cfg, result.texts), sideEffects };
}

export const adminTextRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['admin'];
  const decideGuard = app.requirePermission('moderation.decide');

  app.get(
    '/v1/admin/moderation/texts',
    {
      preHandler: app.requirePermission('moderation.read'),
      config: { pgBudget: 1 },
      schema: { tags, summary: 'People with an about, job or prompt answer waiting for a human', querystring: adminTextQueueQuerySchema, response: { 200: adminTextQueueSchema } },
    },
    async (request) => {
      const { limit, cursor } = request.query;
      const key = readCursorKey(queueCursor, cursor);
      const after = key ? app.publicIds.user.decodeId(key.u) : null;
      if (key && after === null) throw badCursor();
      const cfg = app.cfg.get();
      const rows = await adminTextQueue(app.pg, { afterUserId: after, limit: limit + 1 });
      // A person whose profile went in the meantime has no texts to show: the page keeps its place.
      const page = pageOf(rows, limit, (row) => row, (row) => ({ u: app.publicIds.user.encode(row.userId) }));
      return { items: page.items.flatMap((row) => (row.texts ? [textItemOf(app, cfg, row.texts)] : [])), nextCursor: page.nextCursor };
    },
  );

  app.post(
    '/v1/admin/moderation/texts/:id/approve',
    {
      preHandler: decideGuard,
      config: { pgBudget: 2 },
      schema: { tags, summary: "Approve every part of a person's texts that waits", params: userParams, body: adminTextApproveRequestSchema, response: { 200: adminTextDecisionSchema } },
    },
    async (request) => decide(app, request, { publicUid: request.params.id, version: request.body.version, reject: null }),
  );

  app.post(
    '/v1/admin/moderation/texts/:id/reject',
    {
      preHandler: decideGuard,
      config: { pgBudget: 2 },
      schema: { tags, summary: "Reject parts of a person's texts (the rest that waits is approved)", params: userParams, body: adminTextRejectRequestSchema, response: { 200: adminTextDecisionSchema } },
    },
    async (request) => {
      const { version, reason, profile, prompts } = request.body;
      const named = profile !== undefined || prompts !== undefined;
      return decide(app, request, {
        publicUid: request.params.id,
        version,
        reject: {
          reason: textRejectReason.code(reason),
          profile: named ? (profile ?? false) : null,
          prompts: named ? (prompts ?? []) : null,
          bodyPrompts: prompts ?? [],
        },
      });
    },
  );
};
