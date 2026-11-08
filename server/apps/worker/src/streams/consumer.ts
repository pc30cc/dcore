import { setTimeout as sleep } from 'node:timers/promises';
import type { Redis } from 'ioredis';

/**
 * A Redis Streams consumer-group reader with at-least-once delivery.
 *
 * - Reads new entries with XREADGROUP (COUNT = batch size, BLOCK = block time),
 *   so an idle consumer costs one blocked command per block period.
 * - Runs the handler for each entry and XACKs, in one command per batch, only
 *   the entries whose handler resolved. A rejected entry stays pending.
 * - Every `claimIntervalMs` it takes over entries that have been pending
 *   longer than `claimIdleMs` (their consumer crashed, or their handler
 *   failed) with XAUTOCLAIM, and runs them again.
 * - An entry delivered `maxDeliveries` times is copied to a dead-letter stream
 *   and acknowledged instead of being retried forever (0: never; past
 *   `alertDeliveries` each delivery is logged as an error instead).
 * - A handler failure is sorted by `classify`: `rejected` (the entry can
 *   never be handled: malformed, or refused by the database for its data)
 *   goes to the dead-letter stream at once; `unavailable` (the database is
 *   down) stops reading and claiming until `probe` succeeds, so an outage
 *   neither burns deliveries nor dead-letters anything; `failed` stays
 *   pending and is claimed again.
 * - On start it first re-reads its own pending entries (ID 0), which a
 *   previous run of the same consumer name left unacknowledged, and again
 *   after an outage.
 *
 * Handlers must be idempotent: a crash between the handler and the XACK
 * delivers the entry again.
 *
 * The blocking read holds its connection, so give each consumer a Redis
 * connection of its own (`redis.duplicate()`).
 */

export interface StreamEntry {
  id: string;
  fields: Record<string, string>;
}

export type EntrySource = 'pending' | 'new' | 'claimed';

export interface StreamDelivery extends StreamEntry {
  source: EntrySource;
}

export interface ConsumerLog {
  warn(data: Record<string, unknown>, message: string): void;
  error(data: Record<string, unknown>, message: string): void;
}

/**
 * What a handler's failure means: `unavailable` (the database cannot take
 * work: wait for it, give nothing up), `rejected` (this entry can never be
 * handled: dead-letter it now) or `failed` (anything else: retry later).
 */
export type ErrorKind = 'unavailable' | 'rejected' | 'failed';

/** Thrown out of a batch when the database is unavailable: the consumer's loop waits for it. */
export class UnavailableError extends Error {
  constructor(cause: unknown) {
    super('the database is unavailable', { cause });
    this.name = 'UnavailableError';
  }
}

/** An entry's fields as a dead letter keeps them: those named in `redact` (free text) are left out. */
export function deadLetterFields(fields: Readonly<Record<string, string>>, redact: readonly string[]): string {
  if (redact.length === 0) return JSON.stringify(fields);
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(fields)) kept[name] = redact.includes(name) && value !== '' ? '[redacted]' : value;
  return JSON.stringify(kept);
}

/**
 * Waits until `probe` resolves (the database answers), with a backoff from
 * 200 ms to 5 s; without a probe, one backoff step. Returns early when the
 * consumer stops.
 */
export async function waitUntilAvailable(options: {
  probe?: (() => Promise<unknown>) | undefined;
  isRunning: () => boolean;
  log: ConsumerLog;
  stream: string;
}): Promise<void> {
  let attempt = 0;
  while (options.isRunning()) {
    await sleep(Math.min(5_000, 200 * 2 ** Math.min(attempt, 5)));
    attempt += 1;
    if (!options.probe) return;
    try {
      await options.probe();
      options.log.warn({ stream: options.stream, probes: attempt }, 'database available again; the stream resumes');
      return;
    } catch (error) {
      if (attempt === 1 || attempt % 10 === 0) options.log.error({ err: error, stream: options.stream, probes: attempt }, 'database still unavailable');
    }
  }
}

export interface StreamConsumerOptions {
  /** A dedicated connection: the blocking read occupies it. */
  redis: Redis;
  stream: string;
  group: string;
  /** Unique per process and stable across restarts of it (e.g. `<host>-<slot>`). */
  consumer: string;
  handler: (entry: StreamDelivery) => Promise<void>;
  /** Entries per XREADGROUP / XAUTOCLAIM call. */
  batchSize?: number | undefined;
  /** How long one XREADGROUP waits for new entries; also bounds how long stop() takes. */
  blockMs?: number | undefined;
  /** An entry pending this long is considered abandoned and is claimed. */
  claimIdleMs?: number | undefined;
  /** How often to look for abandoned entries. */
  claimIntervalMs?: number | undefined;
  /** Deliveries after which an entry goes to the dead-letter stream; 0 never gives up. */
  maxDeliveries?: number | undefined;
  /** Defaults to `<stream>:dead`. */
  deadLetterStream?: string | undefined;
  /** What a handler failure means (default: every failure is `failed`). */
  classify?: ((error: unknown) => ErrorKind) | undefined;
  /** Resolves once the database answers again (after an `unavailable` failure); unset: the backoff alone. */
  probe?: (() => Promise<unknown>) | undefined;
  /** An entry delivered more often than this is logged as an error on each delivery (default: maxDeliveries, or 10). */
  alertDeliveries?: number | undefined;
  /** Fields left out of dead letters (free text a dead letter must not keep). */
  redactFields?: readonly string[] | undefined;
  /** Where a new group starts reading: `$` (only new entries, the default) or `0` (everything). */
  startId?: '$' | '0' | undefined;
  /** Handlers run at once within a batch; 1 keeps the stream's order. */
  concurrency?: number | undefined;
  log?: ConsumerLog | undefined;
  /** Called after every batch, for metrics and tests. */
  onBatch?: ((info: { source: EntrySource; size: number; acked: number; deadLettered: number }) => void) | undefined;
}

export interface StreamConsumer {
  /** Resolves when the consumer has stopped (after stop(), or a fatal error, which it rethrows). */
  readonly done: Promise<void>;
  /** Finishes the batch in progress, then stops; at most one block period later. */
  stop(): Promise<void>;
}

type RawEntry = [id: string, fields: string[]];

function toEntry([id, flat]: RawEntry): StreamEntry {
  const fields: Record<string, string> = {};
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const name = flat[i];
    const value = flat[i + 1];
    if (name !== undefined && value !== undefined) fields[name] = value;
  }
  return { id, fields };
}

function isBusyGroup(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('BUSYGROUP');
}

function isNoGroup(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('NOGROUP');
}

const silent: ConsumerLog = { warn: () => undefined, error: () => undefined };

/** Dead-letter streams keep about this many entries (`MAXLEN ~`); they alert when they grow. */
export const DEAD_LETTER_MAXLEN = 100_000;

/** Creates the group (and the stream) if needed. */
export async function ensureGroup(redis: Redis, stream: string, group: string, startId: '$' | '0' = '$'): Promise<void> {
  try {
    await redis.xgroup('CREATE', stream, group, startId, 'MKSTREAM');
  } catch (error) {
    if (!isBusyGroup(error)) throw error;
  }
}

async function runLimited<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next] as T;
      next += 1;
      await run(item);
    }
  });
  await Promise.all(lanes);
}

export function startStreamConsumer(options: StreamConsumerOptions): StreamConsumer {
  const {
    redis,
    stream,
    group,
    consumer,
    handler,
    batchSize = 50,
    blockMs = 5_000,
    claimIdleMs = 60_000,
    claimIntervalMs = Math.max(1_000, Math.floor(claimIdleMs / 2)),
    maxDeliveries = 10,
    deadLetterStream = `${stream}:dead`,
    classify = () => 'failed' as const,
    probe,
    alertDeliveries = maxDeliveries > 0 ? maxDeliveries : 10,
    redactFields = [],
    startId = '$',
    concurrency = 1,
    log = silent,
    onBatch,
  } = options;
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new RangeError('batchSize must be a positive integer');
  if (!Number.isInteger(blockMs) || blockMs < 1) throw new RangeError('blockMs must be a positive integer');
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError('concurrency must be a positive integer');

  let running = true;
  let claimCursor = '0-0';
  let nextClaimAt = 0;

  /** Delivery counts of the given entries, from the pending list, in one round trip. */
  async function deliveryCounts(entries: readonly StreamEntry[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (entries.length === 0) return counts;
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
      deadLetterFields(entry.fields, redactFields),
    );
  }

  async function processBatch(entries: StreamEntry[], source: EntrySource): Promise<void> {
    if (entries.length === 0) return;
    const counts = source === 'new' ? new Map<string, number>() : await deliveryCounts(entries);
    const acked: string[] = [];
    let deadLettered = 0;
    let unavailable: unknown = null;
    await runLimited(entries, concurrency, async (entry) => {
      const deliveries = counts.get(entry.id) ?? 1;
      if (maxDeliveries > 0 && deliveries > maxDeliveries) {
        await deadLetter(entry, deliveries - 1, 'deliveries');
        acked.push(entry.id);
        deadLettered += 1;
        log.warn({ stream, group, id: entry.id, deliveries: deliveries - 1 }, 'stream entry moved to the dead-letter stream');
        return;
      }
      if (deliveries > alertDeliveries) log.error({ stream, group, id: entry.id, deliveries }, 'stream entry still not handled after many deliveries');
      // The database went away during this batch: the rest waits for it untried.
      if (unavailable !== null) return;
      try {
        await handler({ ...entry, source });
        acked.push(entry.id);
      } catch (error) {
        const kind = classify(error);
        if (kind === 'unavailable') {
          unavailable ??= error;
          return;
        }
        if (kind === 'rejected') {
          await deadLetter(entry, deliveries, 'rejected');
          acked.push(entry.id);
          deadLettered += 1;
          log.error({ err: error, stream, group, id: entry.id, source }, 'stream entry cannot be handled; moved to the dead-letter stream');
          return;
        }
        // Left pending: claimed again after claimIdleMs.
        log.error({ err: error, stream, group, id: entry.id, source }, 'stream handler failed');
      }
    });
    if (acked.length > 0) await redis.xack(stream, group, ...acked);
    onBatch?.({ source, size: entries.length, acked: acked.length, deadLettered });
    if (unavailable !== null) throw new UnavailableError(unavailable);
  }

  async function readOwnPending(): Promise<void> {
    // Entries delivered to this consumer name before a restart; ID 0 re-reads them.
    let after = '0';
    while (running) {
      const reply: [string, [string, string[] | null][]][] | null = await redis.xreadgroup(
        'GROUP',
        group,
        consumer,
        'COUNT',
        batchSize,
        'STREAMS',
        stream,
        after,
      );
      const raw = reply?.[0]?.[1] ?? [];
      if (raw.length === 0) return;
      // An entry deleted from the stream while pending comes back without fields: drop it.
      const deleted = raw.filter(([, fields]) => fields === null).map(([id]) => id);
      if (deleted.length > 0) await redis.xack(stream, group, ...deleted);
      await processBatch(
        raw.filter((entry): entry is RawEntry => entry[1] !== null).map(toEntry),
        'pending',
      );
      after = raw.at(-1)?.[0] ?? after;
    }
  }

  async function claimAbandoned(): Promise<void> {
    // One pass over the pending list, a batch at a time.
    do {
      const reply = (await redis.xautoclaim(stream, group, consumer, claimIdleMs, claimCursor, 'COUNT', batchSize)) as [
        string,
        (RawEntry | null)[],
        string[]?,
      ];
      claimCursor = reply[0];
      const entries = reply[1].filter((raw): raw is RawEntry => raw !== null && raw[1] !== null).map(toEntry);
      await processBatch(entries, 'claimed');
    } while (running && claimCursor !== '0-0');
  }

  async function readNew(): Promise<void> {
    const reply = (await redis.xreadgroup(
      'GROUP',
      group,
      consumer,
      'COUNT',
      batchSize,
      'BLOCK',
      blockMs,
      'STREAMS',
      stream,
      '>',
    )) as [string, RawEntry[]][] | null;
    await processBatch((reply?.[0]?.[1] ?? []).map(toEntry), 'new');
  }

  async function loop(): Promise<void> {
    await ensureGroup(redis, stream, group, startId);
    // Own pending entries first (a restart), and again after every outage.
    let ownPending = true;
    let failures = 0;
    while (running) {
      try {
        if (ownPending) {
          await readOwnPending();
          ownPending = false;
        }
        if (Date.now() >= nextClaimAt) {
          await claimAbandoned();
          nextClaimAt = Date.now() + claimIntervalMs;
        }
        await readNew();
        failures = 0;
      } catch (error) {
        if (!running) return;
        if (error instanceof UnavailableError) {
          // No reads and no claims until the database answers: nothing is delivered (or counted) in vain.
          log.error({ err: error.cause, stream, group }, 'database unavailable; the stream waits for it');
          await waitUntilAvailable({ probe, isRunning: () => running, log, stream });
          ownPending = true;
          continue;
        }
        if (isNoGroup(error)) {
          // The stream or group was deleted under us: recreate and carry on.
          log.warn({ stream, group }, 'consumer group missing; recreating it');
          await ensureGroup(redis, stream, group, startId).catch(() => undefined);
          continue;
        }
        failures += 1;
        const delay = Math.min(5_000, 100 * 2 ** Math.min(failures, 6));
        log.error({ err: error, stream, group, retryInMs: delay }, 'stream read failed');
        await sleep(delay);
      }
    }
  }

  const done = loop();
  // Surface a fatal start-up error to whoever awaits `done` or `stop()`, not as an unhandled rejection.
  done.catch(() => undefined);

  return {
    done,
    async stop() {
      running = false;
      await done;
    },
  };
}

export interface PublishOptions {
  /** Trims the stream to about this many entries (MAXLEN ~), so it cannot grow without bound. */
  maxLen?: number | undefined;
}

/** Appends an entry; returns its id. */
export async function publishToStream(
  redis: Redis,
  stream: string,
  fields: Readonly<Record<string, string>>,
  { maxLen = 100_000 }: PublishOptions = {},
): Promise<string> {
  const flat = Object.entries(fields).flat();
  if (flat.length === 0) throw new RangeError('a stream entry needs at least one field');
  const id = await redis.xadd(stream, 'MAXLEN', '~', String(maxLen), '*', ...flat);
  if (id === null) throw new Error(`XADD to ${stream} returned no id`);
  return id;
}
