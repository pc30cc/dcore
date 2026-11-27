/**
 * "Active today" marks of one process: whether a person was already put in
 * `la:<yyyymmdd>` this UTC day, so a person costs one Valkey command per
 * process per day. The set is dropped on a new day, and when it reaches
 * `cap` (a later request marks again: SADD is idempotent).
 */
export class DailyMarks {
  private day = '';
  private seen = new Set<string>();
  private readonly cap: number;

  constructor(options: { cap?: number | undefined } = {}) {
    this.cap = options.cap ?? 200_000;
  }

  /** True the first time `uid` is seen on `day` in this process. */
  mark(day: string, uid: string): boolean {
    if (day !== this.day) {
      this.day = day;
      this.seen = new Set();
    }
    if (this.seen.has(uid)) return false;
    if (this.seen.size >= this.cap) this.seen = new Set();
    this.seen.add(uid);
    return true;
  }

  /** After a failed write: the next request of `uid` marks again. */
  forget(day: string, uid: string): void {
    if (day === this.day) this.seen.delete(uid);
  }

  get size(): number {
    return this.seen.size;
  }
}

/** How long `la:<yyyymmdd>` is kept: the drain (00:23 UTC) and the rollup (00:41) read yesterday's, a missed night is caught up once. */
export const ACTIVE_DAY_TTL_SECONDS = 3 * 86_400;
