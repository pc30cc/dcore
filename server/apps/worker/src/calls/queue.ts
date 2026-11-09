import { isTransientDatabaseError, pushTargetsOf, withTransaction, writeFinishedCall, type FinishedCallRow } from '@app/db';
import { callEndReason, callEndedBy, callKind, callOutcome, idTime, messageKind, notifyFlags, pushPayload, userChannel, wireTime, realtimeEnvelope } from '@app/shared';
import {
  CALL_RING_MS,
  CONNECT_MAX_MS,
  LIVE_GUARD_MS,
  LiveKitApi,
  ROOM_CHECK_EVERY_MS,
  activateCall,
  announceCall,
  callLineMessage,
  callLineUnreadFor,
  completeCall,
  conversationEnded,
  encodeCallLineBody,
  endCallsWithConversations,
  endForEndedConversation,
  holdDirectWrites,
  isTerminalState,
  missCall,
  noteMessage,
  parseLiveCall,
  queueFinalize,
  readCall,
  releaseDirectWrites,
  ringPushStep,
  roomName,
  sideOfIdentity,
  talkSeconds,
  type CallEffectsContext,
  type CallJobName,
  type CallJobQueue,
  type LifecycleContext,
  type LiveCall,
  type PushSender,
  type RungDevice,
} from '@app/shared/server';
import { DelayedError, type Job } from 'bullmq';
import { z } from 'zod';
import { releaseDeadToken } from '../push/deliver.js';
import { firstName, pushLocale } from '../push/texts.js';
import { dropTextOnLastFailure } from '../queues/push.js';
import { queueJob } from '../social/jobs.js';
import type { JobContext, QueueDefinition } from '../queues/types.js';
import { missedCallText } from './texts.js';

/**
 * Call jobs (queue `calls`), one set per call, with deterministic ids:
 *
 * - `ring.<id>`: the ring timeout, when the ring runs out. A call still
 *   ringing then is missed (a compare-and-set on the ring being over, so it
 *   is missed once and only once, whoever else tries); one that moved on
 *   needs nothing, but its finalize is queued again in case the move's was
 *   lost.
 * - `room.<id>`: the room check, 90 s after the answer and then every
 *   minute while the call lives. LiveKit lists who is in the room: both
 *   people → the call is on (a call still connecting becomes active); one
 *   or both missing, or the room gone → it ends. LiveKit unreachable decides
 *   nothing, except that a call still connecting 5 minutes after the answer
 *   ends. A call 12 hours old ends whatever LiveKit says.
 * - `finalize.<id>`: the finished call, carried in the job (it does not
 *   depend on the hash): the room deleted, then one transaction of two
 *   INSERTs (the `calls` row and its line in the chat), then the line to
 *   both people and the conversation lists, then the missed-call push to the
 *   callee (after the line, so its badge counts it). Each step is recorded
 *   in the job, so a retry does only what is left; a replayed job writes
 *   nothing and sends nothing. The line's id is minted right before the
 *   transaction (and kept in the job for its retries), not when the call
 *   ended: a sync cursor handed out while the finalize waited (LiveKit slow
 *   to delete the room, a busy worker, PostgreSQL down) is then below it, so
 *   a client catching up with `after=` still fetches the line. PostgreSQL
 *   unreachable delays the job without using an attempt, however long it
 *   lasts. A conversation that is not active any more when the rows go in
 *   keeps them for reports and tells nobody. A shadow call (a caller nobody
 *   may see) leaves its line for the caller only, as a message nobody else
 *   may see: the other person is never told, counts nothing and gets no
 *   push.
 * - `ring-push.<id>` and `ring-stop.<id>`: the ring to the callee's phones
 *   and its stop, in that order whatever FCM does (ringPush.lua): a ring is
 *   never sent for a call that already stopped ringing, a stop waits for its
 *   ring in flight, and goes only to the phones that were rung, never to the
 *   one that answered.
 */

export const CALLS_QUEUE = 'calls';

const ID = z.string().regex(/^[1-9][0-9]{0,18}$/);
const callJobSchema = z.object({ callId: ID });
const ringPushSchema = callJobSchema.extend({ peerName: z.string().min(1).max(40), peerPhotoUrl: z.url().max(1_500).optional() });
const ringStopSchema = callJobSchema.extend({ reason: z.enum(['answered_elsewhere', 'declined', 'cancelled', 'missed', 'ended']) });
const finalizeSchema = callJobSchema.extend({
  call: z.record(z.string(), z.string()),
  done: z
    .object({ lineId: ID.optional(), rows: z.boolean().optional(), published: z.boolean().optional(), pushed: z.boolean().optional(), replay: z.boolean().optional() })
    .optional(),
});

/** A stop still waiting for its ring after this long goes out anyway, to every device of the callee. */
export const RING_SENDING_STALE_MS = 30_000;
const STOP_RECHECK_MS = 500;

export interface CallQueueOptions {
  /** LiveKit's server API (tests point it at a fake); default from LIVEKIT_*, null: none. */
  livekit?: LiveKitApi | null | undefined;
  identitySecret?: string | null | undefined;
  /** The clock of every decision (tests move it). */
  now?: (() => number) | undefined;
  /** Where the jobs that follow a move go (tests keep them in memory); default the `calls` queue. */
  jobs?: CallJobQueue | undefined;
}

export type CallJobResult =
  | { outcome: 'gone' | 'over' | 'answered' | 'ringing' | 'missed' | 'kept' | 'activated' | 'ended' | 'nothing' }
  | { outcome: 'finalized'; rows: boolean; replay: boolean }
  | { outcome: 'rung'; devices: number }
  | { outcome: 'stopped'; devices: number }
  | { outcome: 'skipped'; reason: string };

/** What a job needs of BullMQ's job (tests pass a stand-in). */
export type CallJob = Pick<Job, 'name' | 'data' | 'attemptsMade' | 'attemptsStarted' | 'moveToDelayed' | 'updateData'> & Partial<Pick<Job, 'opts'>>;

interface CallRuntime {
  livekit: LiveKitApi | null;
  identitySecret: string | null;
  now: () => number;
  jobs: CallJobQueue | undefined;
}

function runtimeOf(context: JobContext, options: CallQueueOptions, cache: { livekit?: LiveKitApi | null }): CallRuntime {
  const config = context.config.livekit;
  if (options.livekit !== undefined) cache.livekit = options.livekit;
  if (cache.livekit === undefined) cache.livekit = config ? new LiveKitApi({ apiUrl: config.apiUrl, apiKey: config.apiKey, apiSecret: config.apiSecret }) : null;
  return {
    livekit: cache.livekit,
    identitySecret: options.identitySecret !== undefined ? options.identitySecret : (config?.identitySecret ?? null),
    now: options.now ?? Date.now,
    jobs: options.jobs,
  };
}

/** The `calls` queue as seen from a job. */
export function callJobsOf(context: JobContext): CallJobQueue {
  return {
    add: (name: CallJobName, id: string, data: Record<string, unknown>, opts = {}) =>
      queueJob(context.redis, context.config.queuePrefix, { queue: 'calls', name, id, data, delayMs: opts.delayMs, attempts: opts.attempts, backoffMs: opts.backoffMs }),
  };
}

function lifecycleOf(context: JobContext): LifecycleContext {
  return { redis: context.redis, keys: context.services.keys, mintId: () => context.services.ids.nextId() };
}

function effectsOf(context: JobContext, runtime: Pick<CallRuntime, 'jobs'>): CallEffectsContext {
  return {
    realtime: context.services.realtime,
    publicIds: context.services.publicIds,
    nextId: () => context.services.ids.nextId(),
    jobs: runtime.jobs ?? callJobsOf(context),
    log: context.log,
  };
}

/**
 * Ends, at once, the live calls of conversations a job just ended (a deletion
 * fan-out, a deferred report's block, a moderation change); never throws.
 */
export function endCallsOf(context: JobContext, ended: readonly { matchId: string; lo: string; hi: string }[]): Promise<number> {
  if (ended.length === 0) return Promise.resolve(0);
  return endCallsWithConversations(lifecycleOf(context), effectsOf(context, { jobs: undefined }), ended, Date.now());
}

async function later(job: CallJob, context: JobContext, atMs: number): Promise<never> {
  if (!context.token) throw new Error('a delayed retry needs the job token');
  await job.moveToDelayed(atMs, context.token);
  throw new DelayedError();
}

// ─── The ring timeout ───────────────────────────────────────────────────

export async function ringTimeoutJob(job: CallJob, context: JobContext, runtime: CallRuntime): Promise<CallJobResult> {
  const { callId } = callJobSchema.parse(job.data);
  const now = runtime.now();
  const call = await readCall(context.redis, context.services.keys, callId);
  if (!call) return { outcome: 'gone' };
  if (isTerminalState(call.state)) {
    await queueFinalize(effectsOf(context, runtime), call);
    return { outcome: 'over' };
  }
  if (call.state !== 'ringing') return { outcome: 'answered' };
  // A clock a little behind the API's: try again when the ring is really over.
  if (now < call.placedMs + call.ringMs) return later(job, context, Date.now() + (call.placedMs + call.ringMs - now) + 250);
  const missed = await missCall(lifecycleOf(context), call, now);
  if (missed) {
    await announceCall(effectsOf(context, runtime), missed, 'ended', now, { leftRinging: true });
    return { outcome: 'missed' };
  }
  const current = await readCall(context.redis, context.services.keys, callId);
  if (current && isTerminalState(current.state)) await queueFinalize(effectsOf(context, runtime), current);
  return { outcome: 'nothing' };
}

// ─── The room check ─────────────────────────────────────────────────────

export async function roomCheckJob(job: CallJob, context: JobContext, runtime: CallRuntime): Promise<CallJobResult> {
  const { callId } = callJobSchema.parse(job.data);
  const now = runtime.now();
  const call = await readCall(context.redis, context.services.keys, callId);
  if (!call) return { outcome: 'gone' };
  if (isTerminalState(call.state)) {
    await queueFinalize(effectsOf(context, runtime), call);
    return { outcome: 'over' };
  }
  if (call.state === 'ringing') return { outcome: 'ringing' };
  const end = async (reason: 'expired' | 'connect_timeout' | 'room_gone' | 'peer_left'): Promise<CallJobResult> => {
    const ended = await completeCall(lifecycleOf(context), call, 'system', reason, now);
    if (ended) {
      await announceCall(effectsOf(context, runtime), ended, 'ended', now);
      return { outcome: 'ended' };
    }
    return { outcome: 'nothing' };
  };
  // The guard of last resort: no call lives as long as its hash.
  if (now - call.placedMs >= LIVE_GUARD_MS) return end('expired');
  // The conversation ended (an unmatch, a block, a ban): the call ends with it.
  if (await conversationEnded(context.redis, context.services.keys, call.matchId)) {
    const ended = await endForEndedConversation(lifecycleOf(context), call, now);
    if (ended) await announceCall(effectsOf(context, runtime), ended, 'ended', now);
    return { outcome: ended ? 'ended' : 'nothing' };
  }
  const connectingTooLong = call.state === 'connecting' && call.answeredMs !== undefined && now - call.answeredMs >= CONNECT_MAX_MS;

  let identities: string[] | null = null;
  if (runtime.livekit) {
    try {
      identities = await runtime.livekit.listIdentities(roomName(callId));
    } catch (error) {
      context.log.warn({ err: error, callId }, 'room check: LiveKit not reachable; nothing decided');
    }
  }
  if (identities === null || !runtime.identitySecret) {
    if (connectingTooLong) return end('connect_timeout');
    return later(job, context, Date.now() + ROOM_CHECK_EVERY_MS);
  }
  const sides = new Set(identities.map((identity) => sideOfIdentity(runtime.identitySecret!, call, identity)).filter((s) => s !== null));
  if (sides.has('caller') && sides.has('callee')) {
    if (call.state === 'connecting') {
      const active = await activateCall(lifecycleOf(context), call, now);
      if (active) await announceCall(effectsOf(context, runtime), active, 'activated', now);
    }
    return later(job, context, Date.now() + ROOM_CHECK_EVERY_MS);
  }
  return end(identities.length === 0 ? 'room_gone' : 'peer_left');
}

// ─── Finalize ───────────────────────────────────────────────────────────

export async function finalizeJob(job: CallJob, context: JobContext, runtime: CallRuntime): Promise<CallJobResult> {
  const data = finalizeSchema.parse(job.data);
  const call = parseLiveCall(data.call);
  if (!call || !isTerminalState(call.state) || !call.outcome || !call.endedBy || !call.endReason || call.endedMs === undefined || !call.lineId) {
    context.log.error({ callId: data.callId }, 'finalize: not a finished call; dropped');
    return { outcome: 'skipped', reason: 'invalid' };
  }
  const { services, log } = context;
  // The room first: it needs no database, and nobody may stay in a finished call's room.
  if (runtime.livekit && (call.roomCreated || call.answeredMs !== undefined)) {
    const deleted = await runtime.livekit.deleteRoom(roomName(call.id));
    if (deleted === 'failed') log.warn({ callId: call.id }, 'finalize: the room could not be deleted (LiveKit closes it when empty)');
  }
  const done = { ...data.done };
  if (!done.rows) {
    // The line's id is minted by each try right before its transaction and held until it is done: no
    // client's sync cursor passes it before it is durable, and a try that did not commit leaves no id
    // behind (a retry minutes later would otherwise write an id below cursors handed out meanwhile).
    // A try that committed is found by the next one, which reads the stored line back.
    const lineId = context.services.ids.nextId();
    await holdDirectWrites(context.redis, services.keys, [lineId]);
    const duration = talkSeconds(call);
    const summary = { kind: call.kind, outcome: call.outcome, durationSeconds: duration, placedMs: call.placedMs };
    const row: FinishedCallRow = {
      id: call.id,
      matchId: call.matchId,
      callerId: call.callerId,
      calleeId: call.calleeId,
      rangAtMs: call.rangMs ?? null,
      answeredAtMs: call.outcome === 'completed' ? (call.answeredMs ?? null) : null,
      endedAtMs: call.endedMs,
      durationSeconds: duration,
      kind: callKind.code(call.kind),
      outcome: callOutcome.code(call.outcome),
      endedBy: callEndedBy.code(call.endedBy),
      endReason: callEndReason.code(call.endReason),
      relayed: call.relayed,
    };
    let written;
    try {
      written = await withTransaction(services.pg, (tx) => writeFinishedCall(tx, row, { id: lineId, body: encodeCallLineBody(summary) }));
    } catch (error) {
      // PostgreSQL down: the job waits without using an attempt (the next try mints its own line id).
      if (isTransientDatabaseError(error)) return await databaseLater(job, context, call.id, error);
      throw error;
    } finally {
      await releaseDirectWrites(context.redis, services.keys, [lineId]).catch((error: unknown) => log.warn({ err: error, callId: call.id }, 'finalize: hold not released (it runs out)'));
    }
    // Nothing written by the job's first run: the call was finalized before (a replayed job).
    done.replay = !written.call && !written.line && job.attemptsMade === 0 && job.attemptsStarted <= 1;
    done.rows = true;
    if (written.lineId) done.lineId = written.lineId;
    // The conversation is over (a block, an unmatch, however long ago): the rows stay for reports, nobody is told.
    if (!written.active) {
      done.published = true;
      done.pushed = true;
    }
    await job.updateData({ ...data, done });
  }
  if (done.replay) return { outcome: 'finalized', rows: false, replay: true };
  // No line stored (the conversation was purged before the rows went in): nothing to show anyone.
  if (!done.lineId) return { outcome: 'finalized', rows: false, replay: false };
  const line: LiveCall = { ...call, lineId: done.lineId };
  // A conversation that ended meanwhile (a block, an unmatch) keeps the rows for reports, and tells nobody.
  if (!done.published && (await conversationEnded(context.redis, services.keys, call.matchId))) {
    done.published = true;
    done.pushed = true;
    await job.updateData({ ...data, done });
  }

  if (!done.published) {
    await publishLine(context, line);
    done.published = true;
    await job.updateData({ ...data, done });
  }
  if (!done.pushed) {
    if (call.fake !== 'shadow' && callLineUnreadFor({ outcome: call.outcome }, 'callee') && services.push) {
      try {
        await sendMissedCall(context, services.push, call);
      } catch (error) {
        if (isTransientDatabaseError(error)) return await databaseLater(job, context, call.id, error);
        throw error;
      }
    }
    done.pushed = true;
    await job.updateData({ ...data, done });
  }
  return { outcome: 'finalized', rows: true, replay: false };
}

/** How long a finalize waits for PostgreSQL to come back before it tries again. */
export const FINALIZE_DATABASE_WAIT_MS = 5_000;

function databaseLater(job: CallJob, context: JobContext, callId: string, error: unknown): Promise<never> {
  context.log.warn({ err: error, callId }, 'finalize: PostgreSQL not reachable; trying again later');
  return later(job, context, Date.now() + FINALIZE_DATABASE_WAIT_MS);
}

/**
 * The line to both people (`message`) and the conversation lists (preview,
 * order, the callee's unread count); a shadow call's to the caller only, as
 * a message the other person may not see. Its time is the stored line's
 * (its id's), as the history and the list read it.
 */
async function publishLine(context: JobContext, call: LiveCall): Promise<void> {
  const { services, redis, log } = context;
  const lo = BigInt(call.callerId) < BigInt(call.calleeId) ? call.callerId : call.calleeId;
  const hi = lo === call.callerId ? call.calleeId : call.callerId;
  const summary = { kind: call.kind, outcome: call.outcome!, durationSeconds: talkSeconds(call), placedMs: call.placedMs };
  const body = encodeCallLineBody(summary);
  const shadow = call.fake === 'shadow';
  const unread = !shadow && callLineUnreadFor(summary, 'callee');
  await noteMessage(redis, services.keys, {
    message: { id: call.lineId!, matchId: call.matchId, senderId: call.callerId, refId: call.id, kind: messageKind.code('call'), flags: 0, body },
    lo,
    hi,
    unreadFor: unread ? (call.calleeId === lo ? 'lo' : 'hi') : null,
    ...(shadow ? { only: call.callerId === lo ? ('lo' as const) : ('hi' as const) } : {}),
  }).catch((error: unknown) => log.warn({ err: error, callId: call.id }, 'finalize: conversation lists not updated'));
  if (!services.realtime) return;
  const callerPublicUid = services.publicIds.user.encode(call.callerId);
  const atMs = idTime(call.lineId!).getTime();
  const message = callLineMessage({ lineId: call.lineId!, conversationId: call.matchId, callId: call.id, callerPublicUid, summary, atMs });
  const channels = (shadow ? [call.callerId] : [call.callerId, call.calleeId]).map((id) => userChannel(services.publicIds.user.encode(id)));
  await services.realtime
    .broadcast(channels, realtimeEnvelope('message', call.lineId!, atMs, message))
    .catch((error: unknown) => log.warn({ err: error, callId: call.id }, 'finalize: the call line was not published (history has it)'));
}

/** The missed-call notification to the callee's devices, in each device's language. */
async function sendMissedCall(context: JobContext, sender: PushSender, call: LiveCall): Promise<void> {
  const { services, log } = context;
  const target = await pushTargetsOf(services.pg, call.calleeId);
  if (!target || (target.notifyFlags & notifyFlags.code('calls')) === 0) return;
  const previews = (target.notifyFlags & notifyFlags.code('previews')) !== 0;
  for (const device of target.devices) {
    const payload = pushPayload(
      'call_missed',
      { callId: call.id, conversationId: call.matchId },
      { text: missedCallText(pushLocale(device.locale ?? target.locale), call.kind, previews, call.callerName) },
    );
    const outcome = await sender.send(device.token, payload);
    if (!outcome.ok && outcome.unregistered) await releaseDeadToken(context, device.id, device.token);
    else if (!outcome.ok) log.warn({ status: outcome.status, callId: call.id }, 'missed-call push not delivered');
  }
}

// ─── The ring and its stop ──────────────────────────────────────────────

export async function ringPushJob(job: CallJob, context: JobContext, runtime: CallRuntime): Promise<CallJobResult> {
  const data = ringPushSchema.parse(job.data);
  const { services, redis, log } = context;
  // The reads come before the ring is marked as sending: one that fails (PostgreSQL away a moment) leaves the
  // ring untouched, so the retry still rings; after the mark, nothing left can fail before the stop may go.
  const call = await readCall(redis, services.keys, data.callId);
  const sender = services.push;
  const target = call && sender ? await pushTargetsOf(services.pg, call.calleeId) : null;
  const now = runtime.now();
  const step = await ringPushStep(redis, services.keys, data.callId, 'begin', now);
  if (step.step !== 'go') return { outcome: 'skipped', reason: step.step === 'skip' ? step.reason : step.step };
  const rung: RungDevice[] = [];
  try {
    // Whatever the callee's `calls` switch says: it silences only the missed-call notification; a match's
    // call consent is what stops calls.
    if (call && sender && target) {
      const payload = pushPayload('call_incoming', {
        callId: call.id,
        conversationId: call.matchId,
        kind: call.kind,
        // A first name only, and never one that is really a phone number or an address.
        peerName: firstName(data.peerName) || '…',
        ...(data.peerPhotoUrl ? { peerPhotoUrl: data.peerPhotoUrl } : {}),
        expiresAt: wireTime(call.placedMs + CALL_RING_MS),
      });
      for (const device of target.devices) {
        rung.push({ d: device.id, t: device.token });
        const outcome = await sender.send(device.token, payload);
        if (!outcome.ok && outcome.unregistered) await releaseDeadToken(context, device.id, device.token);
        else if (!outcome.ok) log.warn({ status: outcome.status, callId: call.id }, 'ring not delivered');
      }
    }
  } finally {
    // Whatever happened, the stop may go now: to exactly the devices this ring went to.
    await ringPushStep(redis, services.keys, data.callId, 'done', runtime.now(), rung);
  }
  return { outcome: 'rung', devices: rung.length };
}

export async function ringStopJob(job: CallJob, context: JobContext, runtime: CallRuntime): Promise<CallJobResult> {
  const data = ringStopSchema.parse(job.data);
  const { services, redis, log } = context;
  const now = runtime.now();
  let step = await ringPushStep(redis, services.keys, data.callId, 'stop', now);
  if (step.step === 'wait') {
    if (now - step.sinceMs < RING_SENDING_STALE_MS) return later(job, context, Date.now() + STOP_RECHECK_MS);
    step = await ringPushStep(redis, services.keys, data.callId, 'force', now);
  }
  if (step.step !== 'send') return { outcome: 'stopped', devices: 0 };
  const sender = services.push;
  if (!sender) return { outcome: 'stopped', devices: 0 };
  let devices = step.rung;
  if (!step.known) {
    // The ring's sender went quiet: every device of the callee hears the stop.
    const call = await readCall(redis, services.keys, data.callId);
    const target = call ? await pushTargetsOf(services.pg, call.calleeId) : null;
    devices = (target?.devices ?? []).map((d) => ({ d: d.id, t: d.token }));
  }
  const payload = pushPayload('call_cancel', { callId: data.callId, reason: data.reason });
  let sent = 0;
  for (const device of devices) {
    if (step.answeredDevice && device.d === step.answeredDevice) continue;
    const outcome = await sender.send(device.t, payload);
    if (outcome.ok) sent += 1;
    else if (!outcome.unregistered) log.warn({ status: outcome.status, callId: data.callId }, 'ring stop not delivered');
  }
  return { outcome: 'stopped', devices: sent };
}

// ─── The queue ──────────────────────────────────────────────────────────

export function callsQueue(options: CallQueueOptions = {}): QueueDefinition<unknown, CallJobResult> {
  const cache: { livekit?: LiveKitApi | null } = {};
  return {
    name: CALLS_QUEUE,
    async process(job, context) {
      const runtime = runtimeOf(context, options, cache);
      switch (job.name) {
        case 'ring':
          return ringTimeoutJob(job, context, runtime);
        case 'room':
          return roomCheckJob(job, context, runtime);
        case 'finalize':
          return finalizeJob(job, context, runtime);
        case 'ring-push':
          // A ring that failed for good is kept without the caller's name and photo link.
          return dropTextOnLastFailure(job, context.log, () => ringPushJob(job, context, runtime));
        case 'ring-stop':
          return ringStopJob(job, context, runtime);
        default:
          throw new Error(`the calls queue has no job named "${job.name}"`);
      }
    },
  };
}
