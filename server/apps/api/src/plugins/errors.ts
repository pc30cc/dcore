import {
  PROBLEM_CONTENT_TYPE,
  problem,
  toJsonPointer,
  type ErrorCode,
  type FieldIssue,
  type IssueLocation,
  type Problem,
} from '@app/shared';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';
import { HttpProblem } from '../lib/problem.js';

const LOCATION: Readonly<Record<string, IssueLocation>> = {
  body: 'body',
  querystring: 'query',
  params: 'params',
  headers: 'headers',
};

const CODE_BY_STATUS: Readonly<Record<number, ErrorCode>> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'rate_limited',
  503: 'service_unavailable',
};

/** The path the problem is about, without the query string. */
function instanceOf(request: FastifyRequest): string {
  return request.url.split('?')[0] ?? request.url;
}

function sendProblem(reply: FastifyReply, body: Problem, headers?: Readonly<Record<string, string>>): FastifyReply {
  if (headers) reply.headers(headers);
  // Serialized here, not by a route's response schema: a problem has its own shape.
  return reply.code(body.status).type(PROBLEM_CONTENT_TYPE).serializer(JSON.stringify).send(body);
}

function validationIssues(error: unknown): FieldIssue[] | undefined {
  if (!hasZodFastifySchemaValidationErrors(error)) return undefined;
  const where = LOCATION[(error as { validationContext?: string }).validationContext ?? 'body'] ?? 'body';
  return error.validation.map((issue) => ({
    in: where,
    // The type provider writes the zod path as "/a/b"; re-encode it as a JSON Pointer.
    pointer: toJsonPointer(issue.instancePath.split('/').slice(1).filter((segment) => segment.length > 0)),
    code: issue.keyword,
    message: issue.message ?? 'invalid',
  }));
}

/**
 * Every error leaves as RFC 9457 problem+json with the request id. Details of
 * server errors go to the log, never to the client.
 */
export const errorsPlugin = fp(
  async (app) => {
    app.setErrorHandler((error: FastifyError | HttpProblem, request: FastifyRequest, reply: FastifyReply) => {
      if (error instanceof HttpProblem) {
        if (error.statusCode >= 500) request.log.error({ err: error }, 'request failed');
        return sendProblem(reply, error.toProblem(request.id, instanceOf(request)), error.init.headers);
      }

      const issues = validationIssues(error);
      if (issues) {
        return sendProblem(
          reply,
          problem('validation_failed', { requestId: request.id, instance: instanceOf(request), errors: issues }),
        );
      }

      if (isResponseSerializationError(error)) {
        request.log.error({ err: error }, 'response does not match its schema');
        return sendProblem(reply, problem('internal', { requestId: request.id }));
      }

      const status = typeof error.statusCode === 'number' ? error.statusCode : 500;
      if (status >= 400 && status < 500) {
        // Fastify's own client errors (bad JSON, wrong content type, body too
        // large) carry messages that are safe and useful to show.
        const code = CODE_BY_STATUS[status] ?? 'bad_request';
        request.log.info({ code: error.code, status }, error.message);
        return sendProblem(
          reply,
          problem(code, { status, detail: error.message, requestId: request.id, instance: instanceOf(request) }),
        );
      }

      request.log.error({ err: error }, 'request failed');
      const code = status === 503 ? 'service_unavailable' : 'internal';
      return sendProblem(reply, problem(code, { requestId: request.id }));
    });

    app.setNotFoundHandler((request, reply) =>
      sendProblem(
        reply,
        problem('not_found', {
          detail: `No route for ${request.method} ${instanceOf(request)}`,
          requestId: request.id,
          instance: instanceOf(request),
        }),
      ),
    );
  },
  { name: 'errors', fastify: '5.x' },
);
