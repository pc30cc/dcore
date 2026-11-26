import { adminBannedTermList, adminCreateBannedTerm, adminDeleteBannedTerm, adminUpdateBannedTerm, hasSqlState, SqlState, type AdminBannedTermRow, type BannedTermInput } from '@app/db';
import {
  adminBannedTermCreateSchema,
  adminBannedTermListQuerySchema,
  adminBannedTermPageSchema,
  adminBannedTermResultSchema,
  adminBannedTermUpdateSchema,
  bannedTermMatch,
  bannedTermScope,
  bannedTermSeverity,
  idSchema,
  isLocale,
  toBitmask,
  wireTime,
  type AdminBannedTerm,
  type BannedTermScope,
  type SideEffects,
} from '@app/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { adminWrite } from '../admin/audit.js';
import { fieldInvalid, pageOf, readCursorKey } from '../admin/cursors.js';
import { adminRefOf } from '../admin/refs.js';
import { HttpProblem } from '../lib/problem.js';
import { checkTerm } from '../services/bannedTerms.js';
import { adminIdOf } from './adminAuth.js';

/**
 * Banned terms in the admin panel:
 *
 *   GET    /v1/admin/banned-terms            newest first; ?q= a part of the term
 *   POST   /v1/admin/banned-terms            { term, match, severity, scope, locale?, active? } → 201
 *   PATCH  /v1/admin/banned-terms/{id}       any of those
 *   DELETE /v1/admin/banned-terms/{id}       → 204
 *
 * A pattern is RE2 syntax, run by a linear-time engine; it is checked
 * before it is stored ({@link checkTerm}: the supported subset, its size,
 * not every text). Every write has its audit row (the term
 * itself included: a rule, not personal data) and, once committed,
 * announces `cfg:changed`: every API process loads the terms again within
 * seconds and checks names, profile texts, prompt answers and messages
 * against them from then on.
 */

const termParams = z.object({ id: idSchema });
const termCursor = z.object({ id: idSchema });

function scopeNames(mask: number): BannedTermScope[] {
  return bannedTermScope.names.filter((name) => (mask & bannedTermScope.code(name)) !== 0);
}

function termOf(row: AdminBannedTermRow): AdminBannedTerm {
  return {
    id: row.id,
    term: row.term,
    match: bannedTermMatch.name(row.matchKind),
    severity: bannedTermSeverity.name(row.severity),
    scope: scopeNames(row.scope),
    locale: row.locale !== null && isLocale(row.locale) ? row.locale : null,
    active: row.active,
    createdAt: wireTime(row.createdAtMs),
    createdBy: adminRefOf(row.createdBy),
  };
}

/** What the audit row keeps of a term: the rule itself, without who made it. */
function termAudit(row: AdminBannedTermRow) {
  const { term, match, severity, scope, locale, active } = termOf(row);
  return { term, match, severity, scope, locale, active };
}

function checked(term: string, matchKind: number, pointer = '/term'): void {
  const check = checkTerm(term, bannedTermMatch.name(matchKind));
  if (!check.ok) throw fieldInvalid(pointer, check.code, check.message);
}

const exists = () => new HttpProblem('conflict', { detail: 'This term exists.' });

/** After the commit: every process loads the terms again (this one too, by the same message). */
async function announce(app: FastifyInstance, request: FastifyRequest): Promise<SideEffects> {
  if (await app.cfg.announce()) return 'done';
  request.log.warn('banned terms: saved; the announcement is retried in the background');
  return 'failed';
}

/** A unique-key refusal (a race with another save of the same term) is the same 409. */
async function keyed<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (hasSqlState(error, SqlState.uniqueViolation)) throw exists();
    throw error;
  }
}

export const adminTermRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['admin'];
  const write = app.requirePermission('moderation.terms');

  app.get(
    '/v1/admin/banned-terms',
    {
      preHandler: app.requirePermission('moderation.read'),
      config: { pgBudget: 1 },
      schema: { tags, summary: 'Banned terms, newest first', querystring: adminBannedTermListQuerySchema, response: { 200: adminBannedTermPageSchema } },
    },
    async (request) => {
      const { q, limit, cursor } = request.query;
      const key = readCursorKey(termCursor, cursor);
      const rows = await adminBannedTermList(app.pg, { q, beforeId: key?.id ?? null, limit: limit + 1 });
      return pageOf(rows, limit, termOf, (row) => ({ id: row.id }));
    },
  );

  app.post(
    '/v1/admin/banned-terms',
    {
      preHandler: write,
      config: { pgBudget: 2 },
      schema: { tags, summary: 'Add a banned term', body: adminBannedTermCreateSchema, response: { 201: adminBannedTermResultSchema } },
    },
    async (request, reply) => {
      const body = request.body;
      const input: BannedTermInput = {
        term: body.term,
        matchKind: bannedTermMatch.code(body.match),
        severity: bannedTermSeverity.code(body.severity),
        scope: toBitmask(body.scope.map((name) => bannedTermScope.code(name))),
        locale: body.locale ?? null,
        active: body.active ?? true,
      };
      checked(input.term, input.matchKind);
      const adminId = adminIdOf(request);
      const row = await adminWrite(app, request, async (tx, trail) => {
        const created = await keyed(() => adminCreateBannedTerm(tx, { ...input, adminId }));
        if (!created) throw exists();
        trail.record({ action: 'banned_term.create', target: 'banned_term', targetId: created.id, detail: { after: termAudit(created) } });
        return created;
      });
      const sideEffects = await announce(app, request);
      return reply.code(201).send({ term: termOf(row), sideEffects });
    },
  );

  app.patch(
    '/v1/admin/banned-terms/:id',
    {
      preHandler: write,
      config: { pgBudget: 2 },
      schema: { tags, summary: 'Change a banned term', params: termParams, body: adminBannedTermUpdateSchema, response: { 200: adminBannedTermResultSchema } },
    },
    async (request) => {
      const body = request.body;
      const patch: Partial<BannedTermInput> = {
        ...(body.term !== undefined ? { term: body.term } : {}),
        ...(body.match !== undefined ? { matchKind: bannedTermMatch.code(body.match) } : {}),
        ...(body.severity !== undefined ? { severity: bannedTermSeverity.code(body.severity) } : {}),
        ...(body.scope !== undefined ? { scope: toBitmask(body.scope.map((name) => bannedTermScope.code(name))) } : {}),
        ...(body.locale !== undefined ? { locale: body.locale } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
      };
      const outcome = await adminWrite(app, request, async (tx, trail) => {
        const updated = await keyed(() => adminUpdateBannedTerm(tx, request.params.id, patch));
        switch (updated.outcome) {
          case 'missing':
            throw new HttpProblem('not_found', { detail: 'No such term.' });
          case 'conflict':
            throw exists();
          case 'unchanged':
            trail.unchanged();
            return { row: updated.term, changed: false };
          case 'updated': {
            // The term as it now reads (a new match with the old text, or the other way round); refused, it rolls back.
            if (patch.term !== undefined || patch.matchKind !== undefined) checked(updated.after.term, updated.after.matchKind, patch.term !== undefined ? '/term' : '/match');
            const before = termAudit(updated.before);
            const after = termAudit(updated.after);
            const changed = (Object.keys(after) as (keyof typeof after)[]).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
            trail.record({ action: 'banned_term.update', target: 'banned_term', targetId: updated.after.id, detail: { changed, before, after } });
            return { row: updated.after, changed: true };
          }
        }
      });
      const sideEffects: SideEffects = outcome.changed ? await announce(app, request) : 'done';
      return { term: termOf(outcome.row), sideEffects };
    },
  );

  app.delete(
    '/v1/admin/banned-terms/:id',
    {
      preHandler: write,
      config: { pgBudget: 2 },
      schema: { tags, summary: 'Remove a banned term', params: termParams },
    },
    async (request, reply) => {
      await adminWrite(app, request, async (tx, trail) => {
        const removed = await adminDeleteBannedTerm(tx, request.params.id);
        if (!removed) throw new HttpProblem('not_found', { detail: 'No such term.' });
        trail.record({ action: 'banned_term.delete', target: 'banned_term', targetId: removed.id, detail: { before: termAudit(removed) } });
      });
      await announce(app, request);
      return reply.code(204).send();
    },
  );
};
