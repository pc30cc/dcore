import { generateKeyPairSync } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ACK_DEADLINE_MS,
  BAZAAR_BACKGROUND_PER_MINUTE,
  BAZAAR_RECHECK_DELAY_MS,
  BAZAAR_CHECK_SPREAD_MS,
  BAZAAR_RENEWAL_GRACE_MS,
  BazaarVerifier,
  FakePardakht,
  MemoryBazaarCallMeter,
  PardakhtClient,
  StoreError,
  bazaarRecheckAt,
  retryPlan,
  signBazaarPurchase,
  utcDay,
  type Fetch,
  type PurchaseRef,
  type VerifiedPurchase,
} from '../../src/server/index.js';

/**
 * How many calls Bazaar gets for 100,000 monthly subscribers, over 63
 * simulated days, through the real client, call meter and verifier, against
 * the fake developer API in process. The scheduler does what the purchase
 * core and the worker do with a verified purchase: a re-check at
 * `nextCheckAtMs`, one refund check at `refundCheckAtMs` for a new purchase,
 * a consume for a credited one-time product, and a failed call tried again
 * on the worker's retry plan (30 s doubling to 30 minutes; a day for checks,
 * 60 h for consumes); a purchase the app posts is tried again by its outbox a
 * minute later.
 *
 * The load: 100,000 subscribers on one-month plans whose periods end spread
 * over the month by the time of day people buy (an evening peak, UTC+3:30), 90 % of
 * them renewing each month, 333 new subscribers a day to replace the rest,
 * 700 one-time purchases a day, 1 % of new purchases refunded within a week,
 * 1 % of all calls failing (503), and a campaign that sells 3,000
 * subscriptions in 15 minutes on day 3.
 */

const PACKAGE = 'app.example.bazaar';
const SECRET = 'pishkhan-simulation-token';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const PERIOD = 30 * DAY;
const T0 = Date.UTC(2026, 11, 1);
const DAYS = 63;
const SUBSCRIBERS = 100_000;
const RENEW_RATE = 0.9;
const NEW_PER_DAY = 333;
const ONE_TIME_PER_DAY = 700;
const REFUND_RATE = 0.01;
const FAILURE_RATE = 0.01;
const CAMPAIGN = { day: 3, startUtcHour: 16, size: 3_000, minutes: 15 };
const DAILY_LIMIT = 10_000;
const REF = 'billingrefsim01';

/** How much buying happens in each local hour (UTC+3:30). */
const LOCAL_HOUR_WEIGHT = [0.5, 0.3, 0.2, 0.1, 0.1, 0.1, 0.2, 0.4, 0.6, 0.8, 0.9, 1, 1, 1, 1, 1.1, 1.2, 1.4, 1.6, 1.9, 2.2, 2.4, 2, 1.2];
const WEIGHT_SUM = LOCAL_HOUR_WEIGHT.reduce((a, b) => a + b, 0);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type EventType = 'post-sub' | 'post-one' | 'recheck' | 'refund-check' | 'consume' | 'refund';
interface SimEvent {
  t: number;
  seq: number;
  type: EventType;
  token: string;
  tries: number;
  firstMs: number;
}

class Heap {
  private readonly items: SimEvent[] = [];
  get size(): number {
    return this.items.length;
  }
  push(e: SimEvent): void {
    const a = this.items;
    a.push(e);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.less(a[p]!, a[i]!)) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): SimEvent | undefined {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0 && last) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l]!, a[m]!)) m = l;
        if (r < a.length && this.less(a[r]!, a[m]!)) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
  peek(): SimEvent | undefined {
    return this.items[0];
  }
  private less(x: SimEvent, y: SimEvent): boolean {
    return x.t < y.t || (x.t === y.t && x.seq < y.seq);
  }
}

interface Holding {
  kind: 'subscription' | 'consumable';
  productId: string;
  purchasedAtMs: number;
  /** What the purchase core holds now: the state and when access ends. */
  state: VerifiedPurchase['state'] | null;
  expiresAtMs: number | null;
  campaign: boolean;
  refunded: boolean;
}

interface Result {
  daily: Map<string, number>;
  perMinute: Map<number, number>;
  /** Purchases the app posted (never held back), per minute. */
  urgentPerMinute: Map<number, number>;
  /** Posts still waiting for the app's next try when the run ends. */
  postsPending: number;
  backgroundPerMinute: Map<number, number>;
  posts: number;
  postCalls: number;
  purchasesVerified: number;
  purchases: number;
  renewals: number;
  churned: number;
  lapses: number;
  maxRenewalDelayMs: number;
  maxEndDelayMs: number;
  gaveUp: number;
  refused: number;
  heldBack: number;
  refundedSubs: number;
  refundedSubsEnded: number;
  refundedOneTime: number;
  refundedOneTimeReversed: number;
  campaignChecks: number[];
  ms: number;
}

async function simulate(): Promise<Result> {
  const started = Date.now();
  const rand = mulberry32(20261109);
  let now = T0;
  const fake = new FakePardakht({ packageName: PACKAGE, pishkhanToken: SECRET, now: () => now });
  const daily = new Map<string, number>();
  const perMinute = new Map<number, number>();
  const counted: Fetch = (input, init) => {
    const day = utcDay(now);
    daily.set(day, (daily.get(day) ?? 0) + 1);
    const minute = Math.floor(now / MINUTE);
    perMinute.set(minute, (perMinute.get(minute) ?? 0) + 1);
    fake.requests.length = 0;
    return fake.fetch(input, init);
  };
  const meter = new MemoryBazaarCallMeter(() => now);
  const api = new PardakhtClient({ packageName: PACKAGE, auth: { kind: 'pishkhan', token: SECRET }, baseUrl: 'http://pardakht.fake/devapi/v2', fetch: counted, meter, now: () => now });
  const keys = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const verifier = new BazaarVerifier({ packageName: PACKAGE, rsaPublicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), api, now: () => now });

  const heap = new Heap();
  let seq = 0;
  const jobs = new Set<string>();
  const add = (t: number, type: EventType, token: string, id?: string, tries = 0, firstMs = t): void => {
    if (id !== undefined) {
      if (jobs.has(id)) return;
      jobs.add(id);
    }
    heap.push({ t, seq: seq++, type, token, tries, firstMs });
  };
  const holdings = new Map<string, Holding>();
  const r: Result = {
    daily, perMinute, urgentPerMinute: new Map(), postsPending: 0, backgroundPerMinute: meter.backgroundMinutes, posts: 0, postCalls: 0, purchasesVerified: 0, purchases: 0, renewals: 0, churned: 0, lapses: 0,
    maxRenewalDelayMs: 0, maxEndDelayMs: 0, gaveUp: 0, refused: 0, heldBack: 0, refundedSubs: 0, refundedSubsEnded: 0, refundedOneTime: 0, refundedOneTimeReversed: 0, campaignChecks: [], ms: 0,
  };

  const atInDay = (dayStart: number): number => {
    let pick = rand() * WEIGHT_SUM;
    let hour = 0;
    while (hour < 23 && pick >= LOCAL_HOUR_WEIGHT[hour]!) {
      pick -= LOCAL_HOUR_WEIGHT[hour]!;
      hour += 1;
    }
    // Local time is UTC+3:30; the time stays inside the UTC day asked for.
    return dayStart + ((hour * 60 - 210 + 1440) % 1440) * MINUTE + Math.floor(rand() * HOUR);
  };
  const maybeFail = (): void => {
    if (rand() < FAILURE_RATE) fake.forced.push({ status: 503, body: { error: 'server_error' } });
  };

  // The subscribers already there: each period ends somewhere in the next month; their checks are already scheduled.
  for (let i = 0; i < SUBSCRIBERS; i += 1) {
    const token = `s${i}`;
    const sku = rand() < 0.7 ? 'sub.plus.1m' : 'sub.premium.1m';
    const validUntilMs = atInDay(T0 + Math.floor(rand() * 30) * DAY);
    fake.putSubscription(token, { sku, validUntilMs, startedAtMs: validUntilMs - PERIOD, account: token });
    holdings.set(token, { kind: 'subscription', productId: sku, purchasedAtMs: validUntilMs - PERIOD, state: 'active', expiresAtMs: validUntilMs + BAZAAR_RENEWAL_GRACE_MS, campaign: false, refunded: false });
    const at = bazaarRecheckAt(validUntilMs, token);
    add(at, 'recheck', token, `recheck:${token}:${at}`);
  }
  // Every purchase of the simulated days.
  const buy = (t: number, kind: Holding['kind'], campaign = false): void => {
    const token = `${kind === 'subscription' ? 'n' : 'c'}${r.purchases++}`;
    const productId = kind === 'subscription' ? (rand() < 0.7 ? 'sub.plus.1m' : 'sub.premium.1m') : rand() < 0.6 ? 'cons.superlike.5' : 'cons.boost.1';
    holdings.set(token, { kind, productId, purchasedAtMs: t, state: null, expiresAtMs: null, campaign, refunded: false });
    add(t, kind === 'subscription' ? 'post-sub' : 'post-one', token);
    if (rand() < REFUND_RATE) add(t + HOUR + Math.floor(rand() * 6 * DAY), 'refund', token);
  };
  for (let d = 0; d < DAYS; d += 1) {
    for (let i = 0; i < NEW_PER_DAY; i += 1) buy(atInDay(T0 + d * DAY), 'subscription');
    for (let i = 0; i < ONE_TIME_PER_DAY; i += 1) buy(atInDay(T0 + d * DAY), 'consumable');
  }
  const campaignStart = T0 + CAMPAIGN.day * DAY + CAMPAIGN.startUtcHour * HOUR;
  for (let i = 0; i < CAMPAIGN.size; i += 1) buy(campaignStart + Math.floor(rand() * CAMPAIGN.minutes * MINUTE), 'subscription', true);

  const ref = (token: string, h: Holding): PurchaseRef => ({
    purchaseId: '1287390234923417601', store: 'bazaar', kind: h.kind, token, productId: h.productId, basePlanId: null, orderId: null,
    purchasedAtMs: h.purchasedAtMs, expiresAtMs: h.expiresAtMs, quantity: 1,
  });
  const applied = (token: string, h: Holding, v: VerifiedPurchase, created: boolean): void => {
    h.state = v.state;
    h.expiresAtMs = v.expiresAtMs;
    if (v.nextCheckAtMs !== null) add(v.nextCheckAtMs, 'recheck', token, `recheck:${token}:${v.nextCheckAtMs}`);
    if (created && v.refundCheckAtMs !== null) add(v.refundCheckAtMs, 'refund-check', token, `refund:${token}`);
    if (v.needsConsume && v.state === 'purchased') add(now + 5_000, 'consume', token, `consume:${token}`);
  };
  const later = (e: SimEvent, deadlineMs: number): void => {
    const plan = retryPlan(e.tries, now, deadlineMs);
    if (plan.action === 'give_up') r.gaveUp += 1;
    else heap.push({ ...e, t: plan.atMs, seq: seq++, tries: e.tries + 1 });
  };

  const end = T0 + DAYS * DAY;
  const step = async (e: SimEvent): Promise<void> => {
    const h = holdings.get(e.token)!;
    switch (e.type) {
      case 'refund': {
        h.refunded = true;
        fake.refund(e.token);
        if (h.kind === 'subscription') r.refundedSubs += 1;
        else r.refundedOneTime += 1;
        return;
      }
      case 'post-sub':
      case 'post-one': {
        if (e.tries === 0) {
          if (h.kind === 'subscription') fake.putSubscription(e.token, { sku: h.productId, validUntilMs: now + PERIOD, startedAtMs: now, account: e.token });
          else fake.putInapp(e.token, { productId: h.productId, developerPayload: REF, purchaseTimeMs: now, account: e.token });
        }
        const signed = signBazaarPurchase(keys.privateKey, { purchaseToken: e.token, developerPayload: REF, packageName: PACKAGE, purchaseTime: h.purchasedAtMs, productId: h.productId });
        r.posts += 1;
        const minute = Math.floor(now / MINUTE);
        r.urgentPerMinute.set(minute, (r.urgentPerMinute.get(minute) ?? 0) + 1);
        const before = sumOf(daily);
        maybeFail();
        try {
          const v = await verifier.verify({ store: 'bazaar', productId: h.productId, purchaseToken: e.token, kind: h.kind, ...signed });
          r.purchasesVerified += 1;
          applied(e.token, h, v, true);
        } catch (error) {
          if (!(error instanceof StoreError) || error.kind !== 'unavailable') throw error;
          // The app's outbox posts it again a minute later.
          heap.push({ ...e, t: now + MINUTE, seq: seq++, tries: e.tries + 1 });
        } finally {
          r.postCalls += sumOf(daily) - before;
        }
        return;
      }
      case 'recheck':
      case 'refund-check': {
        if (h.kind === 'subscription') {
          const s = fake.subscriptions.get(e.token)!;
          // Bazaar charges (or not) at the end of the period, before anyone asks.
          if (now >= s.validUntilMs && s.autoRenewing && !h.refunded) {
            if (rand() < RENEW_RATE) {
              r.renewals += 1;
              if (now > (h.expiresAtMs ?? 0) && e.type === 'recheck') r.lapses += 1;
              r.maxRenewalDelayMs = Math.max(r.maxRenewalDelayMs, now - s.validUntilMs);
              fake.renew(e.token, s.validUntilMs + PERIOD);
            } else {
              s.autoRenewing = false;
              r.churned += 1;
              r.maxEndDelayMs = Math.max(r.maxEndDelayMs, now - s.validUntilMs);
            }
          }
          if (h.campaign && e.type === 'recheck' && e.tries === 0) r.campaignChecks.push(now);
        }
        maybeFail();
        try {
          const v = await verifier.recheck(ref(e.token, h));
          if (h.refunded && e.type === 'refund-check') {
            if (h.kind === 'subscription' && v.state === 'expired') r.refundedSubsEnded += 1;
            if (h.kind === 'consumable' && v.state === 'revoked') r.refundedOneTimeReversed += 1;
          }
          applied(e.token, h, v, false);
        } catch (error) {
          if (!(error instanceof StoreError)) throw error;
          if (error.kind === 'invalid') r.refused += 1;
          else later(e, e.firstMs + DAY);
        }
        return;
      }
      case 'consume': {
        maybeFail();
        try {
          await verifier.consume(ref(e.token, h));
        } catch (error) {
          if (!(error instanceof StoreError)) throw error;
          if (error.kind === 'invalid') r.refused += 1;
          else later(e, h.purchasedAtMs + ACK_DEADLINE_MS);
        }
        return;
      }
    }
  };
  while (heap.size > 0 && heap.peek()!.t < end) {
    const e = heap.pop()!;
    now = e.t;
    await step(e);
  }
  for (;;) {
    const e = heap.pop();
    if (!e) break;
    if (e.type === 'post-sub' || e.type === 'post-one') r.postsPending += 1;
  }
  r.heldBack = meter.heldBack;
  r.ms = Date.now() - started;
  return r;
}

function sumOf(map: Map<string, number>): number {
  let s = 0;
  for (const v of map.values()) s += v;
  return s;
}

describe('Bazaar calls for 100,000 monthly subscribers (simulation)', () => {
  let r: Result;

  beforeAll(async () => {
    r = await simulate();
    const days = [...r.daily.values()];
    const campaignDays = new Set([CAMPAIGN.day, CAMPAIGN.day + 7, CAMPAIGN.day + 30].map((d) => utcDay(T0 + d * DAY)));
    const ordinary = [...r.daily.entries()].filter(([day]) => !campaignDays.has(day)).map(([, n]) => n);
    console.info(
      `bazaar simulation: ordinary days max ${Math.max(...ordinary)}, renewal applied at most ${Math.round(r.maxRenewalDelayMs / 60_000)} min after validUntil, ` +
        `ending at most ${Math.round(r.maxEndDelayMs / 60_000)} min after, refunds ${r.refundedSubsEnded}/${r.refundedSubs} subscriptions and ${r.refundedOneTimeReversed}/${r.refundedOneTime} one-time found`,
    );
    console.info(
      `bazaar simulation: ${days.length} days, calls/day max ${Math.max(...days)} mean ${Math.round(days.reduce((a, b) => a + b, 0) / days.length)}, ` +
        `max/minute ${Math.max(...r.perMinute.values())} (background ${Math.max(...r.backgroundPerMinute.values())}), renewals ${r.renewals}, churned ${r.churned}, ` +
        `purchases ${r.purchases}, held back ${r.heldBack}, ${r.ms} ms`,
    );
  }, 600_000);

  it('stays under 10,000 calls every day (the quota is 50,000)', () => {
    expect(r.daily.size).toBe(DAYS);
    for (const [day, calls] of r.daily) expect(calls, `calls on ${day}`).toBeLessThan(DAILY_LIMIT);
    // Steady state, after the first refund checks: about 3,300 renewals, 333 new subscriptions and their refund checks, 3 calls per one-time product.
    const steady = [...r.daily.entries()].filter(([day]) => day >= utcDay(T0 + 10 * DAY)).map(([, calls]) => calls);
    const mean = steady.reduce((a, b) => a + b, 0) / steady.length;
    expect(mean).toBeGreaterThan(5_500);
    expect(mean).toBeLessThan(7_000);
  });

  it('never bursts: background calls stay under the per-minute pace, and the campaign is spread over two hours a month later', () => {
    expect(Math.max(...r.backgroundPerMinute.values())).toBeLessThanOrEqual(BAZAAR_BACKGROUND_PER_MINUTE);
    // A minute carries at most the paced background calls plus the purchases people made in it (those are never held back).
    for (const [minute, calls] of r.perMinute) expect(calls).toBeLessThanOrEqual(BAZAAR_BACKGROUND_PER_MINUTE + (r.urgentPerMinute.get(minute) ?? 0));
    // Outside the campaign's own 15 minutes of buying, purchases add only a few calls to any minute.
    const campaignStart = Math.floor((T0 + CAMPAIGN.day * DAY + CAMPAIGN.startUtcHour * HOUR) / MINUTE);
    const outside = [...r.urgentPerMinute.entries()].filter(([m]) => m < campaignStart || m > campaignStart + CAMPAIGN.minutes + 2).map(([, n]) => n);
    expect(Math.max(...outside)).toBeLessThanOrEqual(10);
    // The campaign's re-checks a month later: spread over about two hours, never more than 60 in a minute.
    expect(r.campaignChecks.length).toBeGreaterThanOrEqual(CAMPAIGN.size * 0.95);
    const span = Math.max(...r.campaignChecks) - Math.min(...r.campaignChecks);
    expect(span).toBeGreaterThan(CAMPAIGN.minutes * MINUTE + BAZAAR_CHECK_SPREAD_MS - 5 * MINUTE);
    const byMinute = new Map<number, number>();
    for (const t of r.campaignChecks) byMinute.set(Math.floor(t / MINUTE), (byMinute.get(Math.floor(t / MINUTE)) ?? 0) + 1);
    expect(Math.max(...byMinute.values())).toBeLessThanOrEqual(BAZAAR_BACKGROUND_PER_MINUTE);
  });

  it('a new purchase costs exactly one call (each try of the app posting it is one call)', () => {
    // Every purchase was verified, but the few whose post failed in the run's last minute and wait for the app's next try.
    expect(r.purchasesVerified + r.postsPending).toBe(r.purchases);
    expect(r.postsPending).toBeLessThan(10);
    expect(r.postCalls).toBe(r.posts);
  });

  it('renewals are learnt before access runs out; endings are applied within the check window', () => {
    expect(r.renewals).toBeGreaterThan(150_000);
    expect(r.lapses).toBe(0);
    expect(r.maxRenewalDelayMs).toBeLessThan(BAZAAR_RENEWAL_GRACE_MS);
    expect(r.churned).toBeGreaterThan(15_000);
    // validUntil + 1 h + the token's spread, plus the retries of a failed call.
    expect(r.maxEndDelayMs).toBeLessThan(BAZAAR_RECHECK_DELAY_MS + BAZAAR_CHECK_SPREAD_MS + 30 * MINUTE);
    expect(r.gaveUp).toBe(0);
    expect(r.refused).toBe(0);
  });

  it('refunds within the week are found by the one refund check', () => {
    expect(r.refundedSubs + r.refundedOneTime).toBeGreaterThan(300);
    // Refunds of the last week of the run have not had their check yet.
    expect(r.refundedSubsEnded).toBeGreaterThan(r.refundedSubs * 0.8);
    expect(r.refundedOneTimeReversed).toBeGreaterThan(r.refundedOneTime * 0.8);
  });
});
