import { partitionsOverview, type PartitionOverviewRow } from '@app/db';
import {
  SYSTEM_WRITES_PER_HOUR,
  adminDeadLetterDeleteSchema,
  adminDeadLetterDeletedSchema,
  adminDeadLetterPageSchema,
  adminDeadLetterParamsSchema,
  adminDeadLetterQuerySchema,
  adminJobGroupResultSchema,
  adminJobGroupSchema,
  adminSystemHealthSchema,
  adminSystemPartitionsSchema,
  adminSystemQueuesSchema,
  adminSystemStreamsSchema,
  adminTaskRunResultSchema,
  adminTaskRunSchema,
  decodeCursor,
  deadLetterReasons,
  encodeCursor,
  latencyMsOf,
  likeKind,
  messageKind,
  wireTime,
  type AdminDeadLetter,
  type AdminSystemHealth,
  type AdminSystemPartitions,
  type AdminTask,
  type StreamName,
} from '@app/shared';
import {
  activeQueueNames,
  isActiveQueue,
  isRetryable,
  isRunnable,
  manualRunId,
  readProcesses,
  runField,
  runRecordSchema,
  runnableTasks,
  streamHealth,
  streamWaiting,
  type ActiveQueueName,
  type JobName,
  type ProcessEntry,
} from '@app/shared/server';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { adminWrite } from '../admin/audit.js';
import { afterCommit } from '../admin/effects.js';
import { takeAdminLimit } from '../admin/limits.js';
import { fieldInvalid } from '../admin/problems.js';
import { HttpProblem } from '../lib/problem.js';
import { OpsQueues, OpsUnavailableError } from '../services/ops.js';

/**
 * The jobs and health page (`system.read`), and its actions (`system.write`
 * and the second factor):
 *
 *   GET  /v1/admin/system/health                          database, Valkey, workers, API processes (≤ 1 statement)
 *   GET  /v1/admin/system/queues                          BullMQ counts, failed groups, scheduled tasks (Valkey only)
 *   GET  /v1/admin/system/streams                         write-behind streams (Valkey only)
 *   GET  /v1/admin/system/streams/:stream/dead-letters    failed entries, newest first (Valkey only)
 *   GET  /v1/admin/system/partitions                      partitions of the registered parents (1 statement)
 *   POST /v1/admin/system/dead-letters/delete             by ids, or every entry up to one
 *   POST /v1/admin/system/jobs/retry                      a failed group whose late run is harmless
 *   POST /v1/admin/system/jobs/remove                     a failed group
 *   POST /v1/admin/system/tasks/run                       a maintenance task, now (once a minute)
 *
 * Every read is Valkey and the catalog; the page polls it while it is open.
 * Every write takes the admin's hourly `system_write` count, writes its
 * audit row (target none) as its only statement, and acts on Valkey after
 * the commit; a write that finds nothing to act on writes nothing. No
 * person, job id, job data or failure message is answered or logged.
 */

const tags = ['admin'];
const noStore = { 'cache-control': 'no-store' } as const;

function unavailable(cause: unknown): HttpProblem {
  return new HttpProblem('service_unavailable', { detail: 'The job queues cannot be read right now.', headers: { 'retry-after': '5' }, cause });
}

async function valkey<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof HttpProblem) throw error;
    throw unavailable(error);
  }
}

/** `INFO memory` as the health card shows it. */
function memoryOf(info: string): { usedBytes: number | null; maxBytes: number | null; policy: string | null } {
  const field = (name: string) => new RegExp(`^${name}:(.*)$`, 'm').exec(info)?.[1]?.trim();
  const used = Number(field('used_memory'));
  const max = Number(field('maxmemory'));
  return {
    usedBytes: Number.isSafeInteger(used) && used >= 0 ? used : null,
    maxBytes: Number.isSafeInteger(max) && max > 0 ? max : null,
    policy: field('maxmemory_policy') ?? null,
  };
}

async function probeValkey(client: Redis): Promise<{ status: 'up' | 'down'; latencyMs: number; usedBytes: number | null; maxBytes: number | null; policy: string | null }> {
  const started = performance.now();
  try {
    if (client.status !== 'ready') throw new Error(`redis is ${client.status}`);
    const [, info] = await Promise.all([client.ping(), client.info('memory')]);
    return { status: 'up', latencyMs: latencyMsOf(performance.now() - started), ...memoryOf(info) };
  } catch {
    return { status: 'down', latencyMs: latencyMsOf(performance.now() - started), usedBytes: null, maxBytes: null, policy: null };
  }
}

/** Entries newer than an "up to" id read to count the ones it deletes (more: the count is left null). */
const UP_TO_NEWER_SCAN = 1_000;

const heartbeatSchema = z.object({ at: z.string(), workerId: z.string().max(128) });
const STREAM_ID = /^([0-9]{1,15})-([0-9]{1,20})$/;

function streamIdMs(id: string | undefined): number | null {
  const match = id === undefined ? null : STREAM_ID.exec(id);
  return match ? Number(match[1]) : null;
}

/** The id after `id` in a stream (`<ms>-<seq + 1>`). */
function nextStreamId(id: string): string {
  const [, ms, seq] = STREAM_ID.exec(id)!;
  return `${ms}-${(BigInt(seq!) + 1n).toString()}`;
}

/** The kind of a failed entry (a message's kind, or a like's), read from its fields; null when they do not say. */
function deadLetterKind(stream: StreamName, fields: string | undefined): AdminDeadLetter['kind'] {
  try {
    const entry = JSON.parse(fields ?? '{}') as Record<string, unknown>;
    const code = Number(stream === 'match' ? entry['s'] : entry['k']);
    const name = stream === 'msg' ? messageKind.nameOrUndefined(code) : likeKind.nameOrUndefined(code);
    return name ?? null;
  } catch {
    return null;
  }
}

/**
 * A failed entry as the page shows it: when it failed and was sent, why, how
 * often it was delivered, and its kind. Its fields (who, to whom, in which
 * conversation) are read for the kind alone and never leave this function.
 */
function deadLetterView(stream: StreamName, id: string, fields: readonly string[]): AdminDeadLetter {
  const raw: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) raw[fields[i]!] = fields[i + 1]!;
  const reason = (deadLetterReasons as readonly string[]).includes(raw['reason'] ?? '') ? (raw['reason'] as AdminDeadLetter['reason']) : 'other';
  const deliveries = Number(raw['deliveries']);
  const kind = deadLetterKind(stream, raw['fields']);
  const entryAtMs = streamIdMs(raw['id']);
  return {
    id,
    stream,
    at: wireTime(streamIdMs(id) ?? 0),
    entryAt: entryAtMs === null ? null : wireTime(entryAtMs),
    reason,
    deliveries: Number.isSafeInteger(deliveries) && deliveries >= 0 ? deliveries : 0,
    kind,
  };
}

function partitionsView(rows: readonly PartitionOverviewRow[], now: number): AdminSystemPartitions['parents'] {
  const parents = new Map<string, PartitionOverviewRow[]>();
  for (const row of rows) parents.set(row.parent, [...(parents.get(row.parent) ?? []), row]);
  return [...parents.entries()].map(([parent, list]) => {
    const ordered = [...list].sort((a, b) => (a.fromMs ?? 0) - (b.fromMs ?? 0));
    const first = ordered[0]!;
    return {
      parent,
      period: first.period,
      premake: first.premake,
      retention: first.retention,
      ahead: ordered.filter((p) => (p.fromMs ?? 0) > now).length,
      current: ordered.some((p) => p.fromMs !== null && p.toMs !== null && p.fromMs <= now && now < p.toMs),
      nextDropAfter: first.dropAfterMs === null ? null : wireTime(first.dropAfterMs),
      rowsEstimate: ordered.reduce((sum, p) => sum + (p.rowsEstimate ?? 0), 0),
      bytesEstimate: ordered.reduce((sum, p) => sum + p.bytesEstimate, 0),
      maxXidAge: ordered.reduce((max, p) => Math.max(max, p.xidAge), 0),
      partitions: ordered.map((p) => ({
        name: p.name,
        from: wireTime(p.fromMs ?? 0),
        to: wireTime(p.toMs ?? 0),
        dropAfter: p.dropAfterMs === null ? null : wireTime(p.dropAfterMs),
        rowsEstimate: p.rowsEstimate,
        bytesEstimate: p.bytesEstimate,
        xidAge: p.xidAge,
      })),
    };
  });
}

function queueOf(name: string): ActiveQueueName {
  if (!isActiveQueue(name)) throw fieldInvalid('/queue', 'unknown_job', `No queue named ${name}.`);
  return name;
}

export interface AdminSystemRoutesOptions {
  /** System writes per admin and hour (tests); otherwise SYSTEM_WRITES_PER_HOUR. */
  writesPerHour?: number | undefined;
}

export const adminSystemRoutes: FastifyPluginAsyncZod<AdminSystemRoutesOptions> = async (app, options) => {
  const read = app.requirePermission('system.read');
  const write = [app.requirePermission('system.write'), app.requireMfa];
  const ops = new OpsQueues({ redis: app.redis, keyPrefix: app.config.redis.keyPrefix });
  app.addHook('onClose', async () => ops.close());
  const writesPerHour = options.writesPerHour ?? SYSTEM_WRITES_PER_HOUR;

  /** The hourly count of system writes; given back when the write found nothing to do. */
  const limit = (request: FastifyRequest) => takeAdminLimit(app, request, 'system_write', writesPerHour);

  app.get(
    '/v1/admin/system/health',
    {
      preHandler: read,
      config: { pgBudget: 1 },
      schema: { tags, summary: 'Database, Valkey, workers and API processes', response: { 200: adminSystemHealthSchema } },
    },
    async (_request, reply) => {
      const now = Date.now();
      const shared = app.cache === app.redis;
      const [readiness, core, cache] = await Promise.all([app.readiness.check(), probeValkey(app.redis), shared ? null : probeValkey(app.cache)]);
      const postgres = readiness.checks['postgres'];
      let heartbeat: AdminSystemHealth['heartbeat'] = null;
      let processes: ProcessEntry[] = [];
      let version: number | null = null;
      if (core.status === 'up') {
        const [beatRaw, versionRaw] = await Promise.all([
          app.redis.get(app.keys.workerHeartbeat()).catch(() => null),
          app.redis.get(app.keys.configVersion()).catch(() => null),
        ]);
        try {
          const beat = beatRaw === null ? null : heartbeatSchema.safeParse(JSON.parse(beatRaw));
          if (beat?.success && Number.isFinite(Date.parse(beat.data.at))) heartbeat = { at: wireTime(Date.parse(beat.data.at)), worker: beat.data.workerId };
        } catch {
          heartbeat = null;
        }
        const parsedVersion = versionRaw === null ? 0 : Number(versionRaw);
        version = Number.isSafeInteger(parsedVersion) && parsedVersion >= 0 ? parsedVersion : null;
        processes = await readProcesses(app.redis, app.keys, now).catch(() => []);
      }
      const self = app.providers.processName;
      const body: AdminSystemHealth = {
        at: wireTime(now),
        database: { status: postgres?.status === 'up' ? 'up' : 'down', latencyMs: postgres?.latencyMs ?? 0 },
        valkey: [
          { name: 'core', sharedWithCore: false, ...core },
          shared ? { name: 'cache', sharedWithCore: true, ...core } : { name: 'cache', sharedWithCore: false, ...cache! },
        ],
        heartbeat,
        workers: processes.flatMap((p) =>
          p.info.kind === 'worker'
            ? [{ name: p.name, at: wireTime(p.atMs), startedAt: wireTime(p.info.startedAtMs), cfgVersion: p.info.cfgVersion, queues: p.info.queues, streams: p.info.streams, maint: p.info.maint }]
            : [],
        ),
        apis: processes.flatMap((p) =>
          p.info.kind === 'api'
            ? [{ name: p.name, at: wireTime(p.atMs), startedAt: wireTime(p.info.startedAtMs), cfgVersion: p.info.cfgVersion, rolesVersion: p.info.rolesVersion, rolesFailing: p.info.rolesFailing, self: p.field === self }]
            : [],
        ),
        config: { version, loaded: app.cfg.peek()?.version ?? null },
      };
      return reply.headers(noStore).send(body);
    },
  );

  app.get(
    '/v1/admin/system/queues',
    {
      preHandler: read,
      config: { pgBudget: 0 },
      schema: { tags, summary: 'Job queues, failed groups and scheduled tasks', response: { 200: adminSystemQueuesSchema } },
    },
    async (_request, reply) => {
      const now = Date.now();
      const [queues, schedulers, runs, oks] = await valkey(() =>
        Promise.all([ops.overview(), ops.schedulers(), app.redis.hgetall(app.keys.opsRuns()), app.redis.hgetall(app.keys.opsRunsOk())]),
      ).catch((error: unknown) => {
        throw error instanceof OpsUnavailableError ? unavailable(error) : error;
      });
      const lastOf = (queue: string, name: string): AdminTask['last'] => {
        const raw = runs[runField(queue, name)];
        if (raw === undefined) return null;
        try {
          const run = runRecordSchema.safeParse(JSON.parse(raw));
          if (!run.success) return null;
          const r = run.data;
          return { at: wireTime(r.atMs), ok: r.ok, durationMs: r.ms, attempt: r.attempt, attempts: r.attempts, willRetry: r.willRetry, error: r.error, manual: r.manual, summary: r.summary };
        } catch {
          return null;
        }
      };
      const okOf = (queue: string, name: string): string | null => {
        const ms = Number(oks[runField(queue, name)]);
        return Number.isSafeInteger(ms) && ms > 0 ? wireTime(ms) : null;
      };
      const tasks = new Map<string, AdminTask>();
      for (const s of schedulers) {
        tasks.set(runField(s.queue, s.name), {
          queue: s.queue,
          name: s.name,
          every: s.every,
          pattern: s.pattern,
          tz: s.tz,
          nextAt: s.nextAtMs === null ? null : wireTime(s.nextAtMs),
          last: lastOf(s.queue, s.name),
          lastOkAt: okOf(s.queue, s.name),
          runnable: isRunnable(s.queue, s.name),
        });
      }
      for (const task of runnableTasks) {
        if (tasks.has(runField(task.queue, task.name))) continue;
        tasks.set(runField(task.queue, task.name), {
          queue: task.queue,
          name: task.name,
          every: null,
          pattern: null,
          tz: null,
          nextAt: null,
          last: lastOf(task.queue, task.name),
          lastOkAt: okOf(task.queue, task.name),
          runnable: true,
        });
      }
      const order = (queue: string) => activeQueueNames.indexOf(queue as ActiveQueueName);
      return reply.headers(noStore).send({
        at: wireTime(now),
        queues: queues.map((q) => ({
          name: q.name,
          paused: q.paused,
          counts: q.counts,
          failed: {
            scanned: q.failed.scanned,
            more: q.failed.more,
            groups: q.failed.groups.map((g) => ({ name: g.name, count: g.count, newestAt: wireTime(g.newestAtMs), oldestAt: wireTime(g.oldestAtMs), retryable: g.retryable })),
          },
        })),
        tasks: [...tasks.values()].sort((a, b) => order(a.queue) - order(b.queue) || a.name.localeCompare(b.name)),
      });
    },
  );

  app.get(
    '/v1/admin/system/streams',
    {
      preHandler: read,
      config: { pgBudget: 0 },
      schema: { tags, summary: 'The write-behind streams', response: { 200: adminSystemStreamsSchema } },
    },
    async (_request, reply) => {
      const now = Date.now();
      if (app.redis.status !== 'ready') throw unavailable(new Error(`redis is ${app.redis.status}`));
      const streams = await valkey(() => streamHealth(app.redis, app.keys, now));
      return reply.headers(noStore).send({
        at: wireTime(now),
        streams: streams.map((s) => ({
          name: s.name,
          length: s.length,
          waiting: streamWaiting(s),
          pending: s.pending,
          dead: s.dead,
          lagMs: s.lagMs,
          group: s.group,
          consumers: s.consumers,
          undelivered: s.undelivered,
          oldestPendingAt: s.oldestPendingAtMs === null ? null : wireTime(s.oldestPendingAtMs),
          lastDeliveredAt: s.lastDeliveredAtMs === null ? null : wireTime(s.lastDeliveredAtMs),
          watermarkLagMs: s.watermarkLagMs,
        })),
      });
    },
  );

  const cursorKey = z.object({ id: z.string().regex(STREAM_ID) });

  app.get(
    '/v1/admin/system/streams/:stream/dead-letters',
    {
      preHandler: read,
      config: { pgBudget: 0 },
      schema: { tags, summary: 'Failed entries of a write-behind stream, newest first', params: adminDeadLetterParamsSchema, querystring: adminDeadLetterQuerySchema, response: { 200: adminDeadLetterPageSchema } },
    },
    async (request, reply) => {
      const { stream } = request.params;
      const { cursor, limit } = request.query;
      let start = '+';
      if (cursor !== undefined) {
        const key = decodeCursor(cursorKey, cursor);
        if (key === null) {
          throw new HttpProblem('validation_failed', { detail: 'The cursor is not valid.', errors: [{ in: 'query', pointer: '/cursor', code: 'invalid', message: 'not a cursor of this list' }] });
        }
        start = `(${key.id}`;
      }
      if (app.redis.status !== 'ready') throw unavailable(new Error(`redis is ${app.redis.status}`));
      const entries = await valkey(() => app.redis.xrevrange(app.keys.streamDead(stream), start, '-', 'COUNT', limit + 1));
      const page = entries.slice(0, limit);
      const last = page.at(-1);
      return reply.headers(noStore).send({
        items: page.map(([id, fields]) => deadLetterView(stream, id, fields)),
        nextCursor: entries.length > limit && last ? encodeCursor({ id: last[0] }) : null,
      });
    },
  );

  app.get(
    '/v1/admin/system/partitions',
    {
      preHandler: read,
      config: { pgBudget: 1 },
      schema: { tags, summary: 'The partitions of the registered tables (catalog estimates)', response: { 200: adminSystemPartitionsSchema } },
    },
    async (_request, reply) => {
      const now = Date.now();
      const rows = await partitionsOverview(app.pg);
      return reply.headers(noStore).send({ at: wireTime(now), parents: partitionsView(rows, now) });
    },
  );

  app.post(
    '/v1/admin/system/dead-letters/delete',
    {
      preHandler: write,
      config: { pgBudget: 1 },
      schema: { tags, summary: 'Delete failed entries of a write-behind stream (by ids, or every one up to an id)', body: adminDeadLetterDeleteSchema, response: { 200: adminDeadLetterDeletedSchema } },
    },
    async (request) => {
      const body = request.body;
      const dead = app.keys.streamDead(body.stream);
      const ticket = await limit(request);
      let ids: string[] = [];
      let lengthBefore = 0;
      let count: number | null = null;
      if ('ids' in body) {
        const unique = [...new Set(body.ids)];
        const pipeline = app.redis.pipeline();
        for (const id of unique) pipeline.xrange(dead, id, id);
        const replies = await valkey(async () => (await pipeline.exec()) ?? []);
        ids = unique.filter((_, i) => {
          const [error, found] = replies[i] ?? [new Error('no answer'), null];
          return error === null && Array.isArray(found) && found.length > 0;
        });
      } else {
        // One MULTI, so the three answers describe the same moment: whether anything is at or before upTo, the
        // length, and the entries after upTo (normally none: the panel sends the newest entry it shows).
        const replies = await valkey(async () => {
          const answers = (await app.redis.multi().xrange(dead, '-', body.upTo, 'COUNT', 1).xlen(dead).xrange(dead, nextStreamId(body.upTo), '+', 'COUNT', UP_TO_NEWER_SCAN + 1).exec()) ?? [];
          const failed = answers.find(([error]) => error !== null);
          if (answers.length !== 3 || failed) throw failed?.[0] ?? new Error('no answer');
          return answers.map(([, value]) => value);
        });
        const [first, length, newer] = replies as [unknown[], number, unknown[]];
        if (first.length > 0) {
          lengthBefore = length;
          // How many entries the delete names: exact unless more than the scan are newer than upTo.
          count = newer.length <= UP_TO_NEWER_SCAN ? Math.max(0, length - newer.length) : null;
        }
      }
      const nothing = 'ids' in body ? ids.length === 0 : lengthBefore === 0;
      await adminWrite(app, request, async (_tx, trail) => {
        if (nothing) return trail.unchanged();
        trail.record({
          action: 'system.dead_letters_delete',
          target: 'none',
          detail: 'ids' in body ? { stream: body.stream, ids } : { stream: body.stream, upTo: body.upTo, lengthBefore, count },
        });
      });
      if (nothing) {
        await ticket.refund();
        return { deleted: 0, sideEffects: 'done' as const };
      }
      let deleted = 0;
      const sideEffects = await afterCommit(request, 'dead letters deleted', async () => {
        // Both answer how many entries they removed (entries failing meanwhile are newer than upTo and stay).
        deleted = 'ids' in body ? await app.redis.xdel(dead, ...ids) : await app.redis.xtrim(dead, 'MINID', nextStreamId(body.upTo));
      });
      request.log.info({ stream: body.stream, deleted }, 'system: failed stream entries deleted');
      return { deleted, sideEffects };
    },
  );

  /** A failed group's ids, the audit row, then the action after the commit. */
  async function actOnGroup(request: FastifyRequest, body: { queue: string; name: string; max?: number | undefined }, kind: 'retry' | 'remove') {
    const queue = queueOf(body.queue);
    if (kind === 'retry' && !isRetryable(queue, body.name)) {
      throw fieldInvalid('/name', 'not_retryable', `Failed ${queue}/${body.name} jobs are not run again.`);
    }
    const ticket = await limit(request);
    const { ids, more } = await ops.matchingFailed(queue, body.name, body.max).catch((error: unknown) => {
      throw unavailable(error);
    });
    await adminWrite(app, request, async (_tx, trail) => {
      if (ids.length === 0) return trail.unchanged();
      trail.record({ action: kind === 'retry' ? 'system.jobs_retry' : 'system.jobs_remove', target: 'none', detail: { queue, name: body.name, count: ids.length, more } });
    });
    if (ids.length === 0) {
      await ticket.refund();
      return { matched: 0, done: 0, more: false, sideEffects: 'done' as const };
    }
    let done = 0;
    const sideEffects = await afterCommit(request, kind === 'retry' ? 'failed jobs retried' : 'failed jobs removed', async () => {
      done = kind === 'retry' ? await ops.retry(queue, ids) : await ops.remove(queue, ids);
    });
    request.log.info({ queue, job: body.name, matched: ids.length, done, more }, kind === 'retry' ? 'system: failed jobs retried' : 'system: failed jobs removed');
    return { matched: ids.length, done, more, sideEffects };
  }

  app.post(
    '/v1/admin/system/jobs/retry',
    {
      preHandler: write,
      config: { pgBudget: 1 },
      schema: { tags, summary: 'Run failed jobs of one name again (attempts reset), where a late run is harmless', body: adminJobGroupSchema, response: { 200: adminJobGroupResultSchema } },
    },
    async (request) => actOnGroup(request, request.body, 'retry'),
  );

  app.post(
    '/v1/admin/system/jobs/remove',
    {
      preHandler: write,
      config: { pgBudget: 1 },
      schema: { tags, summary: 'Remove failed jobs of one name', body: adminJobGroupSchema, response: { 200: adminJobGroupResultSchema } },
    },
    async (request) => actOnGroup(request, request.body, 'remove'),
  );

  app.post(
    '/v1/admin/system/tasks/run',
    {
      preHandler: write,
      config: { pgBudget: 1 },
      schema: { tags, summary: 'Start a maintenance task now (once a minute at most)', body: adminTaskRunSchema, response: { 200: adminTaskRunResultSchema } },
    },
    async (request) => {
      const queue = queueOf(request.body.queue);
      const name = request.body.name;
      if (!isRunnable(queue, name)) throw fieldInvalid('/name', 'not_runnable', `${queue}/${name} is not started by hand.`);
      const ticket = await limit(request);
      const id = manualRunId(name, Date.now());
      // This minute's run is kept for a while after it ends, and adding its id again adds nothing: so nothing is written either.
      const already = await ops.jobExists(queue, id).catch((error: unknown) => {
        throw unavailable(error);
      });
      await adminWrite(app, request, async (_tx, trail) => {
        if (already) return trail.unchanged();
        trail.record({ action: 'system.task_run', target: 'none', detail: { queue, name, jobId: id } });
      });
      if (already) {
        await ticket.refund();
        return { queued: false, already: true, jobId: id, sideEffects: 'done' as const };
      }
      const sideEffects = await afterCommit(request, 'task queued', () => app.jobs.add(queue, name as JobName<typeof queue>, id, {}));
      request.log.info({ queue, task: name, jobId: id, sideEffects }, 'system: task started by hand');
      return { queued: sideEffects === 'done', already: false, jobId: id, sideEffects };
    },
  );
};

