import { idParts } from '../../ids.js';

/** The cohorts a day's active set measures: people who signed up 1, 7 and 30 days before it. */
export const RETENTION_DAYS = [1, 7, 30] as const;

const DAY_MS = 86_400_000;
const ID = /^[1-9][0-9]{0,18}$/;

export interface ActiveBuckets {
  /** Active people of the day, test accounts and members that are not ids left out. */
  dau: number;
  /** Of them, those who signed up `k` days before `day` (UTC), by k. */
  cohorts: { d1: number; d7: number; d30: number };
}

/** The UTC day number (days since 1970) an id was minted. */
function idDay(id: string): number {
  return Math.floor(idParts(id).ms / DAY_MS);
}

/**
 * Counts one day's active ids (`la:<day>` members) and buckets them by the
 * day their account was created, which the id carries: no read of users.
 * `day` is `YYYY-MM-DD`.
 */
export function bucketActive(ids: Iterable<string>, day: string, isTest: (uid: string) => boolean): ActiveBuckets {
  const dayNumber = Math.floor(Date.parse(`${day}T00:00:00.000Z`) / DAY_MS);
  const result: ActiveBuckets = { dau: 0, cohorts: { d1: 0, d7: 0, d30: 0 } };
  for (const id of ids) {
    if (!ID.test(id) || isTest(id)) continue;
    let created: number;
    try {
      created = idDay(id);
    } catch {
      continue;
    }
    result.dau += 1;
    const age = dayNumber - created;
    if (age === 1) result.cohorts.d1 += 1;
    else if (age === 7) result.cohorts.d7 += 1;
    else if (age === 30) result.cohorts.d30 += 1;
  }
  return result;
}
