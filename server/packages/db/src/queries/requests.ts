import { z } from 'zod';
import { hasSqlState, isDatabaseError, SqlState } from '../errors.js';
import { execute, many, one, sql } from '../query.js';
import { defineQuery } from './define.js';

/**
 * Message requests: a first message to someone not matched yet. One
 * statement per action (the functions of migration 0018 for the send and
 * the accept); the boxes read the requests and the other side's visibility
 * in one statement; a daily sweep expires pending requests after 14 days
 * and deletes decided ones once their retention is over.
 */

const id = z.string().regex(/^[1-9][0-9]{0,18}$/);

export interface RequestSend {
  requestId: string;
  fromId: string;
  toId: string;
  body: string;
  resendAfterDays: number;
  /** Pay with the wallet's direct message (the free quota is spent). */
  pay: boolean;
  ledgerId: string;
  /** The session's store (wallet balances are kept per store). */
  store: number;
  crossStore: boolean;
}

export type RequestSendOutcome =
  | { outcome: 'sent'; paid: boolean; balance?: number | undefined; told: boolean; toCard: unknown }
  | { outcome: 'not_found' | 'already_matched' | 'already_requested' | 'no_balance' };

const sendSchema = z.union([
  z.object({ outcome: z.literal('sent'), paid: z.boolean(), balance: z.number().int().optional(), told: z.boolean(), toCard: z.unknown().optional() }),
  z.object({ outcome: z.enum(['not_found', 'already_matched', 'already_requested', 'no_balance']) }),
]);

/** `message_request_send()`: the request, its checks and the wallet use when it is paid for. */
export const sendMessageRequest = defineQuery({ name: 'requests.send', statements: 1 }, async (db, r: RequestSend): Promise<RequestSendOutcome> => {
  try {
    const row = await one<{ out: unknown }>(
      db,
      sql`SELECT message_request_send(${r.requestId}::bigint, ${r.fromId}::bigint, ${r.toId}::bigint, ${r.body}::text,
                                      ${r.resendAfterDays}::integer, ${r.pay}::boolean, ${r.ledgerId}::bigint,
                                      ${r.store}::smallint, ${r.crossStore}::boolean) AS out`,
    );
    const parsed = sendSchema.parse(row.out);
    return parsed.outcome === 'sent'
      ? { outcome: 'sent', paid: parsed.paid, balance: parsed.balance, told: parsed.told, toCard: parsed.toCard ?? null }
      : parsed;
  } catch (error) {
    // Two requests of the pair at the same moment: the second finds the first's pending row.
    if (isDatabaseError(error) && error.code === 'P0001' && error.message === 'already_requested') return { outcome: 'already_requested' };
    if (hasSqlState(error, SqlState.uniqueViolation)) return { outcome: 'already_requested' };
    throw error;
  }
});

export interface RequestAccepted {
  outcome: 'accepted';
  created: boolean;
  match: { id: string; lo: string; hi: string; state: number; flags: number; source: number };
  fromId: string;
  toId: string;
  body: string;
  messageId: string;
  loCard: unknown;
  hiCard: unknown;
}

const acceptSchema = z.union([
  z.object({
    outcome: z.literal('accepted'),
    created: z.boolean(),
    match: z.object({ id, lo: id, hi: id, state: z.number().int(), flags: z.number().int(), source: z.number().int() }),
    fromId: id,
    toId: id,
    body: z.string(),
    messageId: id,
    loCard: z.unknown().optional(),
    hiCard: z.unknown().optional(),
  }),
  z.object({ outcome: z.literal('not_found') }),
]);

/** `message_request_accept()`: the conversation, the request accepted, its body as the first message. */
export const acceptMessageRequest = defineQuery(
  { name: 'requests.accept', statements: 1 },
  async (db, requestId: string, userId: string, matchId: string, messageId: string): Promise<RequestAccepted | { outcome: 'not_found' }> => {
    const row = await one<{ out: unknown }>(
      db,
      sql`SELECT message_request_accept(${requestId}::bigint, ${userId}::bigint, ${matchId}::bigint, ${messageId}::bigint) AS out`,
    );
    const parsed = acceptSchema.parse(row.out);
    if (parsed.outcome === 'not_found') return parsed;
    return { ...parsed, loCard: parsed.loCard ?? null, hiCard: parsed.hiCard ?? null };
  },
);

/** The recipient declines a pending request (the sender is never told). True when it was pending. */
export const declineMessageRequest = defineQuery(
  { name: 'requests.decline', statements: 1 },
  async (db, requestId: string, userId: string): Promise<boolean> =>
    (await execute(
      db,
      sql`UPDATE message_requests SET status = 3, decided_at = now()
           WHERE id = ${requestId}::bigint AND to_id = ${userId}::bigint AND status = 1`,
    )) > 0,
);

/** The sender takes a pending request back. True when it was pending. */
export const withdrawMessageRequest = defineQuery(
  { name: 'requests.withdraw', statements: 1 },
  async (db, requestId: string, userId: string): Promise<boolean> =>
    (await execute(
      db,
      sql`UPDATE message_requests SET status = 5, decided_at = now()
           WHERE id = ${requestId}::bigint AND from_id = ${userId}::bigint AND status = 1`,
    )) > 0,
);

export interface RequestBoxRow {
  id: string;
  peerId: string;
  body: string;
  /** message_requests.status as it may be shown to this side. */
  status: number;
  peerCard: unknown;
}

/** A pending request reads as expired after this many days. */
export const REQUEST_EXPIRY_DAYS = 14;

/**
 * One page of a box, newest first, keyset on the request id, with the
 * other side's visibility (context 1: hidden, banned and blocked people
 * leave both boxes) and card, in one statement. The inbox holds the
 * pending requests to the person (its partial index); the sent box the
 * person's own requests, where a decline reads as pending, and as expired
 * once a pending request would have expired: a decline is never revealed.
 */
export const requestBox = defineQuery(
  { name: 'requests.box', statements: 1 },
  async (db, userId: string, box: 'inbox' | 'sent', limit: number, before: string | null): Promise<RequestBoxRow[]> => {
    const rows =
      box === 'inbox'
        ? await many<{ id: string; peer: string; body: string; status: number; card: unknown }>(
            db,
            sql`WITH page AS (
                  SELECT r.id, r.from_id AS peer, r.body, r.status
                    FROM message_requests r
                   WHERE r.to_id = ${userId}::bigint AND r.status = 1 AND (${before}::bigint IS NULL OR r.id < ${before}::bigint)
                   ORDER BY r.id DESC
                   LIMIT ${limit + 1}::integer
                ), seen AS (
                  SELECT v.id FROM visible_subset(${userId}::bigint, ARRAY(SELECT peer FROM page), 1) AS v(id)
                )
                SELECT p.id::text AS id, p.peer::text AS peer, p.body, p.status, profile_card(p.peer) AS card
                  FROM page p WHERE EXISTS (SELECT 1 FROM seen s WHERE s.id = p.peer)
                 ORDER BY p.id DESC`,
          )
        : await many<{ id: string; peer: string; body: string; status: number; card: unknown }>(
            db,
            sql`WITH page AS (
                  SELECT r.id, r.to_id AS peer, r.body,
                         CASE WHEN r.status = 3 OR (r.status = 1 AND id_time(r.id) < now() - make_interval(days => ${REQUEST_EXPIRY_DAYS}::integer))
                              THEN CASE WHEN id_time(r.id) < now() - make_interval(days => ${REQUEST_EXPIRY_DAYS}::integer) THEN 4 ELSE 1 END
                              ELSE r.status END AS status
                    FROM message_requests r
                   WHERE r.from_id = ${userId}::bigint AND (${before}::bigint IS NULL OR r.id < ${before}::bigint)
                   ORDER BY r.id DESC
                   LIMIT ${limit + 1}::integer
                ), seen AS (
                  SELECT v.id FROM visible_subset(${userId}::bigint, ARRAY(SELECT peer FROM page), 1) AS v(id)
                )
                SELECT p.id::text AS id, p.peer::text AS peer, p.body, p.status, profile_card(p.peer) AS card
                  FROM page p WHERE EXISTS (SELECT 1 FROM seen s WHERE s.id = p.peer)
                 ORDER BY p.id DESC`,
          );
    return rows.map((r) => ({ id: r.id, peerId: r.peer, body: r.body, status: Number(r.status), peerCard: r.card ?? null }));
  },
);

/** Pending requests older than the expiry become expired (status 4), a chunk at a time. Returns how many. */
export const expireMessageRequests = defineQuery({ name: 'requests.expire', statements: 1 }, async (db, chunk: number): Promise<number> =>
  execute(
    db,
    sql`UPDATE message_requests SET status = 4, decided_at = now()
         WHERE id IN (SELECT r.id FROM message_requests r
                       WHERE r.status = 1 AND r.id < id_floor(now() - make_interval(days => ${REQUEST_EXPIRY_DAYS}::integer))
                       ORDER BY r.id LIMIT ${chunk}::integer)`,
  ),
);

/**
 * Decided requests whose retention is over (`days`, or app_config
 * `retention.message_requests_days`), deleted with their bodies, a chunk at
 * a time (the partial index on decided_at). Returns how many. A decline's
 * retention runs from when the request would have expired had it been left
 * alone (14 days after it was sent), as an ignored request's does: the
 * sender's box, where a decline reads as pending then expired, never loses a
 * declined request sooner than an ignored one.
 */
export const deleteDecidedRequests = defineQuery(
  { name: 'requests.deleteDecided', statements: 1 },
  async (db, chunk: number, days: number | null = null): Promise<number> =>
    execute(
      db,
      sql`WITH cut AS (
            SELECT now() - make_interval(days => coalesce(${days}::integer,
                     (SELECT (c.value #>> '{}')::integer FROM public.app_config c WHERE c.key = 'retention.message_requests_days'), 30)) AS at
          )
          DELETE FROM message_requests
           WHERE id IN (SELECT r.id FROM message_requests r, cut
                         WHERE r.status <> 1
                           AND r.decided_at < cut.at
                           AND (r.status <> 3 OR id_time(r.id) + make_interval(days => ${REQUEST_EXPIRY_DAYS}::integer) < cut.at)
                         ORDER BY r.decided_at LIMIT ${chunk}::integer)`,
    ),
);
