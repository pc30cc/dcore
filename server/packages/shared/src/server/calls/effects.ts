import { userChannel } from '../../api/realtime.js';
import { realtimeEnvelope } from '../../realtime.js';
import type { RealtimePublisher } from '../clients/centrifugo.js';
import type { PublicIds } from '../ids/publicId.js';
import { jobId } from '../queues.js';
import { callView, isTerminalState, liveCallFields, ROOM_CHECK_FIRST_MS, type LiveCall, type RingStopReason } from './model.js';

/**
 * What a move of a call sets off, after it took place: the `call` event to
 * each of its two people (each sees it from their own side), the jobs that
 * follow (the ring and its stop, the ring timeout, the room check, the
 * finalize), never failing the move itself.
 *
 * - A call that rings nobody (`fake`) is the caller's alone while it rings:
 *   a busy callee hears of it only when it ended (a missed call), a shadow
 *   call never reaches the callee.
 * - `rang` reaches the caller only when the callee shows when they are
 *   online; otherwise the caller hears nothing until the answer or the end.
 * - Every move out of ringing stops the rung phones (never the one that
 *   answered), in order behind the ring itself (the worker's ring-stop job).
 * - Every terminal move queues the finalize job with the call as it ended,
 *   so writing the rows does not depend on the hash still being there.
 */

export type CallJobName = 'ring' | 'room' | 'finalize' | 'ring-push' | 'ring-stop';

/** The `calls` queue, from wherever the move happened (API or worker). */
export interface CallJobQueue {
  add(name: CallJobName, id: string, data: Record<string, unknown>, options?: { delayMs?: number; attempts?: number; backoffMs?: number }): Promise<void>;
}

export interface CallEffectsContext {
  realtime: RealtimePublisher | null;
  publicIds: PublicIds;
  /** Mints the event's id. */
  nextId: () => string;
  jobs: CallJobQueue;
  log: { warn: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
}

export type CallMove = 'placed' | 'rang' | 'accepted' | 'activated' | 'ended';

/** What the caller's phone shows of a ring: the caller's first name and small photo. */
export interface RingFace {
  peerName: string;
  peerPhotoUrl?: string | undefined;
}

/** The finalize job: rows and line, then the events and the missed-call push. Retried while PostgreSQL is down. */
export const FINALIZE_ATTEMPTS = 12;
export const FINALIZE_BACKOFF_MS = 2_000;

/** Who hears of a call now. */
export function callAudience(call: LiveCall, move: CallMove): ('caller' | 'callee')[] {
  const out: ('caller' | 'callee')[] = [];
  if (move !== 'rang' || call.rangShown) out.push('caller');
  const calleeHears = call.fake === null || (call.fake === 'busy' && isTerminalState(call.state));
  if (calleeHears) out.push('callee');
  return out;
}

async function publish(ctx: CallEffectsContext, call: LiveCall, move: CallMove, now: number): Promise<void> {
  if (!ctx.realtime) return;
  const eventId = ctx.nextId();
  for (const side of callAudience(call, move)) {
    const userId = side === 'caller' ? call.callerId : call.calleeId;
    const envelope = realtimeEnvelope('call', eventId, now, callView(call, userId));
    await ctx.realtime
      .publish(userChannel(ctx.publicIds.user.encode(userId)), envelope)
      .catch((error: unknown) => ctx.log.warn({ err: error, callId: call.id, side }, 'call: event not published'));
  }
}

async function queue(ctx: CallEffectsContext, call: LiveCall, name: CallJobName, data: Record<string, unknown>, options: { delayMs?: number; attempts?: number; backoffMs?: number } = {}, id = jobId(name, call.id)): Promise<void> {
  try {
    await ctx.jobs.add(name, id, { callId: call.id, ...data }, options);
  } catch (error) {
    // The ring timeout and the room check queue a lost finalize again when they find the call over.
    ctx.log.error({ err: error, callId: call.id, job: name }, 'call: job not queued');
  }
}

/** The stop reason of a move out of ringing. */
export function stopReasonOf(call: LiveCall): RingStopReason {
  if (call.state === 'connecting') return 'answered_elsewhere';
  if (call.outcome === 'declined') return 'declined';
  if (call.outcome === 'cancelled') return 'cancelled';
  if (call.outcome === 'missed') return 'missed';
  return 'ended';
}

/** The finalize job of a call that ended, carrying the call as it ended. */
export function queueFinalize(ctx: Pick<CallEffectsContext, 'jobs' | 'log'>, call: LiveCall): Promise<void> {
  return queue(ctx as CallEffectsContext, call, 'finalize', { call: liveCallFields(call) }, { attempts: FINALIZE_ATTEMPTS, backoffMs: FINALIZE_BACKOFF_MS });
}

/** Tells both people and queues what follows a move. Never throws. */
export async function announceCall(
  ctx: CallEffectsContext,
  call: LiveCall,
  move: CallMove,
  now: number,
  options: { ring?: RingFace | undefined; leftRinging?: boolean | undefined } = {},
): Promise<void> {
  await publish(ctx, call, move, now);
  switch (move) {
    case 'placed':
      await queue(ctx, call, 'ring', {}, { delayMs: Math.max(0, call.placedMs + call.ringMs - now) + 250, attempts: 5, backoffMs: 1_000 });
      if (call.fake === null && options.ring) await queue(ctx, call, 'ring-push', { ...options.ring }, { attempts: 2, backoffMs: 500 });
      return;
    case 'accepted':
      await queue(ctx, call, 'ring-stop', { reason: 'answered_elsewhere' }, { attempts: 5, backoffMs: 500 });
      await queue(ctx, call, 'room', {}, { delayMs: ROOM_CHECK_FIRST_MS, attempts: 5, backoffMs: 5_000 });
      return;
    case 'ended':
      if (options.leftRinging && call.fake === null) await queue(ctx, call, 'ring-stop', { reason: stopReasonOf(call) }, { attempts: 5, backoffMs: 500 });
      await queueFinalize(ctx, call);
      return;
    default:
      return;
  }
}
