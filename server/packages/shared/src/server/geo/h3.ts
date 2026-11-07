import { cellArea, cellToLatLng, cellToParent, getResolution, gridDisk, isValidCell, latLngToCell } from 'h3-js';

/**
 * Locations are kept as H3 cells, never as coordinates: the API turns a
 * position into its resolution-7 cell (average edge 1.4 km) in memory and
 * keeps the cell and the cell's centre. Distances shown to others are
 * between cell centres and rounded, so the most anyone can learn by probing
 * is the cell.
 *
 * h3-js speaks hexadecimal strings; PostgreSQL stores cells as `bigint`
 * (see migration 0001's h3_* helpers), so the database form here is the
 * decimal string of the same 64-bit value.
 */

export const HOME_RESOLUTION = 7;
/** The deck's coarser search cells. */
export const DECK_RESOLUTIONS = [5, 3] as const;

export interface LatLng {
  lat: number;
  lng: number;
}

/** A cell as h3-js writes it (15 hex digits for these resolutions). */
export type H3Hex = string;

export function hexToCellId(hex: H3Hex): string {
  if (!isValidCell(hex)) throw new RangeError('not an H3 cell');
  return BigInt(`0x${hex}`).toString();
}

export function cellIdToHex(id: string | bigint): H3Hex {
  const value = typeof id === 'bigint' ? id : BigInt(id);
  if (value <= 0n || value >= 1n << 63n) throw new RangeError('not an H3 cell');
  const hex = value.toString(16);
  if (!isValidCell(hex)) throw new RangeError('not an H3 cell');
  return hex;
}

export function isValidPosition({ lat, lng }: LatLng): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

/** The resolution-7 cell of a position, as the database stores it. The position itself is not kept. */
export function homeCell(position: LatLng): string {
  if (!isValidPosition(position)) throw new RangeError('not a position');
  return hexToCellId(latLngToCell(position.lat, position.lng, HOME_RESOLUTION));
}

/** The centre of a cell: the only point of a person the server keeps. */
export function cellCentre(cell: string | bigint): LatLng {
  const [lat, lng] = cellToLatLng(cellIdToHex(cell));
  return { lat, lng };
}

export function cellResolution(cell: string | bigint): number {
  return getResolution(cellIdToHex(cell));
}

/** The parent at a coarser resolution (`h3_parent()` in SQL computes the same). */
export function parentCell(cell: string | bigint, resolution: number): string {
  const hex = cellIdToHex(cell);
  if (resolution > getResolution(hex)) throw new RangeError('a parent must be coarser');
  return hexToCellId(cellToParent(hex, resolution));
}

/** The cells within `k` rings of a cell (the cell itself included), as the database stores them. */
export function cellDisk(cell: string | bigint, k: number): string[] {
  if (!Number.isInteger(k) || k < 0) throw new RangeError('k must be a non-negative integer');
  return gridDisk(cellIdToHex(cell), k).map(hexToCellId);
}

/** The edge of a regular hexagon with this cell's area, in km (cells differ in size across the globe). */
export function cellEdgeKm(cell: string | bigint): number {
  return Math.sqrt((2 * cellArea(cellIdToHex(cell), 'km2')) / (3 * Math.sqrt(3)));
}

const EARTH_RADIUS_KM = 6371.0088;

/** Great-circle distance in kilometres. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Distance between two cells' centres, in kilometres. */
export function cellDistanceKm(a: string | bigint, b: string | bigint): number {
  return haversineKm(cellCentre(a), cellCentre(b));
}

/** Below this the card shows "less than 2 km": closer distances are not resolved by r7 cells. */
export const DISTANCE_FLOOR_KM = 2;

/** The distance as a card shows it: `{ km: 2, lessThan: true }` below the floor, else whole kilometres. */
export function shownDistance(km: number): { km: number; lessThan?: true } {
  if (!Number.isFinite(km) || km < 0) throw new RangeError('not a distance');
  if (km < DISTANCE_FLOOR_KM) return { km: DISTANCE_FLOOR_KM, lessThan: true };
  return { km: Math.round(km) };
}
