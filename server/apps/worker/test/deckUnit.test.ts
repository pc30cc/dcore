import { cellCentre, haversineKm, homeCell, parentCell } from '@app/shared/server';
import { describe, expect, it } from 'vitest';
import { compileFilters, passesFilters } from '../src/deck/filters.js';
import { diversify, inboundLoad, intentOverlap, jaccard, proximity, recency, scoreOf, type ScoreInput } from '../src/deck/score.js';
import { decodePoolCursor, deckArea, deckSeed, diskRings, encodePoolCursor, searchFingerprint } from '../src/deck/search.js';
import { DEFAULT_WEIGHTS, planHas, type DeckSettings, type FilterField } from '../src/deck/settings.js';

/** Pure parts of the deck worker: the search cells, filters, the score and the diversity pass. */

function destination(from: { lat: number; lng: number }, km: number, bearingDeg: number): { lat: number; lng: number } {
  const r = 6371.0088;
  const d = km / r;
  const b = (bearingDeg * Math.PI) / 180;
  const lat1 = (from.lat * Math.PI) / 180;
  const lng1 = (from.lng * Math.PI) / 180;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lng2 = lng1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: (lat2 * 180) / Math.PI, lng: (((lng2 * 180) / Math.PI + 540) % 360) - 180 };
}

/** A small deterministic generator (tests must not depend on Math.random). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('the search cells', () => {
  it('follow the documented ring counts at the average edge (30 km: 3 rings, 60 km: 5)', () => {
    expect(diskRings(30, 9.854)).toBe(3);
    expect(diskRings(60, 9.854)).toBe(5);
    expect(diskRings(400, 68.98)).toBe(4);
  });

  it('cover every cell whose centre is within the radius, at r5 up to 60 km and r3 beyond, anywhere', () => {
    const random = rng(7);
    const places = [
      { lat: 41.015, lng: 28.979 },
      { lat: 35.689, lng: 51.389 },
      { lat: 59.33, lng: 18.07 },
      { lat: -33.87, lng: 151.21 },
      { lat: 64.15, lng: -21.94 },
      { lat: 1.29, lng: 103.85 },
    ];
    for (const place of places) {
      for (const radiusKm of [5, 20, 50, 60, 61, 150, 400]) {
        const viewer = homeCell(destination(place, random() * 20, random() * 360));
        const area = deckArea(viewer, radiusKm, false);
        expect(area.res).toBe(radiusKm <= 60 ? 5 : 3);
        expect(area.radiusM).toBe(radiusKm * 1_000);
        const cells = new Set(area.cells);
        const centre = cellCentre(viewer);
        for (let i = 0; i < 400; i += 1) {
          const point = destination(centre, radiusKm * Math.sqrt(random()) * 1.02, random() * 360);
          const cell = homeCell(point);
          if (haversineKm(centre, cellCentre(cell)) > radiusKm) continue;
          expect(cells.has(parentCell(cell, area.res)), `${place.lat},${place.lng} r=${radiusKm}`).toBe(true);
        }
      }
    }
  });

  it('searches the whole country without cells or a cut, and measures from the viewer cell centre', () => {
    const viewer = homeCell({ lat: 35.7, lng: 51.4 });
    expect(deckArea(viewer, 50, true)).toEqual({ res: 0, cells: [], center: cellCentre(viewer), radiusM: null, k: 0 });
    expect(() => deckArea(viewer, 0, false)).toThrow();
  });

  it('seeds every viewer and day differently, and the same within a day', () => {
    expect(deckSeed('1', '20261107')).toBe(deckSeed('1', '20261107'));
    expect(deckSeed('1', '20261107')).not.toBe(deckSeed('2', '20261107'));
    expect(deckSeed('1', '20261107')).not.toBe(deckSeed('1', '20261108'));
    const seed = BigInt(deckSeed('1', '20261107'));
    expect(seed >= -(2n ** 63n) && seed < 2n ** 63n).toBe(true);
  });

  it('keeps a pool cursor only for the search it was made in', () => {
    const viewer = homeCell({ lat: 41, lng: 29 });
    const area = deckArea(viewer, 30, false);
    const fp = searchFingerprint('20261107', area, viewer, 'TR');
    expect(fp).toHaveLength(12);
    expect(searchFingerprint('20261108', area, viewer, 'TR')).not.toBe(fp);
    expect(searchFingerprint('20261107', deckArea(viewer, 31, false), viewer, 'TR')).not.toBe(fp);
    const text = encodePoolCursor({ fingerprint: fp, activeOn: '2026-11-07', tie: '-922337203685477580' });
    expect(decodePoolCursor(text)).toEqual({ fingerprint: fp, activeOn: '2026-11-07', tie: '-922337203685477580' });
    for (const bad of [null, '', 'x|2026-11-07|1', `${fp}|2026-11|1`, `${fp}|2026-11-07|1.5`]) expect(decodePoolCursor(bad)).toBeNull();
  });
});

describe('advanced filters', () => {
  const fields = new Map<string, FilterField>([
    ['smoking', { kind: 'choice', slot: 3 }],
    ['languages', { kind: 'choice', slot: 4 }],
    ['height', { kind: 'height' }],
  ]);

  it('need one wanted option of every filtered field, and a height inside the range', () => {
    const filters = compileFilters({ smoking: [1, 2], languages: [7], height: [170, 160] }, fields);
    expect(passesFilters({ attrs: [3 * 256 + 2, 4 * 256 + 7], heightCm: 165 }, filters)).toBe(true);
    expect(passesFilters({ attrs: [3 * 256 + 3, 4 * 256 + 7], heightCm: 165 }, filters)).toBe(false);
    expect(passesFilters({ attrs: [3 * 256 + 1], heightCm: 165 }, filters)).toBe(false);
    expect(passesFilters({ attrs: [3 * 256 + 1, 4 * 256 + 7], heightCm: 171 }, filters)).toBe(false);
    // Unanswered is not a match.
    expect(passesFilters({ attrs: [3 * 256 + 1, 4 * 256 + 7], heightCm: null }, filters)).toBe(false);
  });

  it('ignore fields the catalogue no longer offers as filters, and empty lists', () => {
    const filters = compileFilters({ gone: [1], smoking: [] }, fields);
    expect(filters).toEqual([]);
    expect(passesFilters({ attrs: [], heightCm: null }, filters)).toBe(true);
  });
});

describe('the score', () => {
  const base: ScoreInput = {
    userId: '1',
    distanceKm: 10,
    idleDays: 0,
    completeness: 80,
    verified: false,
    newcomer: false,
    liker: false,
    boosted: false,
    pendingLikes: 0,
    attrs: [],
    intents: 0,
    ageBand: 6,
    cityId: 1,
  };
  const ctx = { weights: DEFAULT_WEIGHTS, radiusKm: 50, viewerAttrs: [5, 6, 7], viewerIntents: 2 };

  it('has parts in [0, 1]', () => {
    expect(proximity(0, 50)).toBe(1);
    expect(proximity(50, 50)).toBe(0);
    expect(proximity(80, 50)).toBe(0);
    expect(proximity(50, null)).toBe(0.5);
    expect(proximity(null, 50)).toBe(0);
    expect(recency(0)).toBe(1);
    expect(recency(2)).toBe(0.5);
    expect(inboundLoad(0)).toBe(0);
    expect(inboundLoad(999)).toBeCloseTo(1, 5);
    expect(inboundLoad(1e9)).toBe(1);
    expect(jaccard([1, 2], [2, 3])).toBeCloseTo(1 / 3);
    expect(jaccard([], [])).toBe(0);
    expect(intentOverlap(2 | 4, 4)).toBe(0.5);
    expect(intentOverlap(0, 4)).toBe(0);
  });

  it('prefers near, active, complete, verified, new, boosted people who liked the viewer, and spreads attention', () => {
    const s = (patch: Partial<ScoreInput>) => scoreOf({ ...base, ...patch }, ctx);
    const plain = s({});
    expect(s({ distanceKm: 2 })).toBeGreaterThan(plain);
    expect(s({ idleDays: 10 })).toBeLessThan(plain);
    expect(s({ completeness: 100 })).toBeGreaterThan(plain);
    expect(s({ verified: true })).toBeGreaterThan(plain);
    expect(s({ newcomer: true })).toBeGreaterThan(plain);
    expect(s({ boosted: true })).toBeGreaterThan(plain);
    expect(s({ liker: true })).toBeGreaterThan(plain);
    expect(s({ attrs: [5, 6] })).toBeGreaterThan(plain);
    expect(s({ pendingLikes: 500 })).toBeLessThan(plain);
    // The panel's weights decide: without the distance weight, distance changes nothing.
    const noDistance = { ...ctx, weights: { ...DEFAULT_WEIGHTS, dist: 0 } };
    expect(scoreOf({ ...base, distanceKm: 2 }, noDistance)).toBe(scoreOf(base, noDistance));
  });

  it('does not put very similar people one after the other when others are close in score', () => {
    const people: { input: ScoreInput; score: number }[] = [];
    for (let i = 0; i < 6; i += 1) people.push({ input: { ...base, userId: `a${i}`, ageBand: 5, cityId: 1, attrs: [1, 2] }, score: 1 - i * 0.01 });
    for (let i = 0; i < 6; i += 1) people.push({ input: { ...base, userId: `b${i}`, ageBand: 8, cityId: 2, attrs: [9] }, score: 0.95 - i * 0.01 });
    const order = diversify(people).map((p) => p.userId);
    expect(order).toHaveLength(12);
    expect(new Set(order).size).toBe(12);
    let runs = 0;
    const group = (id: string) => (id.startsWith('a') ? 'a' : 'b');
    for (let i = 1; i < order.length; i += 1) if (group(order[i]!) === group(order[i - 1]!)) runs += 1;
    expect(runs).toBeLessThanOrEqual(2);
    // A clearly better person still comes first.
    const lone = diversify([...people, { input: { ...base, userId: 'top', ageBand: 5, cityId: 1, attrs: [1, 2] }, score: 5 }]);
    expect(lone[0]!.userId).toBe('top');
  });
});

describe('plans', () => {
  const settings = {
    plans: [
      { id: 1, key: 'free', rank: 0, features: { see_likes: false } },
      { id: 2, key: 'plus', rank: 1, features: { see_likes: false } },
      { id: 3, key: 'premium', rank: 2, features: { see_likes: true } },
    ],
  } as unknown as DeckSettings;

  it('read a feature from the best plan held, the free plan without one', () => {
    expect(planHas(settings, [], 'see_likes')).toBe(false);
    expect(planHas(settings, [2], 'see_likes')).toBe(false);
    expect(planHas(settings, [2, 3], 'see_likes')).toBe(true);
  });
});
