import { callPair, type CallPairRow } from '@app/db';
import { idTime, photoStatus, wireTime, type Call, type CallKind } from '@app/shared';
import {
  LIVE_GUARD_MS,
  PARTICIPANT_TOKEN_TTL_SECONDS,
  acceptCall,
  announceCall,
  callKeys,
  callView,
  cacheOpenPairState,
  conversationEnded,
  endCallsWithConversations,
  endForEndedConversation,
  cancelCall,
  declineCall,
  failCall,
  fakeRingMs,
  giveBackRing,
  hangUpCall,
  isLiveState,
  isRingOn,
  isTerminalState,
  issueTurnUsername,
  missCall,
  participantIdentity,
  participantNetwork,
  photoVariantUrl,
  placeCall,
  matchStateOf,
  readCall,
  readMatchStateOrEnd,
  roomName,
  sideOf,
  stampRang,
  takeCalleeRing,
  takeCallerRing,
  turnReuseFloorSeconds,
  withTurnUsername,
  type CallEffectsContext,
  type CallMove,
  type LifecycleContext,
  type LiveCall,
  type RingFace,
} from '@app/shared/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nextId } from '../auth/sessions.js';
import { HttpProblem } from '../lib/problem.js';
import type { AccountView } from './account.js';
import { activeAccount } from './active.js';
import type { ConfigSnapshot } from './cfg.js';
import { sessionPlan } from './plans.js';
import { sessionOf, type AppSession } from './session.js';

/**
 * Calls between the two people of an active conversation (`/v1/calls`).
 * A live call is a Valkey hash moved by Lua (`@app/shared/server` calls);
 * none of these routes sends a statement while their caches are warm, and
 * PostgreSQL receives the finished call only, in one transaction written by
 * the worker's finalize job.
 *
 * Placement: the caller's rate (10 a minute), the conversation (active, the
 * caller one of its two people, both visible to each other in conversations,
 * both allowing calls in it), the configuration (`calls.enabled`), the
 * plan when calls are paid (a plan feature `audio_calls`/`video_calls` set
 * to false), the callee's rate (6 rings a minute by everyone together,
 * given back when the ring never left), then the placement script (the busy
 * rule and the live cap in one step). "Deny on create, allow on continuity":
 * nothing after the placement looks at the plan or the settings again.
 *
 * A busy callee is never revealed: the caller gets an ordinary ring that
 * ends as missed after a short while, and the callee finds a missed call. A
 * caller nobody may see (a shadowban) gets the same, and nobody else hears
 * of it. Outsiders, ended conversations and blocked pairs get 404, as for a
 * call or a conversation that does not exist.
 */

/** Slack between processes when comparing a hide time with a verdict's. */
const VERDICT_SLACK_MS = 5_000;
/** How long a pair's visibility verdict stands. */
const VERDICT_TTL_MS = 60_000;

function budget(request: FastifyRequest, statements: number): void {
  if (request.pgTally?.budget !== undefined) request.pgTally.budget += statements;
}

interface Pair {
  matchId: string;
  lo: string;
  hi: string;
  flags: number;
  state: number;
  /** The callee may see the caller (false: a caller nobody may see). */
  callerVisible: boolean;
}

export interface CallTokenAnswer {
  token: string;
  expiresAt: string;
  wsUrl: string;
  turn: { urls: string[]; username: string; credential: string } | null;
  icePolicy: 'all';
  warnings: string[];
}

export class CallService {
  constructor(
    private readonly app: FastifyInstance,
    private readonly request: FastifyRequest,
  ) {}

  private get log() {
    return this.request.log;
  }

  private get now(): number {
    return this.app.calls.now();
  }

  private lifecycle(): LifecycleContext {
    return { redis: this.app.redis, keys: this.app.keys, mintId: () => nextId(this.app) };
  }

  private effects(): CallEffectsContext {
    const { app } = this;
    return {
      realtime: app.realtime,
      publicIds: app.publicIds,
      nextId: () => nextId(app),
      jobs: app.calls.jobs,
      log: this.log,
    };
  }

  private announce(call: LiveCall, move: CallMove, options: { ring?: RingFace; leftRinging?: boolean } = {}): Promise<void> {
    return announceCall(this.effects(), call, move, this.now, options);
  }

  private ready(): void {
    if (!this.app.calls.livekit || !this.app.calls.identitySecret) {
      throw new HttpProblem('service_unavailable', { detail: 'Calls are not available now.', headers: { 'retry-after': '30' } });
    }
  }

  // ─── Placement ─────────────────────────────────────────────────────────

  async place(input: { conversationId: string; kind: CallKind }): Promise<Call> {
    const { app } = this;
    this.ready();
    const account = await activeAccount(app, this.request, { allowSnoozed: true });
    const callerId = account.session.userId;
    const now = this.now;
    const callerRing = await takeCallerRing(app.redis, app.keys, callerId, now);
    if (!callerRing.allowed) throw this.rateLimited(callerRing.retryAfterSeconds);

    const pair = await this.pair(input.conversationId, callerId, now);
    const calleeId = pair.lo === callerId ? pair.hi : pair.lo;
    const cfg = app.cfg.get();
    if (!cfg.app['calls.enabled'][input.kind]) throw callsNotAllowed('disabled');
    const callerBit = pair.lo === callerId ? 1 : 2;
    const calleeBit = callerBit === 1 ? 2 : 1;
    if ((pair.flags & callerBit) === 0 || (pair.flags & calleeBit) === 0) throw callsNotAllowed('consent');
    if (!(await this.planAllows(cfg, account.session, input.kind))) throw callsNotAllowed('plan');

    const shadow = !pair.callerVisible;
    const calleeRing = shadow ? null : await takeCalleeRing(app.redis, app.keys, calleeId, now);
    if (calleeRing && !calleeRing.allowed) throw this.rateLimited(calleeRing.retryAfterSeconds);
    const giveBack = async () => {
      if (calleeRing) await giveBackRing(app.redis, calleeRing).catch((error: unknown) => this.log.warn({ err: error }, 'call: ring not given back'));
    };

    const id = nextId(app);
    const face = this.ringFace(account.view);
    let verdict;
    try {
      verdict = await placeCall(app.redis, app.keys, {
        id,
        matchId: pair.matchId,
        callerId,
        calleeId,
        kind: input.kind,
        now,
        maxLive: app.calls.rtc.get().maxLiveCalls,
        shadow,
        fakeRingMs: fakeRingMs(app.calls.random),
        callerName: face.peerName,
      });
    } catch (error) {
      await giveBack();
      throw error;
    }
    if (verdict === 'ended') {
      // The conversation ended after it was checked (a block, an unmatch): as for any ended one.
      await giveBack();
      throw new HttpProblem('not_found');
    }
    if (verdict === 'caller_busy') {
      await giveBack();
      throw new HttpProblem('caller_busy');
    }
    if (verdict === 'limit_reached') {
      await giveBack();
      throw new HttpProblem('limit_reached', { detail: 'Calls are busy right now; try again in a moment.' });
    }
    if (verdict === 'exists') throw new Error('a new call id was already in use');
    // A call that rings nobody gives the callee's ring back: it never left.
    if (verdict === 'callee_busy') await giveBack();

    const call = await readCall(app.redis, app.keys, id);
    if (!call) throw new Error('the placed call is not readable');
    await this.announce(call, 'placed', { ring: face });
    return callView(call, callerId);
  }

  /**
   * The conversation as a call needs it: from `mt:<id>` and the pair's
   * visibility verdict (a minute, dropped when either person was hidden
   * since), else one statement (the match and the visibility rule both
   * ways). 404 for anything the caller may not call, and at once for a
   * conversation whose end left its tombstone, whatever copy of its state
   * or verdict is still around.
   */
  private async pair(matchId: string, callerId: string, now: number): Promise<Pair> {
    const { app } = this;
    const verdictKey = callKeys(app.keys).eligibility(matchId);
    const [{ ended, hash }, verdict] = await Promise.all([
      readMatchStateOrEnd(app.redis, app.keys, matchId),
      app.cache.get(verdictKey).catch(() => null),
    ]);
    if (ended) throw new HttpProblem('not_found');
    const state = matchStateOf(matchId, hash);
    if (state?.state === 1 && verdict) {
      const parsed = /^([0-9]{1,15}):([01])([01])$/.exec(verdict);
      if (parsed) {
        const at = Number(parsed[1]);
        const hidden = await app.redis.zmscore(app.keys.accountsHidden(), state.lo, state.hi);
        const fresh = now - at < VERDICT_TTL_MS && hidden.every((score) => score === null || Number(score) < at - VERDICT_SLACK_MS);
        if (fresh) return this.decide({ matchId, lo: state.lo, hi: state.hi, flags: state.flags, state: state.state, loSeesHi: parsed[2] === '1', hiSeesLo: parsed[3] === '1' }, callerId);
      }
    }
    budget(this.request, 1);
    const row: CallPairRow | null = await callPair(app.pg, matchId);
    if (!row) throw new HttpProblem('not_found');
    if (row.state === 1) {
      const kept = await cacheOpenPairState(app.redis, app.keys, { ...row, createdMs: idTime(row.id).getTime() }).catch((error: unknown) => {
        this.log.warn({ err: error }, 'call: pair not cached');
        return null;
      });
      // Read just before the conversation ended (a block, an unmatch): it is over.
      if (kept === 'ended') throw new HttpProblem('not_found');
      if (kept === 'cached') {
        await app.cache
          .set(verdictKey, `${now}:${row.loSeesHi ? 1 : 0}${row.hiSeesLo ? 1 : 0}`, 'PX', VERDICT_TTL_MS)
          .catch((error: unknown) => this.log.warn({ err: error }, 'call: pair verdict not cached'));
      }
    }
    return this.decide({ matchId, lo: row.lo, hi: row.hi, flags: row.flags, state: row.state, loSeesHi: row.loSeesHi, hiSeesLo: row.hiSeesLo }, callerId);
  }

  private decide(p: { matchId: string; lo: string; hi: string; flags: number; state: number; loSeesHi: boolean; hiSeesLo: boolean }, callerId: string): Pair {
    if (p.state !== 1 || (p.lo !== callerId && p.hi !== callerId)) throw new HttpProblem('not_found');
    const callerIsLo = p.lo === callerId;
    const calleeVisible = callerIsLo ? p.loSeesHi : p.hiSeesLo;
    const callerVisible = callerIsLo ? p.hiSeesLo : p.loSeesHi;
    // A peer the caller may not see in conversations (hidden, gone, blocked) is not there.
    if (!calleeVisible) throw new HttpProblem('not_found');
    return { matchId: p.matchId, lo: p.lo, hi: p.hi, flags: p.flags, state: p.state, callerVisible };
  }

  /** Calls are free unless a plan sets `<kind>_calls` to false; only then is the caller's plan read. */
  private async planAllows(cfg: ConfigSnapshot, session: AppSession, kind: CallKind): Promise<boolean> {
    const feature = `${kind}_calls`;
    if (!cfg.plans.some((plan) => plan.features[feature] === false)) return true;
    const { plan } = await sessionPlan({ cache: this.app.cache, keys: this.app.keys, db: this.app.pg, log: this.log }, this.request, cfg, session.userId, session.storeCode);
    return plan?.features[feature] !== false;
  }

  /** What the callee's phone shows: the caller's first name and the small variant of their first approved photo. */
  private ringFace(view: AccountView): RingFace {
    const name = [...(view.profile?.name.trim().split(/\s+/u)[0] ?? '')].slice(0, 40).join('') || '…';
    const photo = [...view.photos].filter((p) => p.status === photoStatus.code('approved')).sort((a, b) => a.position - b.position)[0];
    const url = photo && this.app.media ? photoVariantUrl(this.app.media, photo.id, photo.blobVer, 320) : undefined;
    return { peerName: name, ...(url && url.length <= 1_500 ? { peerPhotoUrl: url } : {}) };
  }

  private rateLimited(retryAfterSeconds: number): HttpProblem {
    return new HttpProblem('rate_limited', {
      detail: `Too many calls; retry in ${retryAfterSeconds} s.`,
      retryAfterSeconds,
      headers: { 'retry-after': String(retryAfterSeconds) },
    });
  }

  // ─── One call ──────────────────────────────────────────────────────────

  /** The call and the asker's side; 404 for anyone but its two people (and for a call that is gone). */
  private async member(callId: string): Promise<{ call: LiveCall; session: AppSession; side: 'caller' | 'callee' }> {
    const session = sessionOf(this.app, this.request);
    const call = await readCall(this.app.redis, this.app.keys, callId);
    const side = call ? sideOf(call, session.userId) : null;
    if (!call || !side) throw new HttpProblem('not_found');
    // The callee never learns of a call that rings nobody until it is over (a missed call); a shadow call never.
    if (side === 'callee' && call.fake !== null && (call.fake === 'shadow' || !isTerminalState(call.state))) throw new HttpProblem('not_found');
    // The conversation ended (an unmatch, a block, a ban): a call still live ends, and the call is gone for both.
    if (await conversationEnded(this.app.redis, this.app.keys, call.matchId)) {
      if (isLiveState(call.state)) {
        const ended = await endForEndedConversation(this.lifecycle(), call, this.now);
        if (ended) await this.announce(ended, 'ended', { leftRinging: call.state === 'ringing' });
      }
      throw new HttpProblem('not_found');
    }
    return { call, session, side };
  }

  /** A ring that ran out and that nobody marked missed yet is missed now. */
  private async current(call: LiveCall): Promise<LiveCall> {
    const now = this.now;
    if (call.state !== 'ringing' || isRingOn(call, now)) return call;
    const missed = await missCall(this.lifecycle(), call, now);
    if (missed) {
      await this.announce(missed, 'ended', { leftRinging: true });
      return missed;
    }
    return (await readCall(this.app.redis, this.app.keys, call.id)) ?? call;
  }

  async get(callId: string): Promise<Call> {
    const { call, session } = await this.member(callId);
    return callView(await this.current(call), session.userId);
  }

  /** The callee's phone showed the ring; the caller is told only when the callee shows online. */
  async rang(callId: string): Promise<void> {
    const { call, session, side } = await this.member(callId);
    if (side !== 'callee') throw new HttpProblem('forbidden', { detail: 'Only the person being called can say it rang.' });
    budget(this.request, 1);
    const loaded = await this.app.account.load(session.userId);
    if (loaded.cached) budget(this.request, -1);
    const shown = loaded.result.kind === 'account' && loaded.result.view.profile?.showOnline !== false;
    const { verdict, call: stamped } = await stampRang(this.app.redis, this.app.keys, callId, this.now, shown);
    if (verdict === 'stamped' && stamped) {
      await this.announce(stamped, 'rang');
      return;
    }
    if (verdict === 'already') return;
    if (verdict === 'over') await this.current(call);
    throw new HttpProblem('not_ringing');
  }

  async accept(callId: string): Promise<{ call: Call; token: CallTokenAnswer }> {
    this.ready();
    const { app } = this;
    const { call, session, side } = await this.member(callId);
    if (side !== 'callee') throw new HttpProblem('forbidden', { detail: 'Only the person being called can answer.' });
    const latest = await this.current(call);
    if (latest.state !== 'ringing') return this.lateAnswer(latest, session);
    const livekit = app.calls.livekit!;
    try {
      await livekit.createRoom(roomName(callId), { emptyTimeoutSeconds: 300, maxParticipants: 4, metadata: JSON.stringify({ call_id: callId }) });
    } catch (error) {
      this.log.error({ err: error, callId }, 'call: the room could not be created');
      const failed = await failCall(this.lifecycle(), latest, 'room_failed', this.now);
      if (failed) {
        await this.announce(failed, 'ended', { leftRinging: true });
      } else {
        // Not ringing any more: another phone answered meanwhile (its room was made), or it ended.
        const current = await readCall(app.redis, app.keys, callId);
        if (current && current.state !== 'ringing') return this.lateAnswer(current, session);
      }
      throw new HttpProblem('service_unavailable', { detail: 'The call could not be connected.', headers: { 'retry-after': '5' } });
    }
    const answered = await acceptCall(this.lifecycle(), latest, session.deviceId, this.now);
    if (!answered) {
      const now = await readCall(app.redis, app.keys, callId);
      if (now && isTerminalState(now.state)) void livekit.deleteRoom(roomName(callId));
      return this.lateAnswer(now ?? latest, session);
    }
    const token = await this.issueToken(answered, session.userId);
    await this.announce(answered, 'accepted');
    return { call: callView(answered, session.userId), token };
  }

  /**
   * An answer that found the call no longer ringing: the same phone asking
   * again (a lost reply) gets its token again; another phone of the callee
   * learns the call was answered elsewhere; anything else is over.
   */
  private async lateAnswer(call: LiveCall, session: AppSession): Promise<{ call: Call; token: CallTokenAnswer }> {
    if (call.state === 'connecting' || call.state === 'active') {
      if (call.answeredDevice && call.answeredDevice === session.deviceId) {
        return { call: callView(call, session.userId), token: await this.issueToken(call, session.userId) };
      }
      throw new HttpProblem('answered_elsewhere');
    }
    throw new HttpProblem('not_ringing');
  }

  async decline(callId: string): Promise<Call> {
    const { call, session, side } = await this.member(callId);
    if (side !== 'callee') throw new HttpProblem('forbidden', { detail: 'Only the person being called can decline.' });
    const moved = call.state === 'ringing' ? await declineCall(this.lifecycle(), call, this.now) : null;
    if (moved) {
      await this.announce(moved, 'ended', { leftRinging: true });
      return callView(moved, session.userId);
    }
    return callView(await this.current((await readCall(this.app.redis, this.app.keys, callId)) ?? call), session.userId);
  }

  async cancel(callId: string): Promise<Call> {
    const { call, session, side } = await this.member(callId);
    if (side !== 'caller') throw new HttpProblem('forbidden', { detail: 'Only the caller can cancel.' });
    const moved = call.state === 'ringing' ? await cancelCall(this.lifecycle(), call, this.now) : null;
    if (moved) {
      await this.announce(moved, 'ended', { leftRinging: true });
      return callView(moved, session.userId);
    }
    return callView((await readCall(this.app.redis, this.app.keys, callId)) ?? call, session.userId);
  }

  /** Either person hangs up: before the answer the caller's cancel or the callee's decline; after it, the end. */
  async end(callId: string): Promise<Call> {
    const { call, session, side } = await this.member(callId);
    let current: LiveCall | null = call;
    for (let attempt = 0; attempt < 2 && current && isLiveState(current.state); attempt += 1) {
      const wasRinging = current.state === 'ringing';
      const moved = await hangUpCall(this.lifecycle(), current, side, this.now);
      if (moved) {
        await this.announce(moved, 'ended', { leftRinging: wasRinging });
        return callView(moved, session.userId);
      }
      current = await readCall(this.app.redis, this.app.keys, callId);
    }
    return callView(current ?? call, session.userId);
  }

  /** A join token while the call is answered (asked again on every rejoin). */
  async token(callId: string): Promise<CallTokenAnswer> {
    this.ready();
    const { call, session } = await this.member(callId);
    if (call.state !== 'connecting' && call.state !== 'active') throw new HttpProblem('call_not_live');
    return this.issueToken(call, session.userId);
  }

  /**
   * The join token and the network of one participant: the opaque identity,
   * no name, no metadata; the relay only when this request's own trusted
   * country is on the relay's list.
   */
  private async issueToken(call: LiveCall, userId: string): Promise<CallTokenAnswer> {
    const { app } = this;
    const runtime = app.calls;
    const now = this.now;
    const wsUrl = runtime.rtc.clientWsUrl();
    if (!wsUrl || !runtime.livekit || !runtime.identitySecret) {
      throw new HttpProblem('service_unavailable', { detail: 'Calls are not available now.', headers: { 'retry-after': '30' } });
    }
    const side = sideOf(call, userId);
    if (side === null) throw new HttpProblem('not_found');
    const identity = participantIdentity(runtime.identitySecret, call.id, userId);
    const minted = await runtime.livekit.participantToken({ identity, room: roomName(call.id), ttlSeconds: PARTICIPANT_TOKEN_TTL_SECONDS, now });
    const rtc = runtime.rtc.get();
    // No relay credential outlives the call's guard, and each participant keeps one username for the call.
    const notAfterMs = call.placedMs + LIVE_GUARD_MS;
    let network = participantNetwork(rtc, this.request.clientCountry, now, { notAfterMs });
    if (network.turn) {
      let issued: string | null;
      try {
        issued = await issueTurnUsername(app.redis, app.keys, call.id, side, network.turn.username, turnReuseFloorSeconds(rtc, now, notAfterMs));
      } catch (error) {
        throw new HttpProblem('service_unavailable', { detail: 'Calls are not available now.', headers: { 'retry-after': '5' }, cause: error });
      }
      if (issued === null) throw new HttpProblem('call_not_live');
      network = withTurnUsername(rtc, network, issued);
    }
    return { token: minted.token, expiresAt: wireTime(minted.expiresAtMs), wsUrl, turn: network.turn, icePolicy: 'all', warnings: network.warnings };
  }
}

function callsNotAllowed(reason: 'consent' | 'disabled' | 'plan'): HttpProblem {
  return new HttpProblem('calls_not_allowed', { extensions: { reason } });
}

/**
 * Ends the live calls of conversations a request just ended (an unmatch, a
 * block, a deletion), at once; never throws (a call it misses ends at its
 * next request, webhook or room check).
 */
export function endCallsOf(
  app: FastifyInstance,
  log: CallEffectsContext['log'],
  ended: readonly { matchId: string; lo: string; hi: string }[],
): Promise<number> {
  if (ended.length === 0) return Promise.resolve(0);
  return endCallsWithConversations(
    { redis: app.redis, keys: app.keys, mintId: () => nextId(app) },
    { realtime: app.realtime, publicIds: app.publicIds, nextId: () => nextId(app), jobs: app.calls.jobs, log },
    ended,
    app.calls.now(),
  );
}
