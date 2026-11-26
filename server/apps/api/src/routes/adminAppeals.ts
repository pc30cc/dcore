import { adminAppealList, adminDecideAppeal, type AppealDecision } from '@app/db';
import {
  accountStatus,
  adminAppealDecisionRequestSchema,
  adminAppealDecisionSchema,
  adminAppealListQuerySchema,
  adminAppealPageSchema,
  appealStatus,
  idSchema,
} from '@app/shared';
import { moderationActionWire } from '@app/shared/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { adminWrite } from '../admin/audit.js';
import { pageOf, readCursorKey } from '../admin/cursors.js';
import { adminModeration, afterCommit, publishToUser, withIdLease } from '../admin/effects.js';
import { accountStateOf as stateOf, appealOf, removedBanAuditOf, userReadScope } from '../admin/refs.js';
import { HttpProblem } from '../lib/problem.js';
import { adminIdOf } from './adminAuth.js';

/**
 * Appeals in the admin panel:
 *
 *   GET  /v1/admin/appeals?status=open|decided   open oldest first, decided newest first
 *   POST /v1/admin/appeals/{id}/uphold           { text }   the action stays
 *   POST /v1/admin/appeals/{id}/overturn         { text }   the action is lifted at once
 *
 * The decision is one statement (appeal_decide, with the lift of an
 * overturn) and its audit row. The person reads the decision text: an
 * overturn moves their account back (the restricted session is refused,
 * the refresh gives a full one; conversations a ban ended stay ended), an
 * uphold reaches their app as the action with its decision. An appeal of an
 * account the purge emptied since can still be decided: an overturn lifts
 * the action on the record and has nothing to send.
 */

const appealParams = z.object({ id: idSchema });
const appealCursor = z.object({ id: idSchema });

async function decide(app: FastifyInstance, request: FastifyRequest, appealId: string, overturn: boolean, text: string) {
  const adminId = adminIdOf(request);
  const liftId = await withIdLease(() => app.ids.nextId());
  const decided = await adminWrite(app, request, async (tx, trail) => {
    const result = await adminDecideAppeal(tx, { appealId, overturn, adminId, text, liftId });
    const outcome: AppealDecision = result.outcome;
    if (!('actionId' in outcome)) {
      if (outcome.outcome === 'decided') throw new HttpProblem('conflict', { detail: 'Already decided.' });
      // Upholding a penalty that was lifted would tell its person it stands.
      if (outcome.outcome === 'lifted') throw new HttpProblem('conflict', { detail: 'The action was lifted.' });
      throw new HttpProblem('not_found', { detail: 'No such appeal.' });
    }
    if (!result.appeal) throw new HttpProblem('not_found', { detail: 'No such appeal.' });
    trail.record({
      action: overturn ? 'appeal.overturn' : 'appeal.uphold',
      target: 'appeal',
      targetId: appealId,
      detail: {
        actionId: outcome.actionId,
        text,
        before: { status: 'open' },
        after: { status: appealStatus.name(result.appeal.status) },
        ...(outcome.outcome === 'overturned' ? { account: { before: stateOf(outcome.before), after: stateOf(outcome.after) } } : {}),
        // The purge emptied the account already: the action is lifted on the record, nothing moves.
        ...(outcome.outcome === 'overturned_purged' ? { account: null } : {}),
        ...('deviceBans' in outcome ? { deviceBansRemoved: outcome.deviceBans.length } : {}),
      },
    });
    // The device, phone and Google bans made for the action go with it, each with its row.
    if ('deviceBans' in outcome) for (const ban of outcome.deviceBans) trail.record(removedBanAuditOf(app, outcome.userId, outcome.actionId, ban, 'appeal'));
    return { outcome, appeal: result.appeal };
  });
  const { outcome, appeal } = decided;
  let sideEffects: 'done' | 'failed' = 'done';
  if (outcome.outcome === 'overturned') {
    // On a transaction the decision ran no effects of its own: the lift's Valkey and realtime side runs now.
    sideEffects = await afterCommit(request, 'moderation effects', () => adminModeration(app).effects(outcome), { appealId });
  } else if (outcome.outcome === 'upheld') {
    const wire = outcome.action ? moderationActionWire(outcome.action) : null;
    sideEffects = await afterCommit(
      request,
      'appeal decision',
      async () => {
        if ((await app.account.changed(outcome.userId, undefined, { card: false })) === null) throw new Error('account version not bumped');
        const status = accountStatus.name(appeal.user.status);
        if (wire && status !== 'purged') await publishToUser(app, outcome.userId, 'account', { status, moderation: wire });
      },
      { appealId },
    );
  }
  const removed = 'deviceBans' in outcome ? { deviceBansRemoved: outcome.deviceBans.length } : {};
  return { appeal: appealOf(app, appeal, userReadScope(app, request)), ...removed, sideEffects };
}

export const adminAppealRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['admin'];
  const decideGuard = app.requirePermission('appeals.decide');

  app.get(
    '/v1/admin/appeals',
    {
      preHandler: app.requirePermission('appeals.read'),
      config: { pgBudget: 1 },
      schema: { tags, summary: 'Appeals with their action and the person’s record', querystring: adminAppealListQuerySchema, response: { 200: adminAppealPageSchema } },
    },
    async (request) => {
      const { status, limit, cursor } = request.query;
      const key = readCursorKey(appealCursor, cursor);
      const rows = await adminAppealList(app.pg, { status, cursorId: key?.id ?? null, limit: limit + 1 });
      const scope = userReadScope(app, request);
      return pageOf(rows, limit, (row) => appealOf(app, row, scope), (row) => ({ id: row.id }));
    },
  );

  for (const kind of ['uphold', 'overturn'] as const) {
    app.post(
      `/v1/admin/appeals/:id/${kind}`,
      {
        preHandler: decideGuard,
        config: { pgBudget: 2 },
        schema: {
          tags,
          summary: kind === 'uphold' ? 'Uphold the action an appeal is about' : 'Overturn the action (it is lifted at once)',
          params: appealParams,
          body: adminAppealDecisionRequestSchema,
          response: { 200: adminAppealDecisionSchema },
        },
      },
      async (request) => decide(app, request, request.params.id, kind === 'overturn', request.body.text),
    );
  }
};
