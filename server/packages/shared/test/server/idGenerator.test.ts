import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { idParts } from '../../src/index.js';
import { IdGenerator, IdGeneratorUnavailableError, createKeys, type IdClock, type IdGeneratorEvent } from '../../src/server/index.js';
import { dropPrefix, hasRedis, testPrefix, testRedis } from './support.js';

class FakeClock implements IdClock {
  wall = Date.UTC(2026, 10, 6, 9, 0, 0);
  mono = 1_000;
  now(): number {
    return this.wall;
  }
  monotonic(): number {
    return this.mono;
  }
  advance(ms: number): void {
    this.wall += ms;
    this.mono += ms;
  }
}

function unavailable(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    if (error instanceof IdGeneratorUnavailableError) return error.reason;
    throw error;
  }
}

describe.skipIf(!hasRedis)('id generator (Valkey leases)', () => {
  let redis: Redis;
  const prefix = testPrefix();
  const keys = createKeys(prefix);
  const make = (clock: IdClock, events: IdGeneratorEvent[] = [], holder?: string) =>
    new IdGenerator({ redis, keyPrefix: prefix, clock, autoRefresh: false, holder, onEvent: (e) => events.push(e) });

  beforeAll(() => {
    redis = testRedis();
  });
  afterAll(async () => {
    await dropPrefix(redis, prefix);
    redis.disconnect();
  });

  it('takes the lowest free numbers and mints unique, increasing ids under them', async () => {
    const clock = new FakeClock();
    const a = make(clock);
    const b = make(clock);
    expect(await a.start()).toBe(0);
    expect(await b.start()).toBe(1);
    expect(await redis.pttl(keys.idLease(0))).toBeGreaterThan(55_000);
    const seen = new Set<bigint>();
    let last = 0n;
    for (let i = 0; i < 6_000; i += 1) {
      if (i % 1_000 === 0) clock.advance(1);
      const id = a.next();
      expect(id > last).toBe(true);
      last = id;
      seen.add(id);
      seen.add(b.next());
    }
    expect(seen.size).toBe(12_000);
    expect(idParts(last).generator).toBe(0);
    await a.stop();
    await b.stop();
    expect(await redis.exists(keys.idLease(0), keys.idLease(1))).toBe(0);
  });

  it('hands out distinct numbers to processes starting at once', async () => {
    const clock = new FakeClock();
    const many = Array.from({ length: 30 }, () => make(clock));
    const numbers = await Promise.all(many.map((g) => g.start()));
    expect(new Set(numbers).size).toBe(30);
    await Promise.all(many.map((g) => g.stop()));
  });

  it('stops minting when the lease was not refreshed for 40 s, and resumes after a refresh', async () => {
    const clock = new FakeClock();
    const g = make(clock);
    await g.start();
    clock.mono += 39_999;
    clock.wall += 39_999;
    expect(unavailable(() => g.next())).toBeUndefined();
    clock.advance(1);
    expect(unavailable(() => g.next())).toBe('lease_stale');
    await g.refresh();
    expect(unavailable(() => g.next())).toBeUndefined();
    await g.stop();
  });

  it('notices a lost lease and takes another number', async () => {
    const clock = new FakeClock();
    const events: IdGeneratorEvent[] = [];
    const g = make(clock, events);
    const first = await g.start();
    // Another process took the number while this one was frozen.
    await redis.set(keys.idLease(first), 'someone-else', 'PX', 60_000);
    await g.refresh();
    expect(events.map((e) => e.type)).toEqual(['acquired', 'lost', 'acquired']);
    expect(g.generator).not.toBe(first);
    expect(idParts(g.next()).generator).toBe(g.generator);
    await g.stop();
    expect(await redis.get(keys.idLease(first))).toBe('someone-else');
    await redis.del(keys.idLease(first));
  });

  it('rides out a small step back of the clock and refuses a larger one', async () => {
    const clock = new FakeClock();
    const g = make(clock);
    await g.start();
    const before = g.next();
    clock.wall -= 30;
    const after = g.next();
    expect(after > before).toBe(true);
    expect(idParts(after).ms).toBe(idParts(before).ms);
    clock.wall -= 100;
    // 130 ms behind the last id: past the 50 ms margin.
    expect(unavailable(() => g.next())).toBe('clock_behind');
    clock.advance(80);
    // 50 ms behind: minted on the last id's millisecond.
    const caughtUp = g.next();
    expect(caughtUp > after).toBe(true);
    // A step of seconds is a jump: stopped until the next refresh takes a baseline.
    clock.wall -= 2_000;
    expect(unavailable(() => g.next())).toBe('clock_jump');
    await g.refresh();
    expect(unavailable(() => g.next())).toBe('clock_behind');
    clock.advance(2_000);
    expect(g.next() > caughtUp).toBe(true);
    await g.stop();
  });

  it('stops on a forward jump of the wall clock until the next refresh', async () => {
    const clock = new FakeClock();
    const events: IdGeneratorEvent[] = [];
    const g = make(clock, events);
    await g.start();
    g.next();
    clock.wall += 5_000;
    expect(unavailable(() => g.next())).toBe('clock_jump');
    expect(unavailable(() => g.next())).toBe('clock_jump');
    expect(events.some((e) => e.type === 'clock_jump')).toBe(true);
    await g.refresh();
    expect(idParts(g.next()).ms).toBe(clock.wall);
    await g.stop();
  });

  it('borrows at most 50 ms ahead when a millisecond runs out of sequence numbers', async () => {
    const clock = new FakeClock();
    const g = make(clock);
    await g.start();
    let last = 0n;
    let refused: string | undefined;
    for (let i = 0; i < 4_096 * 60 && refused === undefined; i += 1) {
      try {
        last = g.next();
      } catch (error) {
        refused = (error as IdGeneratorUnavailableError).reason;
      }
    }
    expect(refused).toBe('clock_behind');
    expect(idParts(last).ms - clock.wall).toBe(50);
    await g.stop();
  });

  it('refuses before a lease and after stop', async () => {
    const g = make(new FakeClock());
    expect(unavailable(() => g.next())).toBe('no_lease');
    await g.start();
    await g.stop();
    expect(unavailable(() => g.next())).toBe('stopped');
  });
});
