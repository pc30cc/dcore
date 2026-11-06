import { errorCodeStatus, problem, type ErrorCode, type Problem, type ProblemInit } from '@app/shared';

export interface HttpProblemInit extends ProblemInit {
  /** Response headers that belong to the error, e.g. WWW-Authenticate or Retry-After. */
  headers?: Readonly<Record<string, string>> | undefined;
  cause?: unknown;
}

/**
 * An error that becomes an `application/problem+json` response. Throw it from
 * a handler or hook; the error handler renders it. `statusCode` makes Fastify
 * and its plugins treat it like their own HTTP errors.
 */
export class HttpProblem extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly init: HttpProblemInit;

  constructor(code: ErrorCode, init: HttpProblemInit = {}) {
    super(init.detail ?? code, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'HttpProblem';
    this.code = code;
    this.statusCode = init.status ?? errorCodeStatus[code];
    this.init = init;
  }

  toProblem(requestId: string, instance?: string): Problem {
    return problem(this.code, { ...this.init, requestId, instance });
  }
}
