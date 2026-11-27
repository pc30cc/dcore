import { asciiDigits } from './format';

/**
 * The Solar Hijri (Jalali) calendar of the Persian panel, for the days an
 * admin types: conversion to and from the Gregorian ISO days (`YYYY-MM-DD`)
 * the API and the rest of the panel use. The arithmetic is the jalaali
 * algorithm (Borkowski's leap years, with the breaks of the 33-year cycles);
 * a test holds it to the browser's own Persian calendar (Intl, `fa`) day by
 * day, so what the panel shows and what it reads agree.
 */

export interface JalaliDay {
  /** Year, e.g. 1405. */
  y: number;
  /** Month, 1 (Farvardin) to 12 (Esfand). */
  m: number;
  /** Day of the month, 1 to 31. */
  d: number;
}

const BREAKS = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];

const div = (a: number, b: number) => Math.trunc(a / b);
const mod = (a: number, b: number) => a - Math.trunc(a / b) * b;

/** The year's leap position (0: a leap year), its Gregorian year and the March day Farvardin 1 falls on. */
function jalCal(jy: number): { leap: number; gy: number; march: number } {
  const gy = jy + 621;
  let leapJ = -14;
  let jp = BREAKS[0]!;
  let jump = 0;
  for (let i = 1; i < BREAKS.length; i += 1) {
    const jm = BREAKS[i]!;
    jump = jm - jp;
    if (jy < jm) break;
    leapJ += div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }
  let n = jy - jp;
  leapJ += div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;
  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;
  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  let leap = mod(mod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;
  return { leap, gy, march };
}

/** The Julian day number of a Gregorian day. */
function g2d(gy: number, gm: number, gd: number): number {
  const d = div((gy + div(gm - 8, 6) + 100100) * 1461, 4) + div(153 * mod(gm + 9, 12) + 2, 5) + gd - 34840408;
  return d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
}

function d2g(jdn: number): { gy: number; gm: number; gd: number } {
  let j = 4 * jdn + 139361631;
  j += div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = div(mod(j, 1461), 4) * 5 + 308;
  const gd = div(mod(i, 153), 5) + 1;
  const gm = mod(div(i, 153), 12) + 1;
  const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
  return { gy, gm, gd };
}

function j2d(day: JalaliDay): number {
  const r = jalCal(day.y);
  return g2d(r.gy, 3, r.march) + (day.m - 1) * 31 - div(day.m, 7) * (day.m - 7) + day.d - 1;
}

function d2j(jdn: number): JalaliDay {
  const { gy } = d2g(jdn);
  let y = gy - 621;
  const r = jalCal(y);
  let k = jdn - g2d(gy, 3, r.march);
  if (k >= 0) {
    if (k <= 185) return { y, m: 1 + div(k, 31), d: mod(k, 31) + 1 };
    k -= 186;
  } else {
    y -= 1;
    k += 179;
    if (r.leap === 1) k += 1;
  }
  return { y, m: 7 + div(k, 30), d: mod(k, 30) + 1 };
}

/** The years the arithmetic covers (well beyond any day an admin types). */
export const JALALI_MIN_YEAR = 1;
export const JALALI_MAX_YEAR = 3177;

export function isJalaliLeapYear(y: number): boolean {
  return jalCal(y).leap === 0;
}

export function jalaliMonthLength(y: number, m: number): number {
  if (m <= 6) return 31;
  if (m <= 11) return 30;
  return isJalaliLeapYear(y) ? 30 : 29;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** A Gregorian ISO day (`YYYY-MM-DD`) as a Jalali day; null for anything else. */
export function isoDayToJalali(iso: string): JalaliDay | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const [gy, gm, gd] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(gy, gm - 1, gd));
  if (date.getUTCFullYear() !== gy || date.getUTCMonth() !== gm - 1 || date.getUTCDate() !== gd) return null;
  return d2j(g2d(gy, gm, gd));
}

/** A Jalali day as a Gregorian ISO day; null when it is not a day of the calendar. */
export function jalaliToIsoDay(day: JalaliDay): string | null {
  if (!Number.isInteger(day.y) || !Number.isInteger(day.m) || !Number.isInteger(day.d)) return null;
  if (day.y < JALALI_MIN_YEAR || day.y > JALALI_MAX_YEAR || day.m < 1 || day.m > 12 || day.d < 1 || day.d > jalaliMonthLength(day.y, day.m)) return null;
  const g = d2g(j2d(day));
  return `${pad(g.gy, 4)}-${pad(g.gm, 2)}-${pad(g.gd, 2)}`;
}

/**
 * A day typed as year/month/day in the Jalali calendar ("1405/9/6",
 * «۱۴۰۵/۰۹/۰۶», "1405-09-06", "1405.9.6": Persian, Arabic-Indic or Latin
 * digits), as a Gregorian ISO day; null for anything else.
 */
export function parseJalaliDay(text: string): string | null {
  const match = /^\s*(\d{4})\s*[/\-.٫،]\s*(\d{1,2})\s*[/\-.٫،]\s*(\d{1,2})\s*$/.exec(asciiDigits(text));
  if (!match) return null;
  const y = Number(match[1]);
  // A Gregorian year typed by habit (2026) is not taken for a Solar Hijri one.
  if (y < TYPED_YEARS.min || y > TYPED_YEARS.max) return null;
  return jalaliToIsoDay({ y, m: Number(match[2]), d: Number(match[3]) });
}

/** The years a typed day may have (1921 to 2121 in the Gregorian calendar). */
export const TYPED_YEARS = { min: 1300, max: 1499 } as const;

/** A Gregorian ISO day as the Jalali text of a date field («۱۴۰۵/۰۹/۰۶» in Persian digits); '' for anything else. */
export function formatJalaliDay(iso: string, digits: Intl.NumberFormat = PERSIAN_DIGITS): string {
  const day = isoDayToJalali(iso);
  if (!day) return '';
  const two = (value: number) => digits.format(value).padStart(2, digits.format(0));
  return `${digits.format(day.y)}/${two(day.m)}/${two(day.d)}`;
}

const PERSIAN_DIGITS = new Intl.NumberFormat('fa', { useGrouping: false, maximumFractionDigits: 0 });
