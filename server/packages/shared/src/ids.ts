/**
 * Application ids: positive 63-bit integers, time-ordered, minted by the
 * API and the worker before a row reaches PostgreSQL.
 *
 *     bit 63      0
 *     bits 22-62  milliseconds since 2026-01-01T00:00:00Z (41 bits: until 2095)
 *     bits 12-21  generator id 0-1023 (a process lease in Valkey; 1023 = the database's id_next())
 *     bits 0-11   sequence within the millisecond
 *
 * The same layout as the SQL helpers id_epoch_ms(), id_floor(), id_ms() and
 * id_time() of migration 0001; never change the epoch.
 */
export const ID_EPOCH_MS = 1_767_225_600_000;
export const ID_GENERATOR_BITS = 10;
export const ID_SEQUENCE_BITS = 12;
export const ID_MAX_GENERATOR = (1 << ID_GENERATOR_BITS) - 1;
/** Generator 1023 belongs to the database (`id_next()`); processes lease 0-1022. */
export const ID_DATABASE_GENERATOR = ID_MAX_GENERATOR;
export const ID_MAX_SEQUENCE = (1 << ID_SEQUENCE_BITS) - 1;
const TIME_SHIFT = BigInt(ID_GENERATOR_BITS + ID_SEQUENCE_BITS);
const MAX_ID = (1n << 63n) - 1n;

export interface IdParts {
  /** Milliseconds since 1970. */
  ms: number;
  generator: number;
  sequence: number;
}

/** Builds an id from its parts; throws when a part is out of range. */
export function composeId({ ms, generator, sequence }: IdParts): bigint {
  const offset = ms - ID_EPOCH_MS;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= 2 ** 41) throw new RangeError('id time out of range');
  if (!Number.isInteger(generator) || generator < 0 || generator > ID_MAX_GENERATOR) throw new RangeError('generator out of range');
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > ID_MAX_SEQUENCE) throw new RangeError('sequence out of range');
  return (BigInt(offset) << TIME_SHIFT) | (BigInt(generator) << BigInt(ID_SEQUENCE_BITS)) | BigInt(sequence);
}

export function idParts(id: bigint | string): IdParts {
  const value = typeof id === 'bigint' ? id : BigInt(id);
  if (value <= 0n || value > MAX_ID) throw new RangeError('not an application id');
  return {
    ms: Number(value >> TIME_SHIFT) + ID_EPOCH_MS,
    generator: Number((value >> BigInt(ID_SEQUENCE_BITS)) & BigInt(ID_MAX_GENERATOR)),
    sequence: Number(value & BigInt(ID_MAX_SEQUENCE)),
  };
}

/** When an id was minted (`id_time()`). */
export function idTime(id: bigint | string): Date {
  return new Date(idParts(id).ms);
}

/** The smallest id minted at or after `time` (`id_floor()`): "rows since T" as a key range. */
export function idFloor(time: Date | number): bigint {
  const offset = Math.floor(new Date(time).getTime()) - ID_EPOCH_MS;
  if (offset < 0) return 0n;
  return BigInt(offset) << TIME_SHIFT;
}
