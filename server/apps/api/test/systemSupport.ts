import { queuePrefix } from '@app/shared/server';
import { Queue, Worker } from 'bullmq';
import type { Harness, TestDatabase } from './accountSupport.js';

/**
 * Helpers of the system suites: a failed BullMQ job made the way the worker
 * fails one (a processor that throws), a failed stream entry written as the
 * worker's consumer writes it, and role grants written past the role rules
 * (`admin_role_rules()`), for the cases a test needs that the rules refuse.
 */

/** Polls until `check` holds (or the time is up). */
export async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Failed jobs of `queue/name` with these ids (one attempt each), under the harness's prefix. */
export async function failJobs(h: Harness, queue: string, name: string, ids: readonly string[]): Promise<void> {
  const prefix = queuePrefix(h.prefix);
  const connection = h.redis.duplicate({ maxRetriesPerRequest: null });
  const q = new Queue(queue, { connection: h.redis, prefix });
  const wanted = new Set(ids);
  let failed = 0;
  const worker = new Worker(
    queue,
    async (job) => {
      if (!wanted.has(job.id ?? '')) throw new Error('not this test’s job');
      throw Object.assign(new Error('the test fails it'), { name: 'TestFailure' });
    },
    { connection, prefix, autorun: true, concurrency: 20 },
  );
  worker.on('failed', (job) => {
    if (job && wanted.has(job.id ?? '')) failed += 1;
  });
  worker.on('error', () => undefined);
  try {
    await q.addBulk(ids.map((id) => ({ name, data: {}, opts: { jobId: id, attempts: 1, removeOnFail: false, removeOnComplete: true } })));
    await waitUntil(() => failed >= ids.length, 20_000);
  } finally {
    await worker.close();
    await q.close();
    connection.disconnect();
  }
}

/** The failed set of a queue (its BullMQ key). */
export function failedKey(h: Harness, queue: string): string {
  return `${queuePrefix(h.prefix)}:${queue}:failed`;
}

/** A failed entry of a write-behind stream as the consumers write it; returns its id. */
export async function deadLetter(
  h: Harness,
  stream: 'like' | 'match' | 'msg',
  entry: { id: string; deliveries?: number; reason?: string; fields: Record<string, string> },
): Promise<string> {
  const id = await h.redis.xadd(
    `${h.prefix}wb:${stream}:dead`,
    '*',
    'stream',
    `${h.prefix}wb:${stream}`,
    'group',
    'pg',
    'id',
    entry.id,
    'deliveries',
    String(entry.deliveries ?? 1),
    'reason',
    entry.reason ?? 'rejected',
    'fields',
    JSON.stringify(entry.fields),
  );
  return id!;
}

/** Writes role grants past the role rules (a superuser's replica session: no trigger fires), as a hand-made row would be. */
export async function grantPastRules(db: TestDatabase, roleId: number, grants: readonly string[], remove = false): Promise<void> {
  const client = await db.sql.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL session_replication_role = replica`);
    for (const grant of grants) {
      if (remove) await client.query(`DELETE FROM admin_role_permissions WHERE role_id = $1 AND permission = $2`, [roleId, grant]);
      else await client.query(`INSERT INTO admin_role_permissions (role_id, permission) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [roleId, grant]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
