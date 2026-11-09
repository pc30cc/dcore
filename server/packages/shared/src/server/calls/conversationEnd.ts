import { announceCall, type CallEffectsContext } from './effects.js';
import { endPairCall, type LifecycleContext } from './lifecycle.js';

/**
 * The live calls of conversations that just ended (an unmatch, a block, a
 * ban or suspension, a deletion), ended at once by the path that ended the
 * conversation: a ringing call is cancelled (its rung phones are stopped),
 * an answered one hung up, and the finalize writes the rows and tells
 * nobody, as for a conversation found ended by a later request, webhook or
 * room check (which stay the fallback when this cannot run).
 *
 * Never throws: each conversation is tried on its own and a failure is
 * logged. Returns how many calls it ended.
 */
export async function endCallsWithConversations(
  lifecycle: LifecycleContext,
  effects: CallEffectsContext,
  ended: readonly { matchId: string; lo: string; hi: string }[],
  now: number,
): Promise<number> {
  let count = 0;
  for (const { matchId, lo, hi } of ended) {
    try {
      const call = await endPairCall(lifecycle, { id: matchId, lo, hi }, now);
      if (!call) continue;
      count += 1;
      // Cancelled only from ringing: its rung phones still ring.
      await announceCall(effects, call, 'ended', now, { leftRinging: call.state === 'cancelled' });
    } catch (error) {
      effects.log.warn({ err: error, conversationId: matchId }, 'calls: the call of an ended conversation was not ended now; its next check ends it');
    }
  }
  return count;
}
