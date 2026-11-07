import { createHash } from 'node:crypto';
import { cellCentre, cellDisk, cellEdgeKm, parentCell, type LatLng } from '@app/shared/server';

/**
 * Where a refill looks: the cells covering the viewer's radius, computed
 * with h3-js (`gridDisk` of the viewer's parent cell), the exact cut on cell
 * centres that the query applies after the coarse cell match, and the
 * viewer's seed of the day for the shuffled order.
 *
 * Up to 60 km the disk is of resolution-5 cells (edge ~9.9 km), beyond it of
 * resolution-3 cells (edge ~69 km); "whole country" searches the country.
 * The disk's size is `k = ceil((radius + e) / (√3 · e))` (docs/16 §10.2),
 * with `e` the edge of the viewer's own parent cell (from its area) shrunk
 * by a safety margin: H3 cells are not all the same size, and a disk built
 * from the global average edge could stop short of the radius where cells
 * are small. The query cuts at the radius exactly (`ST_DWithin`), so a
 * slightly larger disk costs a few more index entries and never a wrong
 * candidate.
 */

export const R5_MAX_RADIUS_KM = 60;
/** The disk's edge is this fraction of the local cell's edge. */
const EDGE_MARGIN = 0.85;

export interface DeckArea {
  /** 5 or 3 (cells of that resolution), 0 (the whole country). */
  res: 0 | 3 | 5;
  /** The disk's cells as the database stores them (decimal); empty for the whole country. */
  cells: string[];
  /** The viewer's cell centre (distances are measured from it, also for the whole country). */
  center: LatLng;
  /** The exact cut; null for the whole country. */
  radiusM: number | null;
  /** The disk's radius in rings (0 for the whole country). */
  k: number;
}

export function diskRings(radiusKm: number, edgeKm: number): number {
  return Math.max(1, Math.ceil((radiusKm + edgeKm) / (Math.sqrt(3) * edgeKm)));
}

/** The search of a viewer at `cell` (r7, decimal) for a radius or the whole country. */
export function deckArea(cell: string, radiusKm: number, wholeCountry: boolean): DeckArea {
  const center = cellCentre(cell);
  if (wholeCountry) return { res: 0, cells: [], center, radiusM: null, k: 0 };
  if (!Number.isFinite(radiusKm) || radiusKm <= 0) throw new RangeError('the radius must be positive');
  const res = radiusKm <= R5_MAX_RADIUS_KM ? 5 : 3;
  const parent = parentCell(cell, res);
  const k = diskRings(radiusKm, cellEdgeKm(parent) * EDGE_MARGIN);
  return { res, cells: cellDisk(parent, k), center, radiusM: Math.round(radiusKm * 1_000), k };
}

/** The viewer's seed of the day: a signed 64-bit integer (as PostgreSQL's `hashint8extended` takes it). */
export function deckSeed(viewerId: string, day: string): string {
  const digest = createHash('sha256').update(`deck-seed:${viewerId}:${day}`).digest();
  return BigInt.asIntN(64, digest.readBigUInt64BE(0)).toString();
}

/**
 * A short fingerprint of a search: a cursor of the pool order is only valid
 * for the same day (seed), cells and radius.
 */
export function searchFingerprint(day: string, area: DeckArea, cell: string, country: string): string {
  return createHash('sha256').update(`${day}|${area.res}|${cell}|${area.radiusM ?? 'all'}|${country}`).digest('base64url').slice(0, 12);
}

export interface PoolCursor {
  fingerprint: string;
  activeOn: string;
  tie: string;
}

const CURSOR = /^([A-Za-z0-9_-]{12})\|(\d{4}-\d{2}-\d{2})\|(-?\d{1,19})$/;

export function encodePoolCursor(cursor: PoolCursor): string {
  return `${cursor.fingerprint}|${cursor.activeOn}|${cursor.tie}`;
}

export function decodePoolCursor(text: string | null): PoolCursor | null {
  const m = text ? CURSOR.exec(text) : null;
  return m ? { fingerprint: m[1]!, activeOn: m[2]!, tie: m[3]! } : null;
}
