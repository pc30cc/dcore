import { StatementCounter, type StatementTally } from '@app/db';
import { PROBLEM_CONTENT_TYPE, problem } from '@app/shared';
import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction, RouteOptions } from 'fastify';
import fp from 'fastify-plugin';

/**
 * The PostgreSQL budget of each route. Every route declares how many
 * statements it may send (`config: { pgBudget: 0 }`); the pool counts them
 * per request (`@app/db` statement counter).
 *
 * - `enforce` (tests): the statement past the budget is refused, and the
 *   request ends in a 500 that names the budget, even when the handler
 *   caught the error. The count is sent back as `x-pg-statements`.
 * - `count` (development): counted and sent back, nothing refused.
 * - `off` (production): nothing is counted.
 *
 * Transaction control is not counted (`tx(3)` is a budget of 3).
 */

export type PgBudgetMode = 'off' | 'count' | 'enforce';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Statements this route may send per request (the worst case of its paths). */
    pgBudget?: number;
  }
  interface FastifyRequest {
    pgTally: StatementTally | null;
  }
  interface FastifyInstance {
    /** Routes registered without a `pgBudget` (method and path). */
    routesWithoutBudget(): string[];
  }
}

export interface PgBudgetOptions {
  mode: PgBudgetMode;
  counter: StatementCounter;
}

export const STATEMENTS_HEADER = 'x-pg-statements';

export const pgBudgetPlugin = fp<PgBudgetOptions>(
  async (app, { mode, counter }) => {
    const missing: string[] = [];
    app.addHook('onRoute', (route: RouteOptions) => {
      const config = route.config as { pgBudget?: unknown } | undefined;
      // HEAD mirrors a GET; OPTIONS answers CORS preflights and never reaches the database.
      const methods = ([] as string[]).concat(route.method);
      if (typeof config?.pgBudget !== 'number' && !methods.every((m) => m === 'HEAD' || m === 'OPTIONS')) {
        missing.push(`${String(route.method)} ${route.url}`);
      }
    });
    app.decorate('routesWithoutBudget', () => [...missing]);
    app.decorateRequest('pgTally', null);
    if (mode === 'off') return;

    const enter = (request: FastifyRequest, _reply: FastifyReply, done: HookHandlerDoneFunction) => {
      if (request.pgTally === null) {
        const budget = request.routeOptions.config.pgBudget;
        request.pgTally = StatementCounter.tally(mode === 'enforce' && typeof budget === 'number' ? budget : undefined);
      }
      // Entered again after the body is read: the parser's callbacks run outside the request's context.
      counter.run(request.pgTally, done);
    };
    app.addHook('onRequest', enter);
    app.addHook('preHandler', enter);

    app.addHook('onSend', async (request, reply, payload) => {
      const tally = request.pgTally;
      if (!tally) return payload;
      reply.header(STATEMENTS_HEADER, String(tally.statements));
      if (mode === 'enforce' && tally.exceeded) {
        request.log.error({ budget: tally.budget, statements: tally.texts }, 'pg budget exceeded');
        reply.code(500).type(PROBLEM_CONTENT_TYPE);
        return JSON.stringify(
          problem('internal', {
            requestId: request.id,
            detail: `PostgreSQL budget of ${tally.budget ?? 0} statement(s) exceeded: ${tally.texts.join(' | ')}`,
          }),
        );
      }
      return payload;
    });
  },
  { name: 'pg-budget', fastify: '5.x' },
);
