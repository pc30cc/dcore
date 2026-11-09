import { createHash } from 'node:crypto';
import { originsDocumentSchema, readOriginsPayload } from '@app/shared';
import { originsKeys, readOriginsDocument, type KeyBuilder } from '@app/shared/server';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { PublishTarget } from './targets.js';

/**
 * Publishes the signed origins document to the bootstrap targets. The API
 * signs it and keeps the newest in Valkey (`origins:doc`); this job copies
 * those exact bytes to each target that does not hold this version yet, and
 * once a day again so the copies never come near their expiry (a document
 * is valid for 30 days by default). It runs on a schedule (every ten
 * minutes: one Valkey read when nothing changed, no statement ever) and
 * right after the panel saves hosts (`origins-publish.<version>`, retried
 * until the API has signed that version).
 *
 * Each target keeps its own record (`origins:pub:<target>`), so one that is
 * down is retried on the next round without uploading to the others again.
 */

export const REPUBLISH_AFTER_MS = 24 * 3_600_000;

export interface PublishOutcome {
  outcome: 'nothing_signed' | 'no_targets' | 'current' | 'published';
  version?: number | undefined;
  published: string[];
  failed: string[];
}

export class NotSignedYetError extends Error {
  constructor(expected: number, found: number | null) {
    super(found === null ? `no origins document is signed yet (waiting for version ${expected})` : `the API signed version ${found}, waiting for ${expected}`);
    this.name = 'NotSignedYetError';
  }
}

export interface PublishContext {
  redis: Redis;
  keys: KeyBuilder;
  targets: readonly PublishTarget[];
  log: Logger;
  now?: (() => number) | undefined;
}

export async function publishOrigins(context: PublishContext, expectedVersion?: number): Promise<PublishOutcome> {
  const { redis, keys, targets, log } = context;
  const now = (context.now ?? Date.now)();
  const stored = await readOriginsDocument(redis, keys);
  if (expectedVersion !== undefined && (stored === null || stored.version < expectedVersion)) {
    throw new NotSignedYetError(expectedVersion, stored?.version ?? null);
  }
  if (stored === null) return { outcome: 'nothing_signed', published: [], failed: [] };
  if (targets.length === 0) return { outcome: 'no_targets', version: stored.version, published: [], failed: [] };

  // Never publish what apps would refuse to parse: the bytes must be a document whose payload says the same version.
  let valid: boolean;
  try {
    const parsed = originsDocumentSchema.safeParse(JSON.parse(stored.body) as unknown);
    valid = parsed.success && readOriginsPayload(parsed.data).version === stored.version;
  } catch {
    valid = false;
  }
  if (!valid) {
    log.error({ version: stored.version }, 'origins: the stored document is not a valid one; nothing is published');
    return { outcome: 'current', version: stored.version, published: [], failed: targets.map((t) => t.id) };
  }

  const sha = createHash('sha256').update(stored.body).digest('hex');
  const body = new TextEncoder().encode(stored.body);
  const names = originsKeys(keys);
  const records = await Promise.all(targets.map((target) => redis.hgetall(names.published(target.id))));
  const due = targets.filter((target, index) => {
    const record = records[index] ?? {};
    if (record['sha'] === sha) return false;
    const version = Number(record['v']);
    const at = Number(record['at']);
    return !(version === stored.version && Number.isFinite(at) && now - at < REPUBLISH_AFTER_MS);
  });
  if (due.length === 0) return { outcome: 'current', version: stored.version, published: [], failed: [] };

  const results = await Promise.allSettled(due.map((target) => target.put(body)));
  const published: string[] = [];
  const failed: string[] = [];
  for (const [index, result] of results.entries()) {
    const target = due[index]!;
    if (result.status === 'fulfilled') {
      published.push(target.id);
      await redis.hset(names.published(target.id), { v: String(stored.version), t: String(stored.issuedAtMs), at: String(now), sha });
    } else {
      failed.push(target.id);
      log.warn({ target: target.id, err: result.reason }, 'origins: publishing to a target failed; retried on the next round');
    }
  }
  if (published.length > 0) log.info({ version: stored.version, targets: published }, 'origins: document published');
  return { outcome: 'published', version: stored.version, published, failed };
}
