import type { Redis } from 'ioredis';
import { idParts } from '../../ids.js';
import type { KeyBuilder } from '../kv/keys.js';

/**
 * The health of the write-behind streams (`wb:like`, `wb:match`, `wb:msg`,
 * consumer group `pg`), read by the dashboard's live snapshot and the system
 * page. One pipeline per call (XLEN, XLEN of the dead letters, XINFO GROUPS,
 * the XPENDING summary and the watermark of each stream; a command that
 * fails, as XINFO does for a stream that does not exist, reads as missing),
 * then at most one XRANGE per stream whose group has undelivered entries.
 */

export const writeBehindStreams = ['like', 'match', 'msg'] as const;
export type WriteBehindStream = (typeof writeBehindStreams)[number];

/** The consumer group of the write-behind writers. */
export const STREAM_GROUP = 'pg';
/** Ids are minted a moment before their entry is appended: the watermark trails by this much by design. */
export const WATERMARK_MARGIN_MS = 5_000;

export interface StreamHealth {
  name: WriteBehindStream;
  /** XLEN wb:<name>. */
  length: number;
  /** Entries delivered to the group and not acknowledged (XPENDING summary). */
  pending: number;
  /** XLEN wb:<name>:dead. */
  dead: number;
  /** now − time of the oldest pending entry; else, with undelivered entries, now − time of the first one; else 0; null: stream or group missing. */
  lagMs: number | null;
  /** The group exists. */
  group: boolean;
  /** Consumers of the group. */
  consumers: number;
  /** Entries not yet delivered to the group (XINFO GROUPS `lag`); null when Valkey cannot tell. */
  undelivered: number | null;
  oldestPendingAtMs: number | null;
  /** The time of the group's last delivered id (null for 0-0). */
  lastDeliveredAtMs: number | null;
  /** like and msg: now − (time of the watermark id + the margin), at least 0; null for match or without a watermark. */
  watermarkLagMs: number | null;
}

/**
 * Entries still to be written: delivered and not acknowledged (pending)
 * plus not yet delivered (undelivered). `length` is not this: a stream keeps
 * entries after they are written (MAXLEN or MINID trims follow later).
 * Undelivered counts at most the entries the stream still holds: XINFO
 * GROUPS `lag` is entries added less entries read, which a trim of
 * undelivered entries does not lower (they are gone, not waiting).
 * Null when the group is missing or Valkey cannot tell the undelivered count.
 */
export function streamWaiting(health: Pick<StreamHealth, 'group' | 'length' | 'pending' | 'undelivered'>): number | null {
  if (!health.group || health.undelivered === null) return null;
  return health.pending + Math.min(health.undelivered, health.length);
}

const STREAM_ID = /^([0-9]{1,15})-[0-9]{1,20}$/;
const APP_ID = /^[1-9][0-9]{0,18}$/;

function streamIdMs(id: unknown): number | null {
  if (typeof id !== 'string') return null;
  const match = STREAM_ID.exec(id);
  if (!match) return null;
  const ms = Number(match[1]);
  return ms > 0 ? ms : null;
}

function count(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/** XINFO GROUPS answers a flat field list per group. */
function groupInfo(reply: unknown): Record<string, unknown> | null {
  if (!Array.isArray(reply)) return null;
  for (const entry of reply) {
    if (!Array.isArray(entry)) continue;
    const fields: Record<string, unknown> = {};
    for (let i = 0; i + 1 < entry.length; i += 2) fields[String(entry[i])] = entry[i + 1];
    if (fields['name'] === STREAM_GROUP) return fields;
  }
  return null;
}

function watermarkMs(value: unknown): number | null {
  if (typeof value !== 'string' || !APP_ID.test(value)) return null;
  try {
    return idParts(value).ms;
  } catch {
    return null;
  }
}

export async function streamHealth(redis: Redis, keys: KeyBuilder, now: number = Date.now()): Promise<StreamHealth[]> {
  const pipeline = redis.pipeline();
  for (const name of writeBehindStreams) {
    const stream = keys.stream(name);
    pipeline.xlen(stream);
    pipeline.xlen(keys.streamDead(name));
    pipeline.xinfo('GROUPS', stream);
    pipeline.xpending(stream, STREAM_GROUP);
    if (name === 'match') pipeline.echo('');
    else pipeline.get(keys.streamWatermark(name));
  }
  const replies = (await pipeline.exec()) ?? [];
  const at = (i: number): unknown => {
    const reply = replies[i];
    return reply?.[0] === null ? reply[1] : undefined;
  };

  const health: StreamHealth[] = [];
  const firstUndelivered: { index: number; after: string }[] = [];
  writeBehindStreams.forEach((name, s) => {
    const base = s * 5;
    const length = count(at(base));
    const dead = count(at(base + 1));
    const info = groupInfo(at(base + 2));
    const summary = at(base + 3);
    const pending = Array.isArray(summary) ? count(summary[0]) : 0;
    const oldestPendingAtMs = pending > 0 && Array.isArray(summary) ? streamIdMs(summary[1]) : null;
    const lag = info?.['lag'];
    const undelivered = info === null ? null : lag === null || lag === undefined ? null : count(lag);
    const lastDelivered = info?.['last-delivered-id'];
    const wm = name === 'match' ? null : watermarkMs(at(base + 4));
    const entry: StreamHealth = {
      name,
      length,
      pending,
      dead,
      lagMs: null,
      group: info !== null,
      consumers: info === null ? 0 : count(info['consumers']),
      undelivered,
      oldestPendingAtMs,
      lastDeliveredAtMs: streamIdMs(lastDelivered),
      watermarkLagMs: wm === null ? null : Math.max(0, now - (wm + WATERMARK_MARGIN_MS)),
    };
    if (info !== null) {
      if (oldestPendingAtMs !== null) entry.lagMs = Math.max(0, now - oldestPendingAtMs);
      else if ((undelivered ?? 0) > 0 && typeof lastDelivered === 'string') firstUndelivered.push({ index: s, after: lastDelivered });
      else entry.lagMs = 0;
    }
    health.push(entry);
  });

  for (const { index, after } of firstUndelivered) {
    const entry = health[index]!;
    try {
      const next = await redis.xrange(keys.stream(entry.name), `(${after}`, '+', 'COUNT', 1);
      const ms = streamIdMs(next[0]?.[0]);
      entry.lagMs = ms === null ? 0 : Math.max(0, now - ms);
    } catch {
      entry.lagMs = null;
    }
  }
  return health;
}
