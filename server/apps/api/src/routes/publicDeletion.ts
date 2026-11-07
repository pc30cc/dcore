import { deletionAccountOf } from '@app/db';
import {
  accountDeletionConfirmBody,
  accountDeletionErrorStep,
  accountDeletionGoogleBody,
  accountDeletionRedirect,
  accountDeletionRoutes,
  accountDeletionStartBody,
  deletionScheduledSchema,
  isLocale,
  otpPrefixCap,
  publicDeletionChallengeSchema,
  smsProvidersFor,
  wireTime,
  type AccountDeletionRoute,
  type AccountDeletionStep,
  type ErrorCode,
  type Locale,
  type SmsProviderName,
} from '@app/shared';
import {
  GoogleIdTokenError,
  OtpStore,
  hashDomains,
  randomToken,
  sha256,
  type KeyBuilder,
  type Limit,
} from '@app/shared/server';
import type { FastifyBaseLogger, FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { z } from 'zod';
import { ipSegment, normalizePhone, phoneHashes } from '../auth/otp.js';
import { HttpProblem } from '../lib/problem.js';
import { deleteAndFinish } from '../services/deletion.js';

/**
 * Deleting an account on the website, without signing in (the website
 * keeps no session): by a code sent to the account's number, or with the
 * Google account it signs in with.
 *
 * - `start` `{phone, locale}`: limits (3 an hour per IP, one a minute and 3
 *   a day per number, the SMS prefix cap; failing closed), one read for the
 *   account, then a challenge and a request (`delreq:<token>`, and
 *   `delreq:p:<phoneHash>` for the form, 10 minutes). The answer is the
 *   same whether or not an account has the number: the challenge is made
 *   either way, and the code is sent (after the answer, so its time says
 *   nothing either) only when an account does.
 * - `confirm` `{requestToken, code}` (JSON) or `{phone, code, locale}` (the
 *   form, which cannot carry the token without a script): the code, then the
 *   deletion (`deleted_via` 2). By phone, a number with no request answers
 *   like a wrong code, counted per number (5 → `otp_locked`).
 * - `google` `{idToken, locale?}`: an ID token the website's Google button
 *   got for our web client (its `azp` is the web client and it carries no
 *   nonce, so a token the app got to sign in, which names the Android client
 *   and our nonce, is refused), at most 10 minutes old (the page cannot ask
 *   for a nonce), used once, then the deletion of the account with that
 *   Google identity.
 *
 * A JSON request gets JSON (202, problems); a form post
 * (`application/x-www-form-urlencoded`) gets `303 See Other` to the
 * website's page: the next step, or back with `?e=<code>#e-<code>`. CORS
 * allows the website's origin on these routes only. Challenges live in a
 * namespace of their own (`otp:del:*`), so starting a deletion never ends
 * a sign-in in progress.
 */

type DeletionScheduled = z.infer<typeof deletionScheduledSchema>;
type PublicDeletionChallenge = z.infer<typeof publicDeletionChallengeSchema>;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const REQUEST_TTL_MS = 600_000;
/** Google ID tokens older than this are refused (no nonce on the website). */
const GOOGLE_MAX_AGE_SECONDS = 600;
/** How long a used token is remembered: past the age at which it is refused anyway (with the verifier's clock tolerance). */
const GOOGLE_USED_MS = (GOOGLE_MAX_AGE_SECONDS + 120) * 1_000;
const FORM_BODY_LIMIT = 16_384;
const FORM = 'application/x-www-form-urlencoded';

const START_LIMITS = { ipHourly: 3, phoneDaily: 3, resendSeconds: 60 } as const;
/** A request token is this many random bytes, base64url: exactly the shape below. */
const REQUEST_TOKEN_BYTES = 24;
const ISSUED_TOKEN = new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((REQUEST_TOKEN_BYTES * 4) / 3)}}$`);
const GOOGLE_IP_HOURLY = 10;

/** The deletion challenges' own keys: `otp:del:<phoneHash>` and `otp:delc:<challengeId>`. */
function deletionOtpKeys(keys: KeyBuilder): KeyBuilder {
  return { ...keys, otp: (phoneHash: string) => keys.raw('otp', 'del', phoneHash), otpChallenge: (challengeId: string) => keys.raw('otp', 'delc', challengeId) };
}

function isForm(request: FastifyRequest): boolean {
  const type = request.headers['content-type'];
  return typeof type === 'string' && type.toLowerCase().startsWith(FORM);
}

function bodyLocale(request: FastifyRequest): Locale {
  const body = request.body as { locale?: unknown } | null | undefined;
  return typeof body?.locale === 'string' && isLocale(body.locale) ? body.locale : request.locale;
}

function routeOf(request: FastifyRequest): AccountDeletionRoute | undefined {
  const url = request.routeOptions.url;
  return (Object.keys(accountDeletionRoutes) as AccountDeletionRoute[]).find((name) => accountDeletionRoutes[name] === url);
}

function rateLimited(retryAfterMs: number): HttpProblem {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1_000));
  return new HttpProblem('rate_limited', { retryAfterSeconds, headers: { 'retry-after': String(retryAfterSeconds) } });
}

function utcHour(now: number): string {
  return new Date(now).toISOString().slice(0, 13).replace(/[-T]/g, '');
}

/** A programming error, never a Valkey outage: it must not be answered (and logged) as one. */
function isBug(error: unknown): boolean {
  return error instanceof TypeError || error instanceof RangeError;
}

/** The body by its schema; a body that does not fit is the route's own refusal (as a wrong number, code or token). */
function parsed<S extends z.ZodType>(schema: S, request: FastifyRequest, refusal: ErrorCode): z.output<S> {
  const result = schema.safeParse(request.body ?? {});
  if (!result.success) throw new HttpProblem(refusal);
  return result.data;
}

export const publicDeletionRoutes: FastifyPluginAsyncZod = async (app) => {
  const site = app.config.siteOrigin ?? `https://${app.brand.domains.legal}`;
  const cors = {
    origin: [site],
    credentials: false,
    methods: ['POST'],
    allowedHeaders: ['content-type', 'accept-language', 'x-request-id'],
    exposedHeaders: ['x-request-id', 'retry-after'],
    maxAge: 600,
  };
  const otp = new OtpStore({ redis: app.redis, keys: deletionOtpKeys(app.keys), hasher: app.secrets.hasher, sealer: app.secrets.sealer });

  // Plain HTML forms (no script on the website), on these routes only.
  app.addContentTypeParser(FORM, { parseAs: 'string', bodyLimit: FORM_BODY_LIMIT }, (_request, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  /** A form post goes back to the website's page whatever went wrong; JSON keeps the problem. */
  const fallback = app.errorHandler;
  app.setErrorHandler(function (this: FastifyInstance, error: FastifyError | HttpProblem, request: FastifyRequest, reply: FastifyReply) {
    const route = routeOf(request);
    if (!route || !isForm(request)) return fallback.call(this, error, request, reply);
    const code = error instanceof HttpProblem ? error.code : 'error';
    if (!(error instanceof HttpProblem) || error.statusCode >= 500) request.log.error({ err: error }, 'account deletion form failed');
    return reply.header('cache-control', 'no-store').redirect(accountDeletionRedirect(site, bodyLocale(request), accountDeletionErrorStep[route], { error: code }), 303);
  });

  function answer<T>(request: FastifyRequest, reply: FastifyReply, body: T, step: AccountDeletionStep, requestToken?: string): FastifyReply {
    reply.header('cache-control', 'no-store');
    if (isForm(request)) return reply.redirect(accountDeletionRedirect(site, bodyLocale(request), step, { requestToken }), 303);
    return reply.code(202).send(body);
  }

  // Preflights of a script on the website (the forms need none).
  for (const path of Object.values(accountDeletionRoutes)) {
    app.options(path, { config: { cors, pgBudget: 0, rateLimit: false }, schema: { hide: true } }, async (_request, reply) => reply.code(204).send());
  }

  // ─── start ───────────────────────────────────────────────────────────────

  async function sendCode(log: FastifyBaseLogger, providers: readonly SmsProviderName[], e164: string, code: string, locale: Locale): Promise<void> {
    try {
      const sent = await app.sms.send(providers, { phone: e164, code, appName: '', locale, channel: 'sms' });
      log.info({ provider: sent.provider, failedOver: sent.failedOver }, 'deletion code sent');
    } catch (error) {
      // The answer is already the same as for a number without an account; the person may start again.
      log.warn({ err: error }, 'deletion code not sent');
    }
  }

  async function start(request: FastifyRequest): Promise<PublicDeletionChallenge> {
    const body = parsed(accountDeletionStartBody, request, 'phone_invalid');
    const e164 = normalizePhone(body.phone);
    if (e164 === null) throw new HttpProblem('phone_invalid');
    const settings = app.authSettings.get();
    // Which providers serve the number depends on the number alone, never on an account.
    const providers = smsProvidersFor(settings.routing, e164);
    if (providers.length === 0) throw new HttpProblem('phone_not_allowed');
    const phoneHash = otp.phoneKeyHash(e164);
    const now = Date.now();
    const prefix = otpPrefixCap(settings.caps, e164);
    const limits: Limit[] = [
      { name: 'ip_hourly', key: app.keys.raw('del', 'rl', 'ip', ipSegment(request)), cap: START_LIMITS.ipHourly, windowMs: HOUR_MS },
      { name: 'resend_wait', key: app.keys.raw('del', 'rl', 'w', phoneHash), cap: 1, windowMs: START_LIMITS.resendSeconds * 1_000 },
      { name: 'phone_daily', key: app.keys.raw('del', 'rl', 'p', phoneHash), cap: START_LIMITS.phoneDaily, windowMs: DAY_MS },
      // The sign-in's hourly cap per country prefix: this page sends codes as well.
      { name: 'prefix_hourly', key: app.keys.otpPrefixLimit(prefix.prefix, utcHour(now)), cap: prefix.cap, windowMs: HOUR_MS + 60_000 },
    ];
    let verdict;
    try {
      verdict = await app.limits.take(limits);
    } catch (error) {
      if (isBug(error)) throw error;
      request.log.error({ err: error }, 'deletion start: Valkey unavailable, refused');
      throw new HttpProblem('sms_unavailable', { detail: 'Codes cannot be sent right now.', headers: { 'retry-after': '30' }, cause: error });
    }
    if (!verdict.ok) {
      request.log.info({ limit: verdict.limit.name }, 'deletion start refused by a limit');
      throw rateLimited(verdict.retryAfterMs);
    }

    const account = await deletionAccountOf(app.pg, 1, phoneHashes(app, e164).map((h) => h.hash));
    const requestToken = randomToken(REQUEST_TOKEN_BYTES);
    let challenge;
    try {
      challenge = await otp.issue({ e164, purpose: 'deletion', length: settings.otp.length, ttlSeconds: settings.otp.ttl_seconds });
      await app.redis
        .multi()
        .hset(app.keys.deletionRequest(requestToken), 'c', challenge.challengeId, 'p', phoneHash)
        .pexpire(app.keys.deletionRequest(requestToken), REQUEST_TTL_MS)
        .set(app.keys.deletionRequestByPhone(phoneHash), requestToken, 'PX', REQUEST_TTL_MS)
        .exec();
    } catch (error) {
      if (isBug(error)) throw error;
      request.log.error({ err: error }, 'deletion start: the request could not be stored');
      throw new HttpProblem('sms_unavailable', { detail: 'Codes cannot be sent right now.', headers: { 'retry-after': '30' }, cause: error });
    }
    if (account !== null && challenge.code !== null) {
      // Not awaited: an answer that waited for the provider would take longer for numbers with an account.
      void sendCode(request.log, providers, e164, challenge.code, body.locale);
    } else {
      request.log.info('deletion start for a number without an account (nothing sent)');
    }
    return { requestToken, codeLength: settings.otp.length };
  }

  app.post(
    accountDeletionRoutes.start,
    {
      attachValidation: true,
      config: { cors, pgBudget: 1, rateLimit: false },
      schema: {
        tags: ['deletion'],
        summary: 'Start deleting an account without signing in (a code to its number)',
        body: accountDeletionStartBody,
        response: { 202: publicDeletionChallengeSchema },
      },
    },
    async (request, reply) => {
      const challenge = await start(request);
      return answer(request, reply, challenge, 'verify', challenge.requestToken);
    },
  );

  // ─── confirm ─────────────────────────────────────────────────────────────

  /** A number with no request: the same answers as wrong codes, five to a number in ten minutes. */
  async function noRequest(phoneHash: string, maxAttempts: number): Promise<never> {
    const key = app.keys.raw('del', 'rl', 'c', phoneHash);
    const replies = await app.redis.multi().set(key, 0, 'PX', REQUEST_TTL_MS, 'NX').incr(key).exec();
    const tries = Number(replies?.[1]?.[1] ?? Number.NaN);
    if (!Number.isFinite(tries)) throw new Error('the attempt could not be counted');
    if (tries >= maxAttempts) throw new HttpProblem('otp_locked');
    throw new HttpProblem('otp_invalid', { extensions: { attemptsLeft: maxAttempts - tries } });
  }

  async function lockNumber(phoneHash: string, maxAttempts: number): Promise<void> {
    await app.redis.set(app.keys.raw('del', 'rl', 'c', phoneHash), maxAttempts, 'PX', REQUEST_TTL_MS);
  }

  async function confirm(request: FastifyRequest): Promise<DeletionScheduled> {
    const body = parsed(accountDeletionConfirmBody, request, 'otp_invalid');
    const settings = app.authSettings.get();
    const maxAttempts = settings.otp.max_attempts;
    const ipLimit: Limit = { name: 'verify_ip_hourly', key: app.keys.raw('del', 'rl', 'v', ipSegment(request)), cap: settings.caps.verify_ip_hourly, windowMs: HOUR_MS };

    let check;
    let pending: Record<string, string>;
    let token: string | null;
    try {
      let byPhone: string | null = null;
      if ('requestToken' in body) {
        // Not a token this route issues: no request, as an expired one (after the IP's count below).
        token = ISSUED_TOKEN.test(body.requestToken) ? body.requestToken : null;
      } else {
        const e164 = normalizePhone(body.phone);
        byPhone = e164 === null ? null : otp.phoneKeyHash(e164);
        token = byPhone === null ? null : await app.redis.get(app.keys.deletionRequestByPhone(byPhone));
      }
      pending = token === null ? {} : await app.redis.hgetall(app.keys.deletionRequest(token));
      if (!pending['c'] || !pending['p'] || (byPhone !== null && pending['p'] !== byPhone)) {
        const verdict = await app.limits.take([ipLimit]);
        if (!verdict.ok) throw rateLimited(verdict.retryAfterMs);
        if ('requestToken' in body) throw new HttpProblem('otp_expired');
        // An invalid number cannot have a request: a wrong code all the same.
        if (byPhone === null) throw new HttpProblem('otp_invalid', { extensions: { attemptsLeft: maxAttempts - 1 } });
        return await noRequest(byPhone, maxAttempts);
      }
      check = await otp.verify({
        challengeId: pending['c'],
        phoneHash: pending['p'],
        purpose: 'deletion',
        code: body.code,
        maxAttempts,
        ipKey: ipLimit.key,
        ipCap: ipLimit.cap,
        ipWindowMs: ipLimit.windowMs,
      });
    } catch (error) {
      if (error instanceof HttpProblem || isBug(error)) throw error;
      request.log.error({ err: error }, 'deletion confirm: Valkey unavailable, refused');
      throw new HttpProblem('service_unavailable', { detail: 'Codes cannot be checked right now.', headers: { 'retry-after': '30' }, cause: error });
    }

    const phoneHash = pending['p'];
    const forget = async () => {
      if (token === null) return;
      await app.redis
        .multi()
        .del(app.keys.deletionRequest(token))
        .eval(
          "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
          1,
          app.keys.deletionRequestByPhone(phoneHash),
          token,
        )
        .exec()
        .catch((error: unknown) => request.log.warn({ err: error }, 'deletion request not cleared'));
    };
    switch (check.outcome) {
      case 'ok': {
        await forget();
        const result = await deleteAndFinish(app, request, { provider: 1, subjectHashes: phoneHashes(app, check.phone).map((h) => h.hash) }, 2);
        // No account has the number (the code was never sent): as a wrong code.
        if (result === null) throw new HttpProblem('otp_invalid', { extensions: { attemptsLeft: maxAttempts - 1 } });
        return { purgeAt: wireTime(result.purgeAtMs) };
      }
      case 'wrong':
        throw new HttpProblem('otp_invalid', { extensions: { attemptsLeft: check.attemptsLeft } });
      case 'locked':
        await forget();
        await lockNumber(phoneHash, maxAttempts).catch(() => undefined);
        throw new HttpProblem('otp_locked');
      case 'ip_limited':
        throw rateLimited(check.retryAfterMs);
      default:
        throw new HttpProblem('otp_expired');
    }
  }

  app.post(
    accountDeletionRoutes.confirm,
    {
      attachValidation: true,
      // The deletion: one statement, a second (a read) when it was deleted before.
      config: { cors, pgBudget: 2, rateLimit: false },
      schema: {
        tags: ['deletion'],
        summary: 'Confirm the deletion with the code',
        body: accountDeletionConfirmBody,
        response: { 202: deletionScheduledSchema },
      },
    },
    async (request, reply) => answer(request, reply, await confirm(request), 'done'),
  );

  // ─── google ──────────────────────────────────────────────────────────────

  async function google(request: FastifyRequest): Promise<DeletionScheduled> {
    const body = parsed(accountDeletionGoogleBody, request, 'google_token_invalid');
    const audience = app.config.google.webClientId;
    if (!audience || !app.google) throw new HttpProblem('service_unavailable', { detail: 'Google sign-in is not configured.' });
    let verdict;
    try {
      verdict = await app.limits.take([{ name: 'google_ip_hourly', key: app.keys.raw('del', 'rl', 'g', ipSegment(request)), cap: GOOGLE_IP_HOURLY, windowMs: HOUR_MS }]);
    } catch (error) {
      throw new HttpProblem('service_unavailable', { detail: 'Try again in a moment.', headers: { 'retry-after': '30' }, cause: error });
    }
    if (!verdict.ok) throw rateLimited(verdict.retryAfterMs);
    let identity;
    try {
      identity = await app.google.verify(body.idToken, { audience, maxAgeSeconds: GOOGLE_MAX_AGE_SECONDS });
    } catch (error) {
      if (error instanceof GoogleIdTokenError) {
        request.log.info({ reason: error.reason }, 'deletion: google token refused');
        if (error.reason === 'unavailable') throw new HttpProblem('service_unavailable', { detail: 'Google could not be reached.', cause: error });
        throw new HttpProblem('google_token_invalid');
      }
      throw error;
    }
    // Only a token of the website's button: one the app got to sign in names the Android client and our nonce.
    if (identity.authorizedParty !== audience || identity.nonce !== undefined) {
      request.log.info({ reason: identity.nonce !== undefined ? 'nonce' : 'authorized_party' }, 'deletion: google token refused');
      throw new HttpProblem('google_token_invalid');
    }
    // Once: a token that was seen (copied from a log, replayed) deletes nothing again.
    const used = app.keys.raw('del', 'g', sha256(body.idToken).toString('hex'));
    let first;
    try {
      first = (await app.redis.set(used, '1', 'PX', GOOGLE_USED_MS, 'NX')) === 'OK';
    } catch (error) {
      throw new HttpProblem('service_unavailable', { detail: 'Try again in a moment.', headers: { 'retry-after': '30' }, cause: error });
    }
    if (!first) {
      request.log.info({ reason: 'used' }, 'deletion: google token refused');
      throw new HttpProblem('google_token_invalid');
    }
    const hashes = app.secrets.hasher.hashAll(hashDomains.google, identity.sub).map((h) => h.hash);
    let result;
    try {
      result = await deleteAndFinish(app, request, { provider: 2, subjectHashes: hashes }, 2);
    } catch (error) {
      // Nothing was deleted: the person may send the same token again.
      await app.redis.del(used).catch(() => undefined);
      throw error;
    }
    if (result === null) throw new HttpProblem('not_found', { detail: 'No account signs in with this Google account.' });
    return { purgeAt: wireTime(result.purgeAtMs) };
  }

  app.post(
    accountDeletionRoutes.google,
    {
      attachValidation: true,
      config: { cors, pgBudget: 2, rateLimit: false },
      schema: {
        tags: ['deletion'],
        summary: 'Delete the account that signs in with this Google account',
        body: accountDeletionGoogleBody,
        response: { 202: deletionScheduledSchema },
      },
    },
    async (request, reply) => answer(request, reply, await google(request), 'done'),
  );
};
