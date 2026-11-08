import type { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { publishToStream, startStreamConsumer, type StreamConsumer, type StreamDelivery } from '../src/index.js';
import { connect, eventually, hasRedis, uniqueName } from './support.js';

describe.skipIf(!hasRedis)('Redis Streams consumer group (redis-server)', () => {
  let admin: Redis;
  const connections: Redis[] = [];
  const consumers: StreamConsumer[] = [];
  const keys: string[] = [];

  beforeAll(() => {
    admin = connect();
  });
  afterAll(async () => {
    await admin.quit();
  });
  afterEach(async () => {
    await Promise.allSettled(consumers.splice(0).map((c) => c.stop()));
    await Promise.allSettled(connections.splice(0).map((c) => c.quit()));
    if (keys.length > 0) await admin.del(...keys.splice(0));
  });

  function newStream(): string {
    const stream = uniqueName('stream');
    keys.push(stream, `${stream}:dead`);
    return stream;
  }

  function start(options: Omit<Parameters<typeof startStreamConsumer>[0], 'redis'>): StreamConsumer {
    const redis = connect();
    connections.push(redis);
    const consumer = startStreamConsumer({ blockMs: 100, ...options, redis });
    consumers.push(consumer);
    return consumer;
  }

  async function publish(stream: string, count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) ids.push(await publishToStream(admin, stream, { n: String(i) }));
    return ids;
  }

  /** Entries delivered but not acknowledged; -1 while the consumer has not created its group yet. */
  async function pendingCount(stream: string, group: string): Promise<number> {
    try {
      const summary = (await admin.xpending(stream, group)) as [number, ...unknown[]];
      return summary[0];
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('NOGROUP')) return -1;
      throw error;
    }
  }

  it('reads in batches of batchSize and acknowledges handled entries', async () => {
    const stream = newStream();
    const seen: string[] = [];
    const batches: number[] = [];
    start({
      stream,
      group: 'g',
      consumer: 'c1',
      batchSize: 4,
      startId: '0',
      handler: async (entry) => {
        seen.push(entry.fields['n'] ?? '');
      },
      onBatch: ({ source, size }) => {
        if (source === 'new') batches.push(size);
      },
    });
    await publish(stream, 10);
    await eventually(() => seen.length === 10);
    expect(seen).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
    expect(Math.max(...batches)).toBeLessThanOrEqual(4);
    await eventually(async () => (await pendingCount(stream, 'g')) === 0);
  });

  it('leaves a failed entry pending and lets another consumer claim it with XAUTOCLAIM', async () => {
    const stream = newStream();
    const failing = start({
      stream,
      group: 'g',
      consumer: 'crashy',
      startId: '0',
      handler: async () => {
        throw new Error('handler down');
      },
    });
    const [id] = await publish(stream, 1);
    await eventually(async () => (await pendingCount(stream, 'g')) === 1);
    await failing.stop();

    const handled: StreamDelivery[] = [];
    start({
      stream,
      group: 'g',
      consumer: 'rescuer',
      claimIdleMs: 200,
      claimIntervalMs: 100,
      handler: async (entry) => {
        handled.push(entry);
      },
    });
    await eventually(() => handled.length === 1);
    expect(handled[0]).toMatchObject({ id, source: 'claimed', fields: { n: '0' } });
    await eventually(async () => (await pendingCount(stream, 'g')) === 0);
  });

  it('moves an entry to the dead-letter stream after maxDeliveries', async () => {
    const stream = newStream();
    let attempts = 0;
    start({
      stream,
      group: 'g',
      consumer: 'c1',
      startId: '0',
      claimIdleMs: 50,
      claimIntervalMs: 50,
      maxDeliveries: 3,
      handler: async () => {
        attempts += 1;
        throw new Error('always fails');
      },
    });
    const [id] = await publish(stream, 1);
    await eventually(async () => (await admin.xlen(`${stream}:dead`)) === 1);
    expect(attempts).toBe(3);
    const [[, fields]] = (await admin.xrange(`${stream}:dead`, '-', '+')) as [[string, string[]]];
    expect(fields).toEqual(['stream', stream, 'group', 'g', 'id', id, 'deliveries', '3', 'reason', 'deliveries', 'fields', '{"n":"0"}']);
    await eventually(async () => (await pendingCount(stream, 'g')) === 0);
  });

  it('dead-letters a rejected entry at once, without the fields it must not keep, and never by count with maxDeliveries 0', async () => {
    const stream = newStream();
    let attempts = 0;
    const alerts: Record<string, unknown>[] = [];
    start({
      stream,
      group: 'g',
      consumer: 'c1',
      startId: '0',
      claimIdleMs: 50,
      claimIntervalMs: 50,
      maxDeliveries: 0,
      alertDeliveries: 2,
      redactFields: ['c'],
      log: { warn: () => undefined, error: (data, message) => message.includes('many deliveries') && alerts.push(data) },
      classify: (error) => ((error as Error).message === 'bad data' ? 'rejected' : 'failed'),
      handler: async (entry) => {
        attempts += 1;
        throw new Error(entry.fields['n'] === '0' ? 'bad data' : 'keeps failing');
      },
    });
    await admin.xadd(stream, '*', 'n', '0', 'c', 'private words');
    await admin.xadd(stream, '*', 'n', '1');
    await eventually(async () => (await admin.xlen(`${stream}:dead`)) === 1);
    const [[, fields]] = (await admin.xrange(`${stream}:dead`, '-', '+')) as [[string, string[]]];
    expect(fields).toEqual(expect.arrayContaining(['reason', 'rejected', 'fields', '{"n":"0","c":"[redacted]"}']));
    // The other keeps failing: it stays pending (never dead-lettered by count) and is reported.
    await eventually(() => alerts.length >= 2);
    expect(attempts).toBeGreaterThan(4);
    expect(await admin.xlen(`${stream}:dead`)).toBe(1);
    expect(await pendingCount(stream, 'g')).toBe(1);
  });

  it('waits out an unavailable database: no claims, no delivery counts burnt, nothing dead-lettered, then handles everything', async () => {
    const stream = newStream();
    let up = false;
    let probes = 0;
    const handled: string[] = [];
    start({
      stream,
      group: 'g',
      consumer: 'c1',
      startId: '0',
      claimIdleMs: 30,
      claimIntervalMs: 30,
      maxDeliveries: 2,
      classify: (error) => ((error as Error).message === 'down' ? 'unavailable' : 'failed'),
      probe: async () => {
        probes += 1;
        if (!up) throw new Error('still down');
      },
      handler: async (entry) => {
        if (!up) throw new Error('down');
        handled.push(entry.fields['n']!);
      },
    });
    await publish(stream, 5);
    // Ten times maxDeliveries × claimIdleMs: an outage this long dead-letters nothing.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(await admin.xlen(`${stream}:dead`)).toBe(0);
    expect(probes).toBeGreaterThan(0);
    const counts = (await admin.xpending(stream, 'g', '-', '+', 10)) as [string, string, number, number][];
    expect(counts.every(([, , , deliveries]) => deliveries <= 2)).toBe(true);
    up = true;
    await eventually(() => handled.length === 5, 10_000);
    expect(handled.sort()).toEqual(['0', '1', '2', '3', '4']);
    await eventually(async () => (await pendingCount(stream, 'g')) === 0);
    expect(await admin.xlen(`${stream}:dead`)).toBe(0);
  });

  it('re-reads its own pending entries when it starts again under the same name', async () => {
    const stream = newStream();
    const first = start({
      stream,
      group: 'g',
      consumer: 'stable-name',
      startId: '0',
      handler: async () => {
        throw new Error('crash before ack');
      },
    });
    await publish(stream, 3);
    await eventually(async () => (await pendingCount(stream, 'g')) === 3);
    await first.stop();

    const recovered: StreamDelivery[] = [];
    start({
      stream,
      group: 'g',
      consumer: 'stable-name',
      handler: async (entry) => {
        recovered.push(entry);
      },
    });
    await eventually(() => recovered.length === 3);
    expect(recovered.map((entry) => entry.source)).toEqual(['pending', 'pending', 'pending']);
    await eventually(async () => (await pendingCount(stream, 'g')) === 0);
  });

  it('stops within about one block period without acknowledging unread work', async () => {
    const stream = newStream();
    const consumer = start({ stream, group: 'g', consumer: 'c1', blockMs: 300, handler: async () => undefined });
    await eventually(async () => (await admin.exists(stream)) === 1);
    const started = Date.now();
    await consumer.stop();
    expect(Date.now() - started).toBeLessThan(1_500);
    await publish(stream, 2);
    const groups = (await admin.xinfo('GROUPS', stream)) as unknown[][];
    const lag = groups[0]?.[groups[0].indexOf('lag') + 1];
    expect(lag).toBe(2);
  });

  it('trims the stream it publishes to', async () => {
    const stream = newStream();
    const pipeline = admin.pipeline();
    for (let i = 0; i < 1_000; i += 1) pipeline.xadd(stream, '*', 'n', String(i));
    await pipeline.exec();
    await publishToStream(admin, stream, { n: 'last' }, { maxLen: 10 });
    expect(await admin.xlen(stream)).toBeLessThan(1_000);
    await expect(publishToStream(admin, stream, {})).rejects.toThrow(RangeError);
  });
});
