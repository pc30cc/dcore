import { describe, expect, it } from 'vitest';
import {
  ClientIpResolver,
  cellCentre,
  cellDistanceKm,
  cellIdToHex,
  cellResolution,
  hexToCellId,
  homeCell,
  ipRateKey,
  isPrivateOrReservedIp,
  normalizeIp,
  parentCell,
  parseEdgeTrust,
  shownDistance,
} from '../../src/server/index.js';

describe('client addresses', () => {
  const resolver = new ClientIpResolver(parseEdgeTrust(undefined));
  const cfHeaders = { 'cf-connecting-ip': '5.160.1.2', 'cf-ipcountry': 'ir' };

  it('normalises every spelling of an address', () => {
    expect(normalizeIp('::ffff:185.1.2.3')).toBe('185.1.2.3');
    expect(normalizeIp('0:0:0:0:0:ffff:b901:203')).toBe('185.1.2.3');
    expect(normalizeIp('[2A01:0DB8:0000:0000:0000:0000:0000:0001]:443')).toBe('2a01:db8::1');
    expect(normalizeIp('1.2.3.4:5678')).toBe('1.2.3.4');
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80::1');
    expect(normalizeIp('not an ip')).toBeNull();
    expect(normalizeIp('unknown')).toBeNull();
  });

  it('knows private and reserved ranges', () => {
    for (const ip of ['10.1.2.3', '172.20.0.1', '192.168.1.1', '127.0.0.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '2001:db8::1']) {
      expect(isPrivateOrReservedIp(ip), ip).toBe(true);
    }
    for (const ip of ['5.160.1.2', '8.8.8.8', '2a01:4f8::1']) expect(isPrivateOrReservedIp(ip), ip).toBe(false);
  });

  it('believes Cloudflare headers only from a Cloudflare edge', () => {
    expect(resolver.resolve({ edgeIp: '162.158.10.20', headers: cfHeaders })).toEqual({ ip: '5.160.1.2', country: 'IR', viaCloudflare: true });
    expect(resolver.resolve({ edgeIp: '2606:4700::6810:1', headers: cfHeaders }).ip).toBe('5.160.1.2');
    // A client that reaches the origin directly cannot choose its address or country.
    expect(resolver.resolve({ edgeIp: '203.0.114.9', headers: cfHeaders })).toEqual({ ip: '203.0.114.9', country: null, viaCloudflare: false });
    expect(resolver.resolve({ edgeIp: '10.0.0.5', headers: cfHeaders })).toEqual({ ip: null, country: null, viaCloudflare: false });
  });

  it('drops a private or missing Cloudflare client and unknown countries', () => {
    expect(resolver.resolve({ edgeIp: '162.158.10.20', headers: { 'cf-connecting-ip': '10.0.0.1', 'cf-ipcountry': 'XX' } })).toEqual({
      ip: null,
      country: null,
      viaCloudflare: true,
    });
    expect(resolver.resolve({ edgeIp: '162.158.10.20', headers: { 'cf-ipcountry': 'T1' } }).country).toBeNull();
  });

  it('reads CF_EDGE_TRUST: default, off, a list, a file', () => {
    expect(parseEdgeTrust('off')).toEqual([]);
    expect(parseEdgeTrust('default,10.0.5.3')).toContain('10.0.5.3');
    expect(parseEdgeTrust('default').length).toBeGreaterThan(20);
    const fromFile = parseEdgeTrust('file:/ranges', () => '# edges\n10.9.0.0/16\n\n173.245.48.0/20 # first\n');
    expect(fromFile).toEqual(['10.9.0.0/16', '173.245.48.0/20']);
    const custom = new ClientIpResolver(['10.9.0.0/16', 'nonsense', '1.2.3.4/0']);
    expect(custom.ignoredEntries).toEqual(['nonsense', '1.2.3.4/0']);
    expect(custom.isCloudflare('10.9.8.7')).toBe(true);
    custom.update([]);
    expect(custom.isCloudflare('10.9.8.7')).toBe(false);
  });

  it('counts IPv6 clients per /56', () => {
    expect(ipRateKey('2a01:4f8:1:2:3:4:5:6')).toBe('2a01:4f8:1::/56');
    expect(ipRateKey('2a01:4f8:1:2ff:3:4:5:6')).toBe('2a01:4f8:1:200::/56');
    expect(ipRateKey('5.160.1.2')).toBe('5.160.1.2');
  });
});

describe('H3 cells', () => {
  const tehran = { lat: 35.6892, lng: 51.389 };

  it('keeps a position as its r7 cell, in the database form', () => {
    const cell = homeCell(tehran);
    expect(cell).toMatch(/^[0-9]{18}$/);
    expect(cellResolution(cell)).toBe(7);
    expect(hexToCellId(cellIdToHex(cell))).toBe(cell);
    // The centre is within the cell's size of the position, never the position itself.
    const centre = cellCentre(cell);
    expect(Math.abs(centre.lat - tehran.lat) + Math.abs(centre.lng - tehran.lng)).toBeGreaterThan(0);
    expect(cellDistanceKm(cell, homeCell(centre))).toBe(0);
  });

  it('agrees with the SQL h3_parent for the deck resolutions', () => {
    const cell = BigInt(homeCell(tehran));
    for (const res of [5, 3]) {
      const sqlParent = (cell & ~(15n << 52n)) | (BigInt(res) << 52n) | ((1n << BigInt((15 - res) * 3)) - 1n);
      expect(parentCell(cell, res)).toBe(sqlParent.toString());
    }
    expect(() => parentCell(cell, 9)).toThrow(RangeError);
  });

  it('shows distances rounded, with a 2 km floor', () => {
    expect(shownDistance(0.3)).toEqual({ km: 2, lessThan: true });
    expect(shownDistance(7.4)).toEqual({ km: 7 });
    const istanbul = homeCell({ lat: 41.0082, lng: 28.9784 });
    expect(Math.round(cellDistanceKm(homeCell(tehran), istanbul) / 100)).toBe(20);
    expect(() => homeCell({ lat: 91, lng: 0 })).toThrow(RangeError);
    expect(() => cellIdToHex('12345')).toThrow(RangeError);
  });
});
