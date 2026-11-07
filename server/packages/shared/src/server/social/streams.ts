import type { Redis } from 'ioredis';
import type { KeyBuilder } from '../kv/keys.js';

/**
 * The entries of the write-behind streams `wb:like` and `wb:match`, as the
 * like script writes them and the worker reads them. Ids are raw decimal
 * ids; an empty string is "none". The main streams are never trimmed by
 * length (an outage would drop unwritten entries): the worker trims them
 * by MINID after its writes.
 */

const ID = /^[1-9][0-9]{0,18}$/;

export class StreamEntryError extends Error {
  constructor(stream: string, field: string) {
    super(`${stream} entry: field ${field} is missing or malformed`);
    this.name = 'StreamEntryError';
  }
}

function id(stream: string, fields: Record<string, string>, name: string): string {
  const value = fields[name];
  if (value === undefined || !ID.test(value)) throw new StreamEntryError(stream, name);
  return value;
}

function optionalId(stream: string, fields: Record<string, string>, name: string): string | null {
  const value = fields[name];
  if (value === undefined || value === '') return null;
  if (!ID.test(value)) throw new StreamEntryError(stream, name);
  return value;
}

function small(stream: string, fields: Record<string, string>, name: string, allowed: readonly number[]): number {
  const value = Number(fields[name]);
  if (!allowed.includes(value)) throw new StreamEntryError(stream, name);
  return value;
}

function text(fields: Record<string, string>, name: string): string | null {
  const value = fields[name];
  return value === undefined || value === '' ? null : value;
}

/** One like as `wb:like` carries it. */
export interface LikeEntry {
  id: string;
  targetId: string;
  actorId: string;
  kind: 1 | 2;
  itemKind: 0 | 1 | 2;
  itemRef: string | null;
  comment: string | null;
  /** The actor's buckets were incomplete: the writer looks the mutual like up once the batch is durable. */
  check: boolean;
  /** Already in PostgreSQL (paid from the wallet): the batch INSERT skips it by its key. */
  prepaid: boolean;
}

export function parseLikeEntry(fields: Record<string, string>): LikeEntry {
  const itemKind = small('wb:like', fields, 'ik', [0, 1, 2]) as 0 | 1 | 2;
  const itemRef = optionalId('wb:like', fields, 'ir');
  if ((itemKind === 0) !== (itemRef === null)) throw new StreamEntryError('wb:like', 'ir');
  return {
    id: id('wb:like', fields, 'id'),
    targetId: id('wb:like', fields, 't'),
    actorId: id('wb:like', fields, 'a'),
    kind: small('wb:like', fields, 'k', [1, 2]) as 1 | 2,
    itemKind,
    itemRef,
    comment: text(fields, 'c'),
    check: fields['x'] === '1',
    prepaid: fields['w'] === '1',
  };
}

/** A match as `wb:match` carries it: the pre-minted ids and the like that made it. */
export interface MatchEntry {
  matchId: string;
  /** Who liked second (the like in this entry). */
  actorId: string;
  /** Who liked first. */
  targetId: string;
  /** Kind of the second like. */
  kind: 1 | 2;
  /** The like note of the first like (sent by the target), then of the second (by the actor). */
  noteIds: [string, string];
  likeId: string;
  itemKind: 0 | 1 | 2;
  itemRef: string | null;
  comment: string | null;
}

export function parseMatchEntry(fields: Record<string, string>): MatchEntry {
  const itemKind = small('wb:match', fields, 'ik', [0, 1, 2]) as 0 | 1 | 2;
  return {
    matchId: id('wb:match', fields, 'm'),
    actorId: id('wb:match', fields, 'a'),
    targetId: id('wb:match', fields, 't'),
    kind: small('wb:match', fields, 's', [1, 2]) as 1 | 2,
    noteIds: [id('wb:match', fields, 'n1'), id('wb:match', fields, 'n2')],
    likeId: id('wb:match', fields, 'l'),
    itemKind,
    itemRef: optionalId('wb:match', fields, 'ir'),
    comment: text(fields, 'c'),
  };
}

/**
 * Appends a match found outside the like script (the PostgreSQL look-up of a
 * `check`, the writer's look-up after a batch) to `wb:match`, with the same
 * fields the script writes. The entry is what makes the match durable.
 */
export async function appendMatch(redis: Redis, keys: KeyBuilder, entry: MatchEntry): Promise<string> {
  const id = await redis.xadd(
    keys.stream('match'),
    '*',
    'm',
    entry.matchId,
    'a',
    entry.actorId,
    't',
    entry.targetId,
    's',
    String(entry.kind),
    'n1',
    entry.noteIds[0],
    'n2',
    entry.noteIds[1],
    'l',
    entry.likeId,
    'ik',
    String(entry.itemKind),
    'ir',
    entry.itemRef ?? '',
    'c',
    entry.comment ?? '',
  );
  if (id === null) throw new Error('XADD wb:match returned no id');
  return id;
}

/** The match source of a like that made a match: a super like, a like on an item, or a plain mutual like. */
export function matchSourceOf(kind: 1 | 2, itemKind: 0 | 1 | 2): 1 | 2 | 4 {
  if (kind === 2) return 2;
  return itemKind === 0 ? 1 : 4;
}

/** The write-behind watermark of a stream: every app id below it is durable (null: never written). */
export async function readWatermark(redis: Redis, keys: KeyBuilder, name: 'like' | 'msg'): Promise<bigint | null> {
  const value = await redis.get(keys.streamWatermark(name));
  if (value === null || !/^[0-9]{1,19}$/.test(value)) return null;
  return BigInt(value);
}
