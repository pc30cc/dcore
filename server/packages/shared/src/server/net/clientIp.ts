import { readFileSync } from 'node:fs';
import { BlockList, isIP } from 'node:net';

/**
 * The client's address and country behind Cloudflare.
 *
 * The API sits behind Cloudflare, but the origin can also be reached
 * directly. `cf-connecting-ip` and `cf-ipcountry` are believed only when the
 * edge (the address that connected to our outermost proxy, which is the
 * framework's `request.ip` under `TRUST_PROXY`) is one of Cloudflare's
 * published ranges: Cloudflare overwrites those headers, while anyone who
 * reaches the origin directly could send them. Any other edge is the client
 * itself, and the headers are ignored.
 *
 * Residual: a range check cannot tell our Cloudflare zone from another
 * account's TCP passthrough through Cloudflare, which forwards the sender's
 * headers unchanged; binding to our zone needs Authenticated Origin Pulls or
 * a secret header set by a Cloudflare rule.
 *
 * Every answer is a normalised address (lower case, IPv4-mapped IPv6 as
 * IPv4, IPv6 in RFC 5952 form), or null: no placeholder is ever invented.
 */

/** Cloudflare's published edge ranges (https://www.cloudflare.com/ips-v4, /ips-v6). */
export const CLOUDFLARE_IPV4_RANGES: readonly string[] = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
];
export const CLOUDFLARE_IPV6_RANGES: readonly string[] = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

/** The eight 16-bit groups of an IPv6 address (any spelling, a dotted IPv4 tail included), or null. */
function ipv6Groups(ip: string): number[] | null {
  if (isIP(ip) !== 6) return null;
  let text = ip;
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted?.[1] && dotted[2]) {
    const o = dotted[2].split('.').map(Number) as [number, number, number, number];
    text = `${dotted[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const part = (x: string | undefined) => (x ? x.split(':').filter(Boolean).map((h) => parseInt(h, 16)) : []);
  const a = part(head);
  const b = tail === undefined ? [] : part(tail);
  const fill = 8 - a.length - b.length;
  if (fill < 0 || (tail === undefined && fill !== 0)) return null;
  return [...a, ...new Array<number>(fill).fill(0), ...b];
}

/** RFC 5952 text of eight groups: lower-case hex, no leading zeros, the longest run of 2+ zero groups as `::`. */
function canonicalIpv6(g: readonly number[]): string {
  let best = -1;
  let bestLen = 1;
  for (let i = 0; i < 8; ) {
    if (g[i] !== 0) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < 8 && g[j] === 0) j += 1;
    if (j - i > bestLen) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = g.map((x) => x.toString(16));
  if (best < 0) return hex.join(':');
  return `${hex.slice(0, best).join(':')}::${hex.slice(best + bestLen).join(':')}`;
}

/** Strips a port, brackets and a zone id, folds IPv4-mapped IPv6 to IPv4, lower-cases. Null if not an address. */
export function normalizeIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let ip = raw.trim().toLowerCase();
  if (!ip || ip === 'unknown') return null;
  if (ip.startsWith('[')) {
    const close = ip.indexOf(']');
    if (close > 0) ip = ip.slice(1, close);
  } else if (ip.includes('.') && ip.split(':').length === 2) {
    ip = ip.split(':')[0] ?? ip;
  }
  const zone = ip.indexOf('%');
  if (zone > 0) ip = ip.slice(0, zone);
  const g = ipv6Groups(ip);
  if (g?.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    const hi = g[6] ?? 0;
    const lo = g[7] ?? 0;
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  if (g) return canonicalIpv6(g);
  return isIP(ip) ? ip : null;
}

/** True for private, loopback, link-local, CGNAT, documentation, multicast and reserved addresses. */
export function isPrivateOrReservedIp(raw: string): boolean {
  const ip = normalizeIp(raw);
  if (!ip) return true;
  if (isIP(ip) === 4) {
    const [a = 0, b = 0, c = 0] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 198 && b === 51 && c === 100) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return a >= 224;
  }
  const g = ipv6Groups(ip);
  if (!g) return true;
  const [g0 = 0, g1 = 0] = g;
  if (g.slice(0, 7).every((x) => x === 0) && (g[7] ?? 0) <= 1) return true;
  if ((g0 & 0xffc0) === 0xfe80) return true;
  if ((g0 & 0xfe00) === 0xfc00) return true;
  if ((g0 & 0xff00) === 0xff00) return true;
  if (g0 === 0x2001 && g1 === 0x0db8) return true;
  return g0 === 0x64 && g1 === 0xff9b && g.slice(2, 6).every((x) => x === 0);
}

export function isPublicIp(raw: string | null | undefined): boolean {
  const ip = normalizeIp(raw);
  return ip !== null && !isPrivateOrReservedIp(ip);
}

function addRange(list: BlockList, entry: string): boolean {
  const [addr, bits, extra] = entry.split('/');
  const ip = normalizeIp(addr);
  if (!ip || extra !== undefined) return false;
  const type = isIP(ip) === 4 ? 'ipv4' : 'ipv6';
  if (bits === undefined) {
    list.addAddress(ip, type);
    return true;
  }
  const prefix = Number(bits);
  if (!/^\d{1,3}$/.test(bits) || prefix < 1 || prefix > (type === 'ipv4' ? 32 : 128)) return false;
  list.addSubnet(ip, prefix, type);
  return true;
}

/**
 * Which edges are Cloudflare's, from `CF_EDGE_TRUST`: empty or `default` is
 * the published list; `off` trusts none (no Cloudflare in front); otherwise a
 * comma or space separated list of addresses and CIDRs, where `default`
 * stands for the published list (`default,10.0.5.3` adds a tunnel
 * container); `file:<path>` reads such a list from a file, one entry per line
 * (`#` starts a comment), so the ranges can change without a deploy.
 */
export function parseEdgeTrust(value: string | undefined, readFile: (path: string) => string = (p) => readFileSync(p, 'utf8')): string[] {
  const raw = (value ?? '').trim();
  if (raw.startsWith('file:')) {
    const text = readFile(raw.slice('file:'.length));
    return parseEdgeTrust(
      text
        .split('\n')
        .map((line) => line.replace(/#.*/, '').trim())
        .filter(Boolean)
        .join(','),
    );
  }
  const entries = raw ? raw.split(/[\s,]+/).filter(Boolean) : ['default'];
  const out: string[] = [];
  for (const entry of entries) {
    const word = entry.toLowerCase();
    if (word === 'off' || word === 'none') continue;
    if (word === 'default') out.push(...CLOUDFLARE_IPV4_RANGES, ...CLOUDFLARE_IPV6_RANGES);
    else out.push(entry);
  }
  return out;
}

export interface ClientAddressInput {
  /** The edge: the framework's client address under its trusted-proxy setting (Fastify `request.ip`). */
  edgeIp: string | null | undefined;
  headers: Readonly<Record<string, string | string[] | undefined>>;
}

export interface ClientAddress {
  /** The client's public address, or null when none can be known (local development, a private-only chain). */
  ip: string | null;
  /** ISO country from Cloudflare, only when the edge is Cloudflare's. */
  country: string | null;
  /** The request came through Cloudflare. */
  viaCloudflare: boolean;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value.join(',') : value;
  return raw?.split(',')[0]?.trim() || undefined;
}

export class ClientIpResolver {
  private edges: BlockList;
  private invalid: string[];

  constructor(ranges: readonly string[]) {
    const { list, invalid } = ClientIpResolver.build(ranges);
    this.edges = list;
    this.invalid = invalid;
  }

  private static build(ranges: readonly string[]): { list: BlockList; invalid: string[] } {
    const list = new BlockList();
    const invalid: string[] = [];
    for (const range of ranges) if (!addRange(list, range)) invalid.push(range);
    return { list, invalid };
  }

  /** Entries of the configured list that were neither an address nor a CIDR (ignored). */
  get ignoredEntries(): readonly string[] {
    return this.invalid;
  }

  /** Replaces the trusted ranges (a reloaded `file:` list). */
  update(ranges: readonly string[]): void {
    const { list, invalid } = ClientIpResolver.build(ranges);
    this.edges = list;
    this.invalid = invalid;
  }

  isCloudflare(raw: string | null | undefined): boolean {
    const ip = normalizeIp(raw);
    return ip !== null && this.edges.check(ip, isIP(ip) === 4 ? 'ipv4' : 'ipv6');
  }

  resolve({ edgeIp, headers }: ClientAddressInput): ClientAddress {
    const edge = normalizeIp(edgeIp);
    if (edge === null) return { ip: null, country: null, viaCloudflare: false };
    if (this.isCloudflare(edge)) {
      const cf = normalizeIp(firstHeader(headers['cf-connecting-ip']));
      const cc = firstHeader(headers['cf-ipcountry'])?.toUpperCase();
      // Cloudflare writes XX for unknown and T1 for Tor.
      const country = cc && /^[A-Z]{2}$/.test(cc) && cc !== 'XX' && cc !== 'T1' ? cc : null;
      return { ip: cf && !isPrivateOrReservedIp(cf) ? cf : null, country, viaCloudflare: true };
    }
    return { ip: isPrivateOrReservedIp(edge) ? null : edge, country: null, viaCloudflare: false };
  }
}

/**
 * The key an address is counted under by rate limits: the address for IPv4,
 * its /56 for IPv6 (the smallest block a home connection usually gets).
 */
export function ipRateKey(ip: string, ipv6PrefixBits = 56): string {
  const normalized = normalizeIp(ip);
  if (normalized === null) return 'unknown';
  if (isIP(normalized) === 4) return normalized;
  const g = ipv6Groups(normalized);
  if (!g) return 'unknown';
  const out = g.map((group, index) => {
    const start = index * 16;
    if (start >= ipv6PrefixBits) return 0;
    const keep = Math.min(16, ipv6PrefixBits - start);
    return group & (0xffff << (16 - keep)) & 0xffff;
  });
  return `${canonicalIpv6(out)}/${ipv6PrefixBits}`;
}
