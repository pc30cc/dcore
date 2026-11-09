import { blockUser, blockedPeople, fileReport, isTransientDatabaseError, unblockPair, type BlockOutcome, type BlockedPerson, type PairMatch } from '@app/db';
import { decodeCursor, encodeCursor, realtimeEnvelope, reportContext, reportReason, userChannel, wireTime, type BlockList, type PeerSummary, type ReportRequest } from '@app/shared';
import {
  ACCOUNT_QUEUE,
  BLOCK_DECK_DELAY_MS,
  SAFETY_QUEUE,
  applyBlockKv,
  jobId,
  photoVariantUrl,
  safetyJobAttempts,
  safetyJobIds,
  safetyJobNames,
} from '@app/shared/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { nextId } from '../auth/sessions.js';
import { scrubbed, withoutRowData } from '../lib/dbErrors.js';
import { queueChatEvidence, deferReport } from './evidence.js';
import { HttpProblem } from '../lib/problem.js';
import { endCallsOf } from './calls.js';

/**
 * Blocks and reports from the app (`/v1/blocks`, `/v1/reports`).
 *
 * A block is one statement (`block_apply()`: the pair's row and the end of
 * their conversation). Then the Valkey side, so both people's next
 * requests already reflect it: the pair leaves each other's like buckets
 * and deck queues, and the conversation leaves both lists. The blocked
 * person hears exactly what an unmatch sends (`conversation_end` to both
 * people, the same messages purge later): a block is never revealed. When
 * Valkey cannot take its side the request answers 503 and a retry finishes
 * it (the statement is idempotent and names the pair's match again).
 *
 * A report is one statement too (`report_file()`), the optional block in
 * it; the block's Valkey side then follows as above.
 */

const ENDED_BY_BLOCK = 3;
const DAY_MS = 86_400_000;

/** `t` the block's time (µs), `i` the person's public id: raw ids never leave the server, a cursor included. */
const cursorSchema = z.object({ t: z.string().regex(/^-?[0-9]{1,20}$/), i: z.string().min(1).max(64) });

function budget(request: FastifyRequest, statements: number): void {
  if (request.pgTally?.budget !== undefined) request.pgTally.budget += statements;
}

export class SafetyService {
  constructor(
    private readonly app: FastifyInstance,
    private readonly request: FastifyRequest,
  ) {}

  private get log() {
    return this.request.log;
  }

  /** `POST /v1/blocks`: false when the target names nobody (or the caller). */
  async block(actorId: string, targetId: string): Promise<boolean> {
    // The conversation_end event id, minted before the write (503 without an id lease, before anything changed).
    const eventId = nextId(this.app);
    const outcome = await scrubbed(() => blockUser(this.app.pg, actorId, targetId));
    if (!outcome.found) return false;
    await this.afterBlock(actorId, targetId, outcome, eventId);
    return true;
  }

  /**
   * The Valkey, realtime and job side of a block (from `/v1/blocks` or a
   * report with `block`). The lists, likes and decks first; the event even
   * when they failed (the database already ended the conversation); then a
   * failure answers 503 so the client sends the request again.
   */
  async afterBlock(actorId: string, targetId: string, outcome: Extract<BlockOutcome, { found: true }>, eventId: string): Promise<void> {
    const { app } = this;
    const ended: PairMatch | null = outcome.match?.state === ENDED_BY_BLOCK ? outcome.match : null;
    let failure: unknown = null;
    let refilling = false;
    try {
      refilling = (await applyBlockKv(app, actorId, targetId, ended)).refilling;
    } catch (error) {
      failure = error;
    }
    // A call the two are in ends with the conversation (also on a retry: nothing to end then).
    if (ended) await endCallsOf(app, this.log, [ended]);
    if (ended && outcome.endedNow) {
      if (app.realtime) {
        const channels = [ended.lo, ended.hi].map((uid) => userChannel(app.publicIds.user.encode(uid)));
        await app.realtime
          .broadcast(channels, realtimeEnvelope('conversation_end', eventId, Date.now(), { conversationId: ended.matchId }))
          .catch((error: unknown) => this.log.warn({ err: error }, 'block: event not published'));
      }
      // The messages go as after an unmatch (a report filed now still finds them; a legal hold keeps them).
      const days = app.cfg.get().app['retention.unmatched_messages_days'];
      await app.jobs
        .add(ACCOUNT_QUEUE, 'unmatch-purge', jobId('unmatch-purge', ended.matchId), { matchId: ended.matchId }, { delayMs: days * DAY_MS, attempts: 5, backoffMs: 60_000 })
        .catch((error: unknown) => this.log.error({ err: error, matchId: ended.matchId }, 'block: purge not queued'));
    }
    if (refilling) {
      await app.jobs
        .add(SAFETY_QUEUE, safetyJobNames.blockDeck, safetyJobIds.blockDeck(actorId, targetId), { a: actorId, b: targetId }, {
          delayMs: BLOCK_DECK_DELAY_MS,
          attempts: safetyJobAttempts.blockDeck.attempts,
          backoffMs: safetyJobAttempts.blockDeck.backoffMs,
        })
        .catch((error: unknown) => {
          failure ??= error;
        });
    }
    if (failure !== null) {
      this.log.error({ err: failure }, 'block: Valkey side failed; the client retries');
      throw new HttpProblem('service_unavailable', { detail: 'Send the request again in a moment.', headers: { 'retry-after': '2' }, cause: failure });
    }
  }

  /**
   * `DELETE /v1/blocks/:target`: idempotent; a target that names nobody
   * removes nothing. Once no side blocks the other, the pair's block marker
   * goes, so their likes count again (a 503 when Valkey cannot take it: the
   * retry finds the pair cleared and deletes the marker).
   */
  async unblock(actorId: string, targetId: string | null): Promise<void> {
    if (targetId === null) return;
    budget(this.request, 1);
    const outcome = await scrubbed(() => unblockPair(this.app.pg, actorId, targetId));
    // The other side still blocks: the marker stays.
    if (!outcome.cleared) return;
    try {
      await this.app.redis.del(this.app.keys.likesBlocked(actorId, targetId));
    } catch (error) {
      this.log.error({ err: error }, 'unblock: the pair marker was not cleared; the client retries');
      throw new HttpProblem('service_unavailable', { detail: 'Send the request again in a moment.', headers: { 'retry-after': '2' }, cause: error });
    }
  }

  /** `GET /v1/blocks`: the people this account blocked, newest first. */
  async list(viewerId: string, limit: number, cursor: string | undefined): Promise<BlockList> {
    let after: { atUs: string; userId: string } | undefined;
    if (cursor !== undefined) {
      const decoded = decodeCursor(cursorSchema, cursor);
      const userId = decoded ? this.app.publicIds.user.decodeId(decoded.i) : null;
      if (!decoded || userId === null) throw new HttpProblem('bad_request', { detail: 'The cursor is not valid.' });
      after = { atUs: decoded.t, userId };
    }
    const rows = await scrubbed(() => blockedPeople(this.app.pg, viewerId, limit, after));
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((p) => ({ user: this.peerOf(p), blockedAt: wireTime(Math.floor(Number(p.atUs) / 1_000)) })),
      nextCursor: rows.length > limit && last ? encodeCursor({ t: last.atUs, i: this.app.publicIds.user.encode(last.userId) }) : null,
    };
  }

  private peerOf(p: BlockedPerson): PeerSummary {
    const media = this.app.media;
    let photo: PeerSummary['photo'] = null;
    if (p.photo && media && p.photo.w > 0 && p.photo.h > 0) {
      const url = photoVariantUrl(media, p.photo.id, p.photo.blobVer, 320);
      if (url) photo = { id: p.photo.id, w: p.photo.w, h: p.photo.h, blurhash: p.photo.blurhash, url };
    }
    return { id: this.app.publicIds.user.encode(p.userId), name: p.name, photo, verified: p.verified };
  }

  /** `POST /v1/reports`: the report id, or null when the target (or a conversation, photo or call it names) is not theirs to report. */
  async report(reporterId: string, targetId: string, body: ReportRequest): Promise<string | null> {
    const { app } = this;
    const reportId = nextId(app);
    const eventId = body.block ? nextId(app) : null;
    let outcome;
    try {
      outcome = await fileReport(app.pg, {
        reportId,
        reporterId,
        targetId,
        context: reportContext.code(body.context),
        reason: reportReason.code(body.reason),
        details: body.details,
        conversationId: body.conversationId,
        messageIds: body.messageIds,
        photoId: body.photoId,
        callId: body.callId,
        block: body.block,
      });
    } catch (error) {
      // PostgreSQL cannot take it now: the report is accepted and filed by the worker once it can (its evidence then follows).
      if (isTransientDatabaseError(error)) {
        await deferReport(app, this.log, { filingId: reportId, reporterId, targetId, body, blockEventId: eventId });
        return reportId;
      }
      throw withoutRowData(error);
    }
    if (outcome.outcome === 'not_found') return null;
    this.log.info({ merged: outcome.merged, holds: outcome.holds, context: body.context }, 'report filed');
    if (outcome.block && outcome.block.found && eventId !== null) await this.afterBlock(reporterId, targetId, outcome.block, eventId);
    // A chat report's messages are copied by a job once the write-behind stream is durable past it.
    if (body.context === 'chat') {
      await queueChatEvidence(app, this.log, {
        reportId: outcome.reportId,
        filingId: reportId,
        reporterId,
        targetId,
        conversationId: body.conversationId ?? null,
        messageIds: body.messageIds ?? [],
      });
    }
    return outcome.reportId;
  }
}
