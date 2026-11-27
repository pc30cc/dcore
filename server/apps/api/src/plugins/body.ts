import type { FastifyRequest, RouteOptions } from 'fastify';
import fp from 'fastify-plugin';
import { z } from 'zod';

/**
 * Request bodies.
 *
 * - Fastify validates a request without a body (no bytes, no Content-Type)
 *   as `null`, so a body that may be left out is declared `.nullish()`:
 *   `.optional()` takes `undefined` only, which never reaches the
 *   validator, and refuses that request with a 400. Every route whose body
 *   schema takes `undefined` but not `null`, or throws on either, is listed
 *   by `routesWithUndefinedOnlyBody()`, which the route registry test keeps
 *   empty.
 * - An `application/json` body of zero bytes is no body either, the same
 *   request with the header set: Fastify's own parser refuses it, this one
 *   hands the route an absent body (a required body is then refused by its
 *   schema, 400). Any other JSON goes through Fastify's parser unchanged
 *   (prototype poisoning refused, malformed JSON a 400).
 */

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Routes whose body schema takes an absent body only as `undefined`, or
     * throws on an absent body (method and path; the latter marked).
     */
    routesWithUndefinedOnlyBody(): string[];
  }
}

/** Whether `schema` takes `value`; 'throws' when parsing throws instead of reporting issues (a preprocess that reads a property, an async refinement). */
function takes(schema: z.ZodType, value: unknown): boolean | 'throws' {
  try {
    return schema.safeParse(value).success;
  } catch {
    return 'throws';
  }
}

type JsonParser = (request: FastifyRequest, body: string, done: (error: Error | null, body?: unknown) => void) => void;

export const bodyPlugin = fp(
  async (app) => {
    // The callback form of the parser Fastify builds by default ('error' is its default for both).
    const json = app.getDefaultJsonParser('error', 'error') as JsonParser;
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
      if (body.length === 0) done(null, undefined);
      else json(request, body as string, done);
    });

    const undefinedOnly: string[] = [];
    app.addHook('onRoute', (route: RouteOptions) => {
      const schema = route.schema?.body;
      if (!(schema instanceof z.ZodType)) return;
      const absent = takes(schema, undefined);
      const none = takes(schema, null);
      // Listed, never thrown from here: a throw in an onRoute hook aborts the API's start.
      if (absent === 'throws' || none === 'throws') undefinedOnly.push(`${String(route.method)} ${route.url} (schema throws on an absent body)`);
      else if (absent && !none) undefinedOnly.push(`${String(route.method)} ${route.url}`);
    });
    app.decorate('routesWithUndefinedOnlyBody', () => [...undefinedOnly]);
  },
  { name: 'body', fastify: '5.x' },
);
