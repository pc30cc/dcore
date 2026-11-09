import {
  applyModeration,
  decideAppeal,
  revokeModeration,
  type AppealDecision,
  type ModerationApplyOutcome,
  type ModerationEffect,
  type ModerationInput,
  type ModerationRevokeOutcome,
  type Queryable,
} from '@app/db';
import {
  SAFETY_QUEUE,
  applyModerationEffects,
  endCallsWithConversations,
  safetyJobAttempts,
  safetyJobIds,
  safetyJobNames,
  type ModerationEffectsResult,
} from '@app/shared/server';
import type { FastifyInstance } from 'fastify';

/**
 * Moderation actions the server writes: warnings, suspensions, bans and
 * shadowbans, their lifting, and the decision on an appeal. Each is one
 * statement (migration 0016), run on `db` (the pool, or the transaction of
 * a caller that also writes its audit row), followed by the Valkey and
 * realtime side (`applyModerationEffects`): the person leaves every list on
 * everyone's next request, their tokens stop when their scope shrinks, and
 * they hear `account` with the reason they read (never for a shadowban).
 * An action with an end gets its `moderation-end` job.
 *
 * The side effects run after the statement; a caller that runs it inside a
 * transaction calls {@link ModerationActions.effects} after its commit.
 */

export type ModerationRequest = Omit<ModerationInput, 'actionId'>;

export interface ModerationResult<O> {
  outcome: O;
  effects: ModerationEffectsResult | null;
}

/** What the actions use of the app (the API's instance, or any holder of the same clients). */
export type ModerationApp = Pick<FastifyInstance, 'pg' | 'redis' | 'cache' | 'keys' | 'publicIds' | 'realtime' | 'denyList' | 'ids' | 'jobs'> & {
  log: { warn(object: object, message: string): void; error(object: object, message: string): void };
  /** The calls queue and clock: a live call of a conversation the action ended ends with it. */
  calls?: Pick<FastifyInstance['calls'], 'jobs' | 'now'> | undefined;
};

export class ModerationActions {
  private readonly log: ModerationApp['log'];

  constructor(
    private readonly app: ModerationApp,
    log?: ModerationApp['log'],
  ) {
    this.log = log ?? app.log;
  }

  /** Applies a penalty; `db` defaults to the pool. */
  async apply(input: ModerationRequest, db: Queryable = this.app.pg): Promise<ModerationResult<ModerationApplyOutcome>> {
    const actionId = this.app.ids.nextId();
    const outcome = await applyModeration(db, { ...input, actionId });
    if (outcome.outcome !== 'applied') return { outcome, effects: null };
    const effects = db === this.app.pg ? await this.effects(outcome) : null;
    if (db === this.app.pg && input.endsAt) await this.scheduleEnd(actionId, outcome.userId, input.endsAt);
    return { outcome, effects };
  }

  /** Lifts an action before its end. */
  async revoke(actionId: string, options: { adminId?: number; reasonText?: string } = {}, db: Queryable = this.app.pg): Promise<ModerationResult<ModerationRevokeOutcome>> {
    const outcome = await revokeModeration(db, actionId, this.app.ids.nextId(), options);
    if (outcome.outcome !== 'revoked') return { outcome, effects: null };
    return { outcome, effects: db === this.app.pg ? await this.effects(outcome) : null };
  }

  /** Decides an open appeal (an overturn lifts the action). */
  async decide(appealId: string, overturn: boolean, options: { adminId?: number; text?: string } = {}, db: Queryable = this.app.pg): Promise<ModerationResult<AppealDecision>> {
    const outcome = await decideAppeal(db, appealId, overturn, this.app.ids.nextId(), options);
    if (outcome.outcome !== 'overturned' || db !== this.app.pg) return { outcome, effects: null };
    return { outcome, effects: await this.effects(outcome) };
  }

  /** The Valkey and realtime side of a moderation write (after its commit). */
  async effects(effect: ModerationEffect): Promise<ModerationEffectsResult> {
    const { app } = this;
    const result = await applyModerationEffects(
      {
        redis: app.redis,
        cache: app.cache,
        keys: app.keys,
        publicIds: app.publicIds,
        realtime: app.realtime,
        denyList: app.denyList,
        nextId: () => app.ids.nextId(),
        log: this.log,
      },
      effect,
    );
    // A call in a conversation the action ended (a ban, a suspension) ends with it.
    if (app.calls && effect.ended.length > 0) {
      await endCallsWithConversations(
        { redis: app.redis, keys: app.keys, mintId: () => app.ids.nextId() },
        { realtime: app.realtime, publicIds: app.publicIds, nextId: () => app.ids.nextId(), jobs: app.calls.jobs, log: this.log },
        effect.ended,
        app.calls.now(),
      );
    }
    return result;
  }

  /** Queues the end of a period (suspension, timed ban or shadowban). */
  async scheduleEnd(actionId: string, userId: string, endsAt: Date): Promise<void> {
    await this.app.jobs.add(SAFETY_QUEUE, safetyJobNames.moderationEnd, safetyJobIds.moderationEnd(actionId), { actionId, userId }, {
      delayMs: Math.max(0, endsAt.getTime() - Date.now()),
      attempts: safetyJobAttempts.moderationEnd.attempts,
      backoffMs: safetyJobAttempts.moderationEnd.backoffMs,
    });
  }
}
