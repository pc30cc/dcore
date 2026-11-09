import { creditWallet, discoveryCell, useWalletItem } from '@app/db';
import { walletItem, wireTime, type BoostKind } from '@app/shared';
import {
  BOOST_DURATION_MS,
  boostPeriod,
  giveBackBoostAllowance,
  lockBoost,
  parentCell,
  runningBoost,
  startBoost,
  unlockBoost,
  useBoostAllowance,
} from '@app/shared/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nextId } from '../../auth/sessions.js';
import { HttpProblem } from '../../lib/problem.js';
import type { ActiveAccount } from '../active.js';
import { planLimit, sessionPlan } from '../plans.js';

/**
 * `POST /v1/boosts`: 30 minutes of extra visibility in the person's r5
 * cell. A boost comes from the month's allowance (the plan's
 * `monthly_boosts`, counted in Valkey: no statement), else from the wallet
 * (one statement: the debit and its ledger row); a spotlight only from the
 * wallet. The start is one MULTI on kv-core: `boost:<uid>` and, when the
 * person's cell is known, `ZADD bst:<r5>` with the trim of ended boosts.
 * One start per person at a time (`boost:lock:`); a boost already running
 * answers with its own end and spends nothing, so a retried request never
 * pays twice. The cell is the home cell of `loc:<uid>` (no statement), else
 * the discovery row's (one read).
 */

const ITEM: Record<BoostKind, number> = { boost: walletItem.code('boost'), spotlight: walletItem.code('spotlight') };

function budget(request: FastifyRequest, statements: number): void {
  if (request.pgTally?.budget !== undefined) request.pgTally.budget += statements;
}

export class BoostService {
  constructor(private readonly app: FastifyInstance) {}

  private async cellOf(request: FastifyRequest, userId: string): Promise<string | null> {
    const { app } = this;
    try {
      const stamp = await app.redis.get(app.keys.location(userId));
      const r7 = stamp?.split(':')[0];
      if (r7 && /^[1-9][0-9]{0,19}$/.test(r7)) return parentCell(r7, 5);
    } catch (error) {
      request.log.warn({ err: error }, 'boost: last location unreadable');
    }
    budget(request, 1);
    return discoveryCell(app.pg, userId);
  }

  async start(request: FastifyRequest, account: ActiveAccount, kind: BoostKind, now: number = Date.now()): Promise<{ endsAt: string; started: boolean }> {
    const { app } = this;
    const userId = account.session.userId;
    const store = account.session.storeCode ?? 0;
    const lock = await lockBoost(app.redis, app.keys, userId);
    if (!lock) {
      const running = await runningBoost(app.redis, app.keys, userId, now);
      if (running !== null) return { endsAt: wireTime(running), started: false };
      throw new HttpProblem('rate_limited', { retryAfterSeconds: 1, headers: { 'retry-after': '1' } });
    }
    try {
      const running = await runningBoost(app.redis, app.keys, userId, now);
      if (running !== null) return { endsAt: wireTime(running), started: false };
      const cfg = app.cfg.get();
      let allowance = false;
      const planned = await sessionPlan({ cache: app.cache, keys: app.keys, db: app.pg, log: request.log }, request, cfg, userId, account.session.storeCode);
      if (kind === 'boost') {
        // Test accounts are left out of quotas.
        const limit = account.test ? -1 : planLimit(planned.plan, 'monthly_boosts');
        allowance = (await useBoostAllowance(app.redis, app.keys, userId, limit, now)).allowed;
      }
      const boostId = nextId(app);
      let paid: { store: number } | null = null;
      if (!allowance) {
        budget(request, 1);
        paid = await useWalletItem(app.pg, {
          userId,
          item: ITEM[kind],
          store,
          crossStore: cfg.app['billing.cross_store_entitlements'],
          ledgerId: nextId(app),
          refId: boostId,
        });
        if (!paid) {
          throw new HttpProblem('quota_exceeded', {
            extensions: { feature: kind === 'boost' ? 'boosts' : 'spotlight', resetsAt: wireTime(boostPeriod(now).resetsAtMs), canBuy: true },
          });
        }
      }
      const endMs = now + BOOST_DURATION_MS;
      try {
        const cell = await this.cellOf(request, userId);
        await startBoost(app.redis, app.keys, userId, cell, endMs, now);
      } catch (error) {
        request.log.error({ err: error }, 'boost: not started; what it took goes back');
        if (allowance) await giveBackBoostAllowance(app.redis, app.keys, userId, now).catch(() => undefined);
        if (paid) {
          budget(request, 1);
          await creditWallet(app.pg, { userId, item: ITEM[kind], store: paid.store, quantity: 1, reason: 9, ledgerId: nextId(app), refId: boostId, adminId: null }).catch(
            (e: unknown) => request.log.error({ err: e, boostId }, 'boost: the wallet item was not given back'),
          );
        }
        throw new HttpProblem('service_unavailable', { detail: 'Try again in a moment.', headers: { 'retry-after': '5' } });
      }
      if (paid) await app.store.entitlements.walletMoved(request, userId, planned.base, kind, -1);
      return { endsAt: wireTime(endMs), started: true };
    } finally {
      await unlockBoost(app.redis, app.keys, userId, lock).catch(() => undefined);
    }
  }
}
