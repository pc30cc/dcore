/**
 * CSV built in the browser from rows the page already holds (aggregates
 * only): UTF-8 with a byte order mark (spreadsheet programs then read
 * Persian text), CRLF line ends, RFC 4180 quoting, and a text cell that a
 * spreadsheet would run as a formula (= + - @, a tab or a carriage return
 * first) led by an apostrophe. Numbers are written as numbers.
 */

export type CsvCell = string | number | null;

const FORMULA = /^[=+\-@\t\r]/;

function cellText(cell: CsvCell): string {
  if (cell === null) return '';
  if (typeof cell === 'number') return Number.isFinite(cell) ? String(cell) : '';
  const guarded = FORMULA.test(cell) ? `'${cell}` : cell;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function csvText(header: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  return [header, ...rows].map((row) => row.map(cellText).join(',')).join('\r\n') + '\r\n';
}

export function csvBlob(header: readonly string[], rows: readonly (readonly CsvCell[])[]): Blob {
  return new Blob(['﻿', csvText(header, rows)], { type: 'text/csv;charset=utf-8' });
}
