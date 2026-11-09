import { createHash } from 'node:crypto';
import {
  WebhookSignatureError,
  announceCall,
  callIdOfRoom,
  callIdentities,
  callKeys,
  completeCall,
  conversationEnded,
  endForEndedConversation,
  isLiveState,
  isReplacedConnection,
  isTerminalState,
  markJoined,
  markLeft,
  readCall,
  roomName,
  sideOfIdentity,
  type CallEffectsContext,
  type LiveKitEvent,
} from '@app/shared/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { nextId } from '../auth/sessions.js';
import { HttpProblem } from '../lib/problem.js';

/**
 * `POST /v1/webhooks/livekit`: LiveKit's word on the rooms of calls. The raw
 * body is verified against the JWT in `Authorization` (signed with the API
 * secret, its `sha256` claim the body's hash) before anything is read.
 *
 * - `participant_joined`: the identity joins the room's presence set; an
 *   answered call is active once both people's identities are in it.
 * - `participant_left`: the call ends for both (completed, or failed when
 *   the two were never in together), unless the reason is
 *   DUPLICATE_IDENTITY: the same person reconnected, their new connection is
 *   in the room.
 * - `room_finished`: an answered call ends (the room is gone).
 * - `room_started`, or a participant joining, for a call that is over (or
 *   unknown): the room is deleted at once, which puts out whoever is in it.
 * - `participant_connection_aborted`, `track_*` and everything else, and
 *   rooms that are not a call's, are answered 200 without any I/O.
 *
 * Each event is applied once (`lkwh:<id>`: `processing` while it is applied,
 * `done` for a day after), so a duplicate delivery changes nothing. A real
 * failure (Valkey) answers 500 and clears the mark, so LiveKit retries;
 * LiveKit delivers later events only after earlier ones, so nothing else
 * answers 500. No statement.
 */

const webhookAnswerSchema = z.object({ ok: z.boolean(), duplicate: z.boolean().optional() });

const HANDLED = new Set(['room_started', 'room_finished', 'participant_joined', 'participant_left']);
const EVENT_ID = /^[A-Za-z0-9_-]{1,100}$/;

export const livekitWebhookRoutes: FastifyPluginAsyncZod = async (app) => {
  // The exact bytes LiveKit signed: no JSON parsing before the check.
  const raw = (_request: FastifyRequest, body: Buffer, done: (error: Error | null, body?: Buffer) => void) => done(null, body);
  app.addContentTypeParser('application/webhook+json', { parseAs: 'buffer', bodyLimit: 1_048_576 }, raw);
  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 1_048_576 }, raw);

  app.post(
    '/v1/webhooks/livekit',
    {
      config: { pgBudget: 0, rateLimit: false },
      schema: { tags: ['webhooks'], summary: 'LiveKit room events', response: { 200: webhookAnswerSchema } },
    },
    async (request, reply) => {
      const livekit = app.calls.livekit;
      if (!livekit || !app.calls.identitySecret) throw new HttpProblem('service_unavailable', { detail: 'Calls are not configured.' });
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      let event: LiveKitEvent;
      try {
        event = await livekit.verifyWebhook(body, request.headers.authorization);
      } catch (error) {
        if (error instanceof WebhookSignatureError) {
          request.log.warn({ reason: error.message }, 'livekit webhook refused');
          throw new HttpProblem('unauthorized', { detail: 'The webhook signature does not verify.' });
        }
        throw error;
      }
      if (!HANDLED.has(event.event)) return reply.code(200).send({ ok: true });
      const callId = callIdOfRoom(event.room?.name);
      if (!callId) return reply.code(200).send({ ok: true });

      const keys = callKeys(app.keys);
      const eventId = event.id && EVENT_ID.test(event.id) ? event.id : createHash('sha256').update(body).digest('hex');
      const mark = keys.webhookEvent(eventId);
      const first = await app.redis.set(mark, 'processing', 'EX', 300, 'NX');
      if (first !== 'OK') return reply.code(200).send({ ok: true, duplicate: true });
      try {
        await apply(app, request, event, callId);
        await app.redis.set(mark, 'done', 'EX', 86_400);
      } catch (error) {
        await app.redis.del(mark).catch(() => undefined);
        request.log.error({ err: error, event: event.event }, 'livekit webhook not applied; LiveKit will retry');
        throw new HttpProblem('internal', { detail: 'Not applied; retry.' });
      }
      return reply.code(200).send({ ok: true });
    },
  );
};

async function apply(app: FastifyInstance, request: FastifyRequest, event: LiveKitEvent, callId: string): Promise<void> {
  const secret = app.calls.identitySecret!;
  const livekit = app.calls.livekit!;
  const now = app.calls.now();
  const lifecycle = { redis: app.redis, keys: app.keys, mintId: () => nextId(app) };
  const effects: CallEffectsContext = { realtime: app.realtime, publicIds: app.publicIds, nextId: () => nextId(app), jobs: app.calls.jobs, log: request.log };
  const call = await readCall(app.redis, app.keys, callId);

  // A room of a call that is over, or of no call at all, goes at once: with
  // auto_create off nobody can bring it back, and whoever is in it is put out.
  if (!call || isTerminalState(call.state)) {
    if (event.event === 'room_started' || event.event === 'participant_joined') await livekit.deleteRoom(roomName(callId));
    return;
  }

  // The conversation ended while the call lived (an unmatch, a block): the call ends and its room goes.
  if (await conversationEnded(app.redis, app.keys, call.matchId)) {
    const ended = await endForEndedConversation(lifecycle, call, now);
    if (ended) await announceCall(effects, ended, 'ended', now, { leftRinging: call.state === 'ringing' });
    await livekit.deleteRoom(roomName(callId));
    return;
  }

  switch (event.event) {
    case 'room_started':
      return;
    case 'participant_joined': {
      const identity = event.participant?.identity ?? '';
      if (!sideOfIdentity(secret, call, identity)) return;
      const joined = await markJoined(app.redis, app.keys, callId, identity, callIdentities(secret, call), now);
      if (joined.verdict === 'activated' && joined.call) await announceCall(effects, joined.call, 'activated', now);
      return;
    }
    case 'participant_left': {
      if (isReplacedConnection(event)) return;
      const identity = event.participant?.identity ?? '';
      const side = sideOfIdentity(secret, call, identity);
      if (!side) return;
      await markLeft(app.redis, app.keys, callId, identity);
      if (call.state !== 'connecting' && call.state !== 'active') return;
      const ended = await completeCall(lifecycle, call, side, 'peer_left', now);
      if (ended) await announceCall(effects, ended, 'ended', now);
      return;
    }
    case 'room_finished': {
      if (!isLiveState(call.state) || call.state === 'ringing') return;
      const ended = await completeCall(lifecycle, call, 'system', 'room_gone', now);
      if (ended) await announceCall(effects, ended, 'ended', now);
      return;
    }
    default:
      return;
  }
}
