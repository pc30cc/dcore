import { expandGrants, type AdminDeadLetter, type AdminQueue, type AdminSystemHealth, type AdminSystemPartitions, type AdminSystemQueues, type AdminSystemStreams, type AdminTask } from '@app/shared';
import type { AdminRole } from '../src/lib/queries';

/** The jobs page's and the roles page's answers, as the API sends them (the time the tests read them: 2026-11-28 10:00 UTC). */

export const NOW = '2026-11-28T10:00:00.000Z';
const GB = 1024 ** 3;

export function health(overrides: Partial<AdminSystemHealth> = {}): AdminSystemHealth {
  return {
    at: NOW,
    database: { status: 'up', latencyMs: 2 },
    valkey: [
      { name: 'core', status: 'up', latencyMs: 1, sharedWithCore: false, usedBytes: 3 * GB, maxBytes: 4 * GB, policy: 'noeviction' },
      { name: 'cache', status: 'up', latencyMs: 1, sharedWithCore: false, usedBytes: GB / 2, maxBytes: 2 * GB, policy: 'allkeys-lru' },
    ],
    heartbeat: { at: '2026-11-28T09:59:40.000Z', worker: 'worker-a' },
    workers: [
      { name: 'worker-a', at: '2026-11-28T09:59:50.000Z', startedAt: '2026-11-27T08:00:00.000Z', cfgVersion: 42, queues: ['system', 'photo', 'maint'], streams: ['like', 'match', 'msg'], maint: true },
      { name: 'worker-b', at: '2026-11-28T09:59:45.000Z', startedAt: '2026-11-27T08:01:00.000Z', cfgVersion: 41, queues: ['photo', 'push'], streams: [], maint: false },
    ],
    apis: [
      { name: 'api-7f9c', at: '2026-11-28T09:59:55.000Z', startedAt: '2026-11-27T08:00:00.000Z', cfgVersion: 42, rolesVersion: 42, rolesFailing: false, self: true },
      { name: 'api-2b31', at: '2026-11-28T09:59:30.000Z', startedAt: '2026-11-26T22:10:00.000Z', cfgVersion: 41, rolesVersion: 41, rolesFailing: true, self: false },
    ],
    config: { version: 42, loaded: 42 },
    ...overrides,
  };
}

export function streams(overrides: Partial<Record<'like' | 'match' | 'msg', Partial<AdminSystemStreams['streams'][number]>>> = {}): AdminSystemStreams {
  const stream = (name: 'like' | 'match' | 'msg', values: Partial<AdminSystemStreams['streams'][number]>): AdminSystemStreams['streams'][number] => {
    const base = {
      name,
      length: 0,
      pending: 0,
      dead: 0,
      lagMs: 0,
      group: true,
      consumers: 1,
      undelivered: 0 as number | null,
      oldestPendingAt: null,
      lastDeliveredAt: null,
      watermarkLagMs: name === 'match' ? null : 0,
      ...values,
      ...overrides[name],
    };
    // As the server counts it, unless a test sets its own.
    const waiting = base.waiting !== undefined ? base.waiting : base.group && base.undelivered !== null ? base.pending + Math.min(base.undelivered, base.length) : null;
    return { ...base, waiting };
  };
  return {
    at: NOW,
    streams: [
      stream('like', { length: 120, pending: 3, lagMs: 1_200, dead: 2 }),
      stream('match', { length: 4 }),
      stream('msg', { length: 900, pending: 40, lagMs: 90_000, watermarkLagMs: 30_000 }),
    ],
  };
}

export function queue(name: string, overrides: Partial<AdminQueue> = {}): AdminQueue {
  return { name, paused: false, counts: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 }, failed: { scanned: 0, more: false, groups: [] }, ...overrides };
}

export function task(queueName: string, name: string, overrides: Partial<AdminTask> = {}): AdminTask {
  return { queue: queueName, name, every: null, pattern: null, tz: null, nextAt: null, last: null, lastOkAt: null, runnable: false, ...overrides };
}

export function queues(overrides: Partial<AdminSystemQueues> = {}): AdminSystemQueues {
  return {
    at: NOW,
    queues: [
      queue('system', { counts: { waiting: 0, active: 0, delayed: 2, failed: 0, completed: 40 } }),
      queue('photo', {
        counts: { waiting: 5, active: 1, delayed: 0, failed: 7, completed: 300 },
        failed: { scanned: 7, more: false, groups: [{ name: 'process', count: 7, newestAt: '2026-11-28T09:40:00.000Z', oldestAt: '2026-11-28T08:00:00.000Z', retryable: true }] },
      }),
      queue('push', {
        counts: { waiting: 0, active: 0, delayed: 0, failed: 250, completed: 9_000 },
        failed: { scanned: 200, more: true, groups: [{ name: 'send', count: 200, newestAt: '2026-11-28T09:55:00.000Z', oldestAt: '2026-11-27T23:00:00.000Z', retryable: false }] },
      }),
      queue('maint', { paused: true }),
    ],
    tasks: [
      task('system', 'heartbeat', { every: 30_000, nextAt: '2026-11-28T10:00:20.000Z', last: run(), lastOkAt: '2026-11-28T09:59:40.000Z' }),
      task('maint', 'partitions', {
        pattern: '17 3 * * *',
        tz: 'UTC',
        nextAt: '2026-11-29T03:17:00.000Z',
        last: run({ ok: false, willRetry: true, attempt: 2, attempts: 8, error: 'DatabaseError:57014', durationMs: 31_000 }),
        lastOkAt: '2026-11-27T03:17:04.000Z',
        runnable: true,
      }),
      task('maint', 'lk-rebuild', { every: 900_000, nextAt: '2026-11-28T10:10:00.000Z', last: run({ manual: true, summary: { leased: false } }), runnable: true }),
      task('maint', 'sessions-cleanup', { pattern: '41 4 * * 0', tz: 'UTC', nextAt: '2026-11-29T04:41:00.000Z', last: run({ summary: { leased: true, deleted: 1_204, chunks: 2 } }), lastOkAt: '2026-11-22T04:41:09.000Z' }),
      // Runnable, but no worker has registered its scheduler yet.
      task('system', 'origins-publish', { runnable: true }),
      task('iap', 'checks', { pattern: '17 * * * *', tz: 'UTC', nextAt: '2026-11-28T10:17:00.000Z' }),
      task('stats', 'rollup', { pattern: '41 0 * * *', tz: 'UTC', nextAt: '2026-11-29T00:41:00.000Z', last: run({ ok: false, willRetry: false, attempt: 3, attempts: 3, error: 'TypeError' }), runnable: true }),
    ],
    ...overrides,
  };
}

export function run(overrides: Partial<NonNullable<AdminTask['last']>> = {}): NonNullable<AdminTask['last']> {
  return { at: '2026-11-28T09:59:40.000Z', ok: true, durationMs: 240, attempt: 1, attempts: 1, willRetry: false, error: null, manual: false, summary: {}, ...overrides };
}

export function partitions(overrides: Partial<AdminSystemPartitions['parents'][number]>[] = []): AdminSystemPartitions {
  const base: AdminSystemPartitions['parents'] = [
    {
      parent: 'messages',
      period: 'month',
      premake: 3,
      retention: { months: 12, days: 0 },
      ahead: 3,
      current: true,
      nextDropAfter: '2027-11-01T00:00:00.000Z',
      rowsEstimate: 1_250_000,
      bytesEstimate: 512 * 1024 ** 2,
      maxXidAge: 1_200_000,
      partitions: [
        { name: 'messages_p20261101', from: '2026-11-01T00:00:00.000Z', to: '2026-12-01T00:00:00.000Z', dropAfter: '2027-12-01T00:00:00.000Z', rowsEstimate: 1_250_000, bytesEstimate: 512 * 1024 ** 2, xidAge: 1_200_000 },
        { name: 'messages_p20261201', from: '2026-12-01T00:00:00.000Z', to: '2027-01-01T00:00:00.000Z', dropAfter: null, rowsEstimate: 0, bytesEstimate: 8192, xidAge: 30 },
      ],
    },
    {
      parent: 'likes',
      period: 'week',
      premake: 4,
      retention: { months: 0, days: 37 },
      ahead: 2,
      current: true,
      nextDropAfter: '2026-12-08T00:00:00.000Z',
      rowsEstimate: 40_000,
      bytesEstimate: 12 * 1024 ** 2,
      maxXidAge: 160_000_000,
      partitions: [],
    },
    {
      parent: 'audit_log',
      period: 'month',
      premake: 3,
      retention: null,
      ahead: 0,
      current: false,
      nextDropAfter: null,
      rowsEstimate: 300,
      bytesEstimate: 64 * 1024,
      maxXidAge: 900,
      partitions: [],
    },
  ];
  return { at: NOW, parents: base.map((parent, i) => ({ ...parent, ...overrides[i] })) };
}

export function deadLetter(id: string, overrides: Partial<AdminDeadLetter> = {}): AdminDeadLetter {
  const ms = Number(id.split('-')[0]);
  return { id, stream: 'like', at: new Date(ms).toISOString(), entryAt: new Date(ms - 60_000).toISOString(), reason: 'rejected', deliveries: 1, kind: 'like', ...overrides };
}

/** A role as `GET /v1/admin/roles` answers it (its permissions expanded). */
export function role(key: string, grants: string[]): AdminRole {
  return { key, names: {}, grants, permissions: expandGrants(grants) };
}

export const ROLES: AdminRole[] = [
  role('superadmin', ['*']),
  role('admin', ['appeals.*', 'audit.read', 'billing.catalog', 'billing.read', 'campaigns.*', 'config.*', 'content.*', 'dashboard.read', 'dashboard.revenue', 'moderation.*', 'reports.*', 'support.*', 'users.*', 'users.chats']),
  role('moderator', ['appeals.*', 'dashboard.read', 'moderation.*', 'reports.*', 'users.ban', 'users.lift', 'users.read', 'users.revoke_sessions', 'users.shadowban', 'users.suspend', 'users.warn']),
  role('support', ['dashboard.read', 'support.*', 'users.read']),
  role('finance', ['billing.*', 'dashboard.read', 'dashboard.revenue', 'users.read']),
  role('marketing', ['campaigns.*', 'content.read', 'dashboard.read']),
  role('analyst', ['dashboard.read', 'dashboard.revenue']),
];

export const HOLDERS = { items: ROLES.map((role, i) => ({ key: role.key, admins: [1, 2, 3, 2, 1, 0, 1][i]! })) };
