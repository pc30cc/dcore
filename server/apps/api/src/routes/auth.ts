import { SqlState, accountRestriction, attachPhone, hasSqlState, phoneProbe, withTransaction } from '@app/db';
import {
  PROBLEM_CONTENT_TYPE,
  authResultSchema,
  challengeIdSchema,
  deviceInfoSchema,
  deviceKeySchema,
  googleNonceSchema,
  googleSignInRequestSchema,
  installIdSchema,
  logoutRequestSchema,
  otpChallengeSchema,
  otpChannelSchema,
  otpCodeSchema,
  otpStartRequestSchema,
  problemSchema,
  tokenPairSchema,
  type Problem,
} from '@app/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { googleNonce, googleSignIn } from '../auth/google.js';
import { phoneHashes, startOtp, verifyOtp } from '../auth/otp.js';
import { accountStateProblem, logout, nextId, refresh, signIn } from '../auth/sessions.js';
import { HttpProblem } from '../lib/problem.js';

/**
 * `/v1/auth/*` (sign-in, refresh, sign-out) and `/v1/me/phone/*` (adding
 * or changing a signed-in account's number). Budgets (PostgreSQL
 * statements per request): starting a code and the Google nonce 0; a
 * refresh 1; a sign-in 1 read plus a transaction of 3 (existing account) or
 * 4 (new account), declared with the rare path where two first sign-ins of
 * one account race (the loser's account is rolled back after at most 4 and
 * it signs in to the winner's: at most 9).
 */

/** The number is checked by the route (`phone_invalid`), not by the schema (`validation_failed`). */
const phoneInput = z.string().min(1).max(40);
const startBody = otpStartRequestSchema.extend({ phone: phoneInput });
const verifyBody = z.object({
  challengeId: challengeIdSchema,
  code: otpCodeSchema,
  installId: installIdSchema,
  deviceKey: deviceKeySchema,
  device: deviceInfoSchema,
});
const refreshBody = z.object({ refreshToken: z.string().min(1).max(256) });
const phoneStartBody = z.object({ phone: phoneInput, channel: otpChannelSchema.optional(), locale: otpStartRequestSchema.shape.locale, smsAppHash: otpStartRequestSchema.shape.smsAppHash });
const phoneVerifyBody = z.object({ challengeId: challengeIdSchema, code: otpCodeSchema });

const SIGN_IN_BUDGET = 9;

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  /**
   * preHandler: a signed-in app session with full scope. A restricted or
   * restore session gets its account's own answer (one read, on that
   * refusal only), or 401 when the restriction was lifted since (a refresh
   * brings a full session).
   */
  const requireFullSession = async (request: FastifyRequest): Promise<void> => {
    const principal = request.principal;
    if (principal?.kind !== 'app' || principal.scope === 'full') return;
    const userId = app.publicIds.user.decodeId(principal.subject);
    if (request.pgTally?.budget !== undefined) request.pgTally.budget += 1;
    const state = userId === null ? null : await accountRestriction(app.pg, userId);
    throw (state && accountStateProblem(state)) ?? new HttpProblem('unauthorized', { headers: { 'www-authenticate': 'Bearer error="invalid_token"' } });
  };

  app.post(
    '/v1/auth/otp/start',
    {
      config: { pgBudget: 0 },
      schema: { tags: ['auth'], summary: 'Send a sign-in code', body: startBody, response: { 200: otpChallengeSchema } },
    },
    async (request) => startOtp(app, request, { ...request.body, purpose: 'signin' }),
  );

  app.post(
    '/v1/auth/otp/verify',
    {
      config: { pgBudget: SIGN_IN_BUDGET },
      schema: { tags: ['auth'], summary: 'Sign in with a code', body: verifyBody, response: { 200: authResultSchema } },
    },
    async (request) => {
      const { challengeId, code, ...device } = request.body;
      const { e164, review } = await verifyOtp(app, request, { challengeId, code, purpose: 'signin' });
      const sealed = app.secrets.sealer.seal(e164, 'auth_identities.subject_enc');
      return signIn(app, request, { provider: 1, hashes: phoneHashes(app, e164), sealed, testAccount: review }, device);
    },
  );

  app.post(
    '/v1/auth/google/nonce',
    {
      config: { pgBudget: 0 },
      schema: { tags: ['auth'], summary: 'A nonce for a Google sign-in (play build)', response: { 200: googleNonceSchema } },
    },
    async (request) => googleNonce(app, request),
  );

  app.post(
    '/v1/auth/google',
    {
      config: { pgBudget: SIGN_IN_BUDGET },
      schema: { tags: ['auth'], summary: 'Sign in with Google (play build)', body: googleSignInRequestSchema, response: { 200: authResultSchema } },
    },
    async (request) => googleSignIn(app, request, request.body),
  );

  app.post(
    '/v1/auth/refresh',
    {
      config: { pgBudget: 1 },
      schema: {
        tags: ['auth'],
        summary: 'Rotate the refresh token',
        body: refreshBody,
        response: { 200: tokenPairSchema, 403: problemSchema },
      },
    },
    async (request, reply) => {
      const answer = await refresh(app, request, request.body.refreshToken);
      reply.header('cache-control', 'no-store');
      if (answer.status === 200) return reply.code(200).send(answer.body as z.infer<typeof tokenPairSchema>);
      // A restricted or restore pair travels inside the account-state problem.
      return reply.code(403).type(PROBLEM_CONTENT_TYPE).serializer(JSON.stringify).send(answer.body as Problem);
    },
  );

  app.post(
    '/v1/auth/logout',
    {
      config: { pgBudget: 1 },
      preHandler: app.requireUser,
      schema: { tags: ['auth'], summary: 'Sign out here, or everywhere', body: logoutRequestSchema.optional() },
    },
    async (request, reply) => {
      await logout(app, request, request.body?.all === true);
      return reply.code(204).send();
    },
  );

  app.post(
    '/v1/me/phone/start',
    {
      config: { pgBudget: 0 },
      preHandler: [app.requireUser, requireFullSession],
      schema: { tags: ['auth'], summary: 'Send a code to a number to add to this account', body: phoneStartBody, response: { 200: otpChallengeSchema } },
    },
    async (request) => {
      const userId = userIdOf(app, request.principal?.subject);
      return startOtp(app, request, { ...request.body, purpose: `phone:${userId}` });
    },
  );

  app.post(
    '/v1/me/phone/verify',
    {
      // The number's holder and bans (1), then the identity (1, or 2 when a purged account held the number).
      config: { pgBudget: 3 },
      preHandler: [app.requireUser, requireFullSession],
      schema: { tags: ['auth'], summary: 'Add or change the number with its code', body: phoneVerifyBody },
    },
    async (request, reply) => {
      const userId = userIdOf(app, request.principal?.subject);
      const { e164 } = await verifyOtp(app, request, { ...request.body, purpose: `phone:${userId}` });
      const hashes = phoneHashes(app, e164);
      const probe = await phoneProbe(app.pg, hashes.map((h) => h.hash));
      if (probe.banned) throw new HttpProblem('phone_banned');
      const holder = probe.holder;
      if (holder && !holder.purged && holder.userId !== userId) {
        throw new HttpProblem('conflict', { detail: 'This number belongs to another account.' });
      }
      if (!holder || holder.purged) {
        const subject = hashes[0];
        if (!subject) throw new HttpProblem('internal');
        try {
          await withTransaction(app.pg, (tx) =>
            attachPhone(tx, {
              userId,
              newIdentityId: nextId(app),
              subject,
              sealed: app.secrets.sealer.seal(e164, 'auth_identities.subject_enc'),
              purgedIdentityId: holder?.purged ? holder.identityId : null,
            }),
          );
        } catch (error) {
          if (hasSqlState(error, SqlState.uniqueViolation)) throw new HttpProblem('conflict', { detail: 'This number belongs to another account.' });
          throw error;
        }
      }
      return reply.code(204).send();
    },
  );
};

function userIdOf(app: { publicIds: { user: { decodeId(id: string): string | null } } }, subject: string | undefined): string {
  const userId = subject === undefined ? null : app.publicIds.user.decodeId(subject);
  if (userId === null) throw new HttpProblem('unauthorized');
  return userId;
}

export { signIn };
