import { crc32, deflateRawSync } from 'node:zlib';

/**
 * A ZIP archive (APPNOTE 6.3, no ZIP64) built in memory: each entry deflated,
 * or stored when it is already compressed (pictures). UTF-8 names (flag 11).
 * Enough for an account's data export; refuses what this format cannot hold
 * without ZIP64 (4 GiB, 65,535 entries).
 */

export interface ZipEntry {
  /** A relative path with `/` separators, no `..`, no leading `/`. */
  name: string;
  data: Uint8Array;
  /** false: stored as is (already compressed data). Default true. */
  compress?: boolean;
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const VERSION = 20;
const UTF8_NAMES = 0x0800;
const MAX_U32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;

function dosTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getUTCFullYear(), 1980), 2107);
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

function checkName(name: string): Buffer {
  if (name.length === 0 || name.startsWith('/') || name.includes('\\') || name.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new RangeError(`"${name.slice(0, 60)}" is not a safe entry name`);
  }
  const bytes = Buffer.from(name, 'utf8');
  if (bytes.length > 0xffff) throw new RangeError('an entry name is too long');
  return bytes;
}

export function buildZip(entries: readonly ZipEntry[], at: Date = new Date()): Buffer {
  if (entries.length > MAX_ENTRIES) throw new RangeError('too many entries for a ZIP without ZIP64');
  const stamp = dosTime(at);
  const seen = new Set<string>();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = checkName(entry.name);
    if (seen.has(entry.name)) throw new RangeError(`"${entry.name}" is in the archive twice`);
    seen.add(entry.name);
    const raw = Buffer.from(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength);
    const method = entry.compress === false ? 0 : 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const sum = crc32(raw) >>> 0;
    if (raw.length > MAX_U32 || body.length > MAX_U32 || offset > MAX_U32) throw new RangeError('the archive is too large for a ZIP without ZIP64');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER, 0);
    central.writeUInt16LE(VERSION, 4);
    central.writeUInt16LE(VERSION, 6);
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    // Extra field, comment, disk number, internal and external attributes: none.
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  if (offset > MAX_U32 || directory.length > MAX_U32) throw new RangeError('the archive is too large for a ZIP without ZIP64');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
