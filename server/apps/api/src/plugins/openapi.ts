import swagger from '@fastify/swagger';
import { problemSchema } from '@app/shared';
import fp from 'fastify-plugin';
import { createJsonSchemaTransform, createJsonSchemaTransformObject } from 'fastify-type-provider-zod';
import { z } from 'zod';

/** The API contract's version; it follows the `/v1` prefix, not the package. */
export const API_CONTRACT_VERSION = '1.0.0';

/**
 * Named schemas, emitted once under components.schemas and referenced from
 * routes. A registry of our own keeps ids out of zod's global registry.
 */
export const schemaRegistry = z.registry<{ id: string; description?: string }>();
schemaRegistry.add(problemSchema, { id: 'Problem', description: 'RFC 9457 problem details' });

/** Standard error responses for a route's schema, documented as problem+json. */
export const problemResponses = {
  '4xx': { description: 'Client error', content: { 'application/problem+json': { schema: problemSchema } } },
  '5xx': { description: 'Server error', content: { 'application/problem+json': { schema: problemSchema } } },
} as const;

/**
 * Collects every route's zod schemas into an OpenAPI 3.1 document, served at
 * /openapi.json. It is the contract the admin panel and the Android app are
 * generated from.
 */
export const openapiPlugin = fp(
  async (app) => {
    await app.register(swagger, {
      openapi: {
        openapi: '3.1.0',
        info: { title: 'API', version: API_CONTRACT_VERSION },
        components: {
          securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
        },
      },
      transform: createJsonSchemaTransform({ schemaRegistry }),
      transformObject: createJsonSchemaTransformObject({ schemaRegistry }),
    });
  },
  { name: 'openapi', fastify: '5.x' },
);
