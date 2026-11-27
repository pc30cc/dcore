import type { FastifyPluginAsync } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testApp } from './support.js';

/**
 * The admin API's areas (dashboard, content, revenue, growth, app, support,
 * system): one plugin each (`routes/areas/<area>.ts`), registered by
 * `app.ts` right after the audit routes. A route an area registers inside
 * its plugin gets what every admin route gets: the admin guards, the
 * statement budget and the OpenAPI document.
 */

const AREAS = ['dashboard', 'content', 'revenue', 'growth', 'app', 'support', 'system'] as const;

/** The plugins registered on the root, in order (`printPlugins`' first level). */
function rootPlugins(tree: string): string[] {
  return tree
    .split('\n')
    .map((line) => /^[├└]─[─┬] (\S+) \d+ ms$/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined && name !== 'bound');
}

describe('the admin API areas', () => {
  afterEach(() => {
    vi.resetModules();
    for (const area of AREAS) vi.doUnmock(`../src/routes/areas/${area}.js`);
  });

  it('are registered once each, in order, right after the audit routes', async () => {
    const app = await testApp();
    try {
      await app.ready();
      const plugins = rootPlugins(app.printPlugins());
      const at = plugins.indexOf('adminAuditRoutes');
      expect(at).toBeGreaterThan(0);
      expect(plugins.slice(at + 1, at + 1 + AREAS.length)).toEqual(AREAS.map((area) => `${area}AreaRoutes`));
      for (const area of AREAS) expect(plugins.filter((name) => name === `${area}AreaRoutes`), area).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('give a route registered inside an area the admin guards, a budget and its place in the document', async () => {
    vi.resetModules();
    for (const area of AREAS) {
      const probe: FastifyPluginAsync = async (app) => {
        app.get(`/v1/admin/probe/${area}`, { preHandler: app.requirePermission('dashboard.read'), config: { pgBudget: 0 } }, async () => ({ area }));
      };
      vi.doMock(`../src/routes/areas/${area}.js`, () => ({ [`${area}AreaRoutes`]: probe }));
    }
    const { testApp: build } = await import('./support.js');
    const app = await build();
    try {
      await app.ready();
      expect(app.routesWithoutBudget()).toEqual([]);
      const doc = (await app.inject({ method: 'GET', url: '/openapi.json' })).json<{ paths: Record<string, unknown> }>();
      for (const area of AREAS) {
        const url = `/v1/admin/probe/${area}`;
        expect(app.hasRoute({ method: 'GET', url }), area).toBe(true);
        expect(Object.keys(doc.paths), area).toContain(url);
        // No admin session: refused before the handler.
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode, area).toBe(401);
      }
    } finally {
      await app.close();
    }
  });
});
