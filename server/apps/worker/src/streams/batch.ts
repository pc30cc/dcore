import { setTimeout as sleep } from 'node:timers/promises';
import { idFloor } from '@app/shared';
import type { Redis } from 'ioredis';
import { DEAD_LETTER_MAXLEN, ensureGroup, type ConsumerLog, type EntrySource, type StreamDelivery, type StreamEntry } from './consumer.js';

/**
 * The batch mode of the stream consumer, for the write-behind streams
 * (`wb:like`, later `wb:msg`): many entries, one statement.
 *
 * - Reads up to `batchSize` (500) entries; when fewer came, it lingers until
 *   the first of them is `lingerMs` (250 ms) old and reads again, so low
 *   traffic still costs at most about four statements a second per stream
 *   and consumer, and high traffic fills whole batches.
 * - Hands the whole batch to the handler (one multi-row INSERT ... ON
 *   CONFLICT DO NOTHING), then acknowledges it with one XACK. A batch that
 *   fails is retried row by row once, to isolate the entry that cannot be
 *   written; that entry stays pending, is claimed again (XAUTOCLAIM) after
 *   `claimIdleMs`, and goes to the dead-letter stream (`MAXLEN ~ 100000`)
 *   after `maxDeliveries`. The handler may also name entries it can never
 *   write (malformed): those go to the dead letters at once.
 * - After each acknowledgement it trims the stream with `XTRIM MINID m`, m =
 *   min(the oldest pending id, the group's last-delivered id + 1); never by
 *   length (an outage would drop unwritten entries), and not at all when
 *   either value cannot be read.
 * - It keeps the stream's flush watermark: every app id below it is durable.
 *   It is `id_floor(t - marginMs)`, t the time of the oldest entry not yet
 *   written (pending, or delivered next), or Valkey's clock when there is
 *   none; the margin covers an id minted a moment before its XADD.
 *
 * The group is created reading from the start of the stream (`0`), so
 * entries appended before the group existed (after a Valkey loss, the API
 * appends before the worker recreates the group) are written too.
 */

export interface BatchResult {
  /** Entries that can never be written (malformed): dead-lettered now. */
  poison?: readonly string[] | undefined;
}

export interface BatchConsumerOptions {
  /** A dedicated connection: the blocking read occupies it. */
  redis: Redis;
  stream: string;
  group: string;
  consumer: string;
  handler: (entries: readonly StreamDelivery[]) => Promise<BatchResult | void>;
  batchSize?: number | undefined;
  lingerMs?: number | undefined;
  blockMs?: number | undefined;
  claimIdleMs?: number | undefined;
  claimIntervalMs?: number | undefined;
  maxDeliveries?: number | undefined;
  deadLetterStream?: string | undefined;
  /** The flush watermark key (`wb:<name>:wm`); unset: none is kept. */
  watermarkKey?: string | undefined;
  watermarkMarginMs?: number | undefined;
  log?: ConsumerLog | undefined;
  onBatch?: ((info: BatchInfo) => void) | undefined;
}

export interface BatchInfo {
  source: EntrySource;
  size: number;
  acked: number;
  deadLettered: number;
  /** The batch failed as a whole and was retried row by row. */
  split: boolean;
}

export interface BatchConsumer {
  readonly done: Promise<void>;
  stop(): Promise<void>;
}

type RawEntry = [id: string, fields: string[] | null];

function toEntry([id, flat]: [string, string[]]): StreamEntry {
  const fields: Record<string, string> = {};
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const name = flat[i];
    const value = flat[i + 1];
    if (name !== undefined && value !== undefined) fields[name] = value;
  }
  return { id, fields };
}

/** The milliseconds part of a stream id. */
export function streamIdMs(id: string): number {
  return Number(id.split('-', 1)[0]);
}

/** The stream id right after `id`. */
export function nextStreamId(id: string): string {
  const [ms, seq] = id.split('-');
  return `${ms}-${BigInt(seq ?? '0') + 1n}`;
}

function olderId(a: string, b: string): string {
  const [am, as] = a.split('-').map((x) => BigInt(x));
  const [bm, bs] = b.split('-').map((x) => BigInt(x));
  if (am! !== bm!) return am! < bm! ? a : b;
  return (as ?? 0n) <= (bs ?? 0n) ? a : b;
}

const silent: ConsumerLog = { warn: () => undefined, error: () => undefined };

export interface StreamPosition {
  /** Entries delivered and not acknowledged. */
  pending: number;
  oldestPending: string | null;
  /** The group's last-delivered id. */
  lastDelivered: string;
  /** The newest id in the stream (null: empty). */
  lastEntry: string | null;
}

/** Where the group stands in the stream, or null when it cannot be read. */
export async function streamPosition(redis: Redis, stream: string, group: string): Promise<StreamPosition | null> {
  try {
    const [summary, groups, last] = await Promise.all([
      redis.xpending(stream, group) as Promise<[number, string | null, string | null, unknown]>,
      redis.xinfo('GROUPS', stream) as Promise<unknown[][]>,
      redis.xrevrange(stream, '+', '-', 'COUNT', 1),
    ]);
    let lastDelivered: string | null = null;
    for (const info of groups) {
      const fields = new Map<string, unknown>();
      for (let i = 0; i + 1 < info.length; i += 2) fields.set(String(info[i]), info[i + 1]);
      if (fields.get('name') === group) lastDelivered = String(fields.get('last-delivered-id'));
    }
    if (lastDelivered === null) return null;
    return {
      pending: Number(summary[0]),
      oldestPending: summary[0] > 0 ? summary[1] : null,
      lastDelivered,
      lastEntry: last[0]?.[0] ?? null,
    };
  } catch {
    return null;
  }
}

/** The MINID below which every entry is written and acknowledged (null: do not trim). */
export function trimPoint(position: StreamPosition | null): string | null {
  if (!position) return null;
  const next = nextStreamId(position.lastDelivered);
  return position.oldestPending ? olderId(position.oldestPending, next) : next;
}

/** The time (ms) of the oldest entry not yet written; null when everything delivered is written. */
export function unwrittenSince(position: StreamPosition): number | null {
  if (position.oldestPending) return streamIdMs(position.oldestPending);
  if (position.lastEntry && olderId(position.lastDelivered, position.lastEntry) === position.lastDelivered && position.lastEntry !== position.lastDelivered) {
    return streamIdMs(nextStreamId(position.lastDelivered));
  }
  return null;
}

export function startBatchConsumer(options: BatchConsumerOptions): BatchConsumer {
  const {
    redis,
    stream,
    group,
    consumer,
    handler,
    batchSize = 500,
    lingerMs = 250,
    blockMs = 1_000,
    claimIdleMs = 60_000,
    claimIntervalMs = Math.max(1_000, Math.floor(claimIdleMs / 2)),
    maxDeliveries = 10,
    deadLetterStream = `${stream}:dead`,
    watermarkKey,
    watermarkMarginMs = 5_000,
    log = silent,
    onBatch,
  } = options;
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new RangeError('batchSize must be a positive integer');
  if (!Number.isInteger(lingerMs) || lingerMs < 0) throw new RangeError('lingerMs must be a non-negative integer');

  let running = true;
  let claimCursor = '0-0';
  let nextClaimAt = 0;

  async function deliveryCounts(entries: readonly StreamEntry[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (entries.length === 0 || maxDeliveries <= 0) return counts;
    const pipeline = redis.pipeline();
    for (const entry of entries) pipeline.xpending(stream, group, entry.id, entry.id, 1);
    const replies = (await pipeline.exec()) ?? [];
    replies.forEach(([error, rows]) => {
      if (error) throw error;
      const row = (rows as [string, string, number, number][])[0];
      if (row) counts.set(row[0], row[3]);
    });
    return counts;
  }

  async function deadLetter(entry: StreamEntry, deliveries: number, reason: string): Promise<void> {
    await redis.xadd(
      deadLetterStream,
      'MAXLEN',
      '~',
      String(DEAD_LETTER_MAXLEN),
      '*',
      'stream',
      stream,
      'group',
      group,
      'id',
      entry.id,
      'deliveries',
      String(deliveries),
      'reason',
      reason,
      'fields',
      JSON.stringify(entry.fields),
    );
  }

  async function afterAck(): Promise<void> {
    const position = await streamPosition(redis, stream, group);
    const minId = trimPoint(position);
    if (minId) await redis.xtrim(stream, 'MINID', minId).catch((error: unknown) => log.warn({ err: error, stream }, 'stream trim failed'));
    if (watermarkKey && position) {
      let since = unwrittenSince(position);
      if (since === null) {
        const [seconds, micros] = await redis.time();
        since = Number(seconds) * 1_000 + Math.floor(Number(micros) / 1_000);
      }
      const watermark = idFloor(Math.max(0, since - watermarkMarginMs));
      await redis.set(watermarkKey, watermark.toString()).catch((error: unknown) => log.warn({ err: error, stream }, 'watermark not written'));
    }
  }

  async function processBatch(entries: StreamEntry[], source: EntrySource): Promise<void> {
    if (entries.length === 0) return;
    const counts = source === 'new' ? new Map<string, number>() : await deliveryCounts(entries);
    const acked: string[] = [];
    let deadLettered = 0;
    const live: StreamDelivery[] = [];
    for (const entry of entries) {
      const deliveries = counts.get(entry.id) ?? 1;
      if (maxDeliveries > 0 && deliveries > maxDeliveries) {
        await deadLetter(entry, deliveries - 1, 'deliveries');
        acked.push(entry.id);
        deadLettered += 1;
        log.warn({ stream, group, id: entry.id, deliveries: deliveries - 1 }, 'stream entry moved to the dead-letter stream');
      } else {
        live.push({ ...entry, source });
      }
    }
    let split = false;
    const settle = async (batch: readonly StreamDelivery[]): Promise<void> => {
      const result = (await handler(batch)) ?? {};
      const poison = new Set(result.poison ?? []);
      for (const entry of batch) {
        if (poison.has(entry.id)) {
          await deadLetter(entry, counts.get(entry.id) ?? 1, 'malformed');
          deadLettered += 1;
          log.error({ stream, group, id: entry.id }, 'stream entry cannot be written; moved to the dead-letter stream');
        }
        acked.push(entry.id);
      }
    };
    if (live.length > 0) {
      try {
        await settle(live);
      } catch (error) {
        log.error({ err: error, stream, group, size: live.length, source }, 'stream batch failed; retrying it entry by entry');
        if (live.length > 1) {
          split = true;
          for (const entry of live) {
            try {
              await settle([entry]);
            } catch (rowError) {
              // Left pending: claimed again after claimIdleMs, dead-lettered after maxDeliveries.
              log.error({ err: rowError, stream, group, id: entry.id }, 'stream entry failed');
            }
          }
        }
      }
    }
    if (acked.length > 0) {
      await redis.xack(stream, group, ...acked);
      await afterAck();
    }
    onBatch?.({ source, size: entries.length, acked: acked.length, deadLettered, split });
  }

  async function read(count: number, block: number | null, from: string): Promise<{ entries: StreamEntry[]; deleted: string[] }> {
    const args: (string | number)[] = ['GROUP', group, consumer, 'COUNT', count];
    if (block !== null) args.push('BLOCK', block);
    args.push('STREAMS', stream, from);
    const reply = (await (redis as unknown as { xreadgroup(...a: (string | number)[]): Promise<unknown> }).xreadgroup(...args)) as [string, RawEntry[]][] | null;
    const raw = reply?.[0]?.[1] ?? [];
    return {
      // An entry deleted from the stream while pending comes back without fields.
      entries: raw.filter((e): e is [string, string[]] => e[1] !== null).map(toEntry),
      deleted: raw.filter((e) => e[1] === null).map(([id]) => id),
    };
  }

  async function readOwnPending(): Promise<void> {
    let after = '0';
    while (running) {
      const { entries, deleted } = await read(batchSize, null, after);
      if (deleted.length > 0) await redis.xack(stream, group, ...deleted);
      if (entries.length === 0 && deleted.length === 0) return;
      await processBatch(entries, 'pending');
      const last = [...entries.map((e) => e.id), ...deleted].sort((a, b) => (olderId(a, b) === a ? -1 : 1)).at(-1);
      if (!last) return;
      after = last;
    }
  }

  async function claimAbandoned(): Promise<void> {
    do {
      const reply = (await redis.xautoclaim(stream, group, consumer, claimIdleMs, claimCursor, 'COUNT', batchSize)) as [string, (RawEntry | null)[], string[]?];
      claimCursor = reply[0];
      const entries = reply[1].filter((raw): raw is [string, string[]] => raw !== null && raw[1] !== null).map(toEntry);
      await processBatch(entries, 'claimed');
    } while (running && claimCursor !== '0-0');
  }

  async function readNew(): Promise<void> {
    const first = await read(batchSize, blockMs, '>');
    const entries = first.entries;
    if (entries.length > 0 && entries.length < batchSize && lingerMs > 0) {
      const age = Date.now() - streamIdMs(entries[0]!.id);
      const wait = Math.min(lingerMs, Math.max(0, lingerMs - age));
      if (wait > 0) await sleep(wait);
      if (running) entries.push(...(await read(batchSize - entries.length, null, '>')).entries);
    }
    if (entries.length > 0) await processBatch(entries, 'new');
    else await afterAck();
  }

  async function loop(): Promise<void> {
    await ensureGroup(redis, stream, group, '0');
    await readOwnPending();
    let failures = 0;
    while (running) {
      try {
        if (Date.now() >= nextClaimAt) {
          await claimAbandoned();
          nextClaimAt = Date.now() + claimIntervalMs;
        }
        await readNew();
        failures = 0;
      } catch (error) {
        if (!running) return;
        if (error instanceof Error && error.message.startsWith('NOGROUP')) {
          // The stream or the group was lost (Valkey emptied): recreate it from the start of the stream.
          log.warn({ stream, group }, 'consumer group missing; recreating it');
          await ensureGroup(redis, stream, group, '0').catch(() => undefined);
          continue;
        }
        failures += 1;
        const delay = Math.min(5_000, 100 * 2 ** Math.min(failures, 6));
        log.error({ err: error, stream, group, retryInMs: delay }, 'stream batch read failed');
        await sleep(delay);
      }
    }
  }

  const done = loop();
  done.catch(() => undefined);
  return {
    done,
    async stop() {
      running = false;
      await done;
    },
  };
}
