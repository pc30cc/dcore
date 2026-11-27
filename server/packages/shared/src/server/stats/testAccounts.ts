/**
 * The raw ids of test accounts (users.flags & 1), held by the worker so the
 * statistics leave them out without reading users per job: loaded through
 * `load` (one statement on users_test_idx) and kept `maxAgeMs`. A reload that
 * fails keeps the last good set; `has` answers from the set already loaded
 * (empty before the first load) and starts a reload when it is stale.
 */
export class TestAccounts {
  private readonly load: () => Promise<readonly string[]>;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private set: ReadonlySet<string> = new Set();
  private list: readonly string[] = [];
  private loadedAt: number | null = null;
  private loading: Promise<readonly string[]> | null = null;
  private readonly onError: (error: unknown) => void;

  constructor(options: {
    load: () => Promise<readonly string[]>;
    maxAgeMs?: number | undefined;
    now?: (() => number) | undefined;
    onError?: ((error: unknown) => void) | undefined;
  }) {
    this.load = options.load;
    this.maxAgeMs = options.maxAgeMs ?? 600_000;
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? (() => undefined);
  }

  private stale(): boolean {
    return this.loadedAt === null || this.now() - this.loadedAt >= this.maxAgeMs;
  }

  /** The ids, reloaded first when stale (a failed reload answers the last good set). */
  async ids(): Promise<readonly string[]> {
    if (!this.stale()) return this.list;
    this.loading ??= this.load()
      .then((ids) => {
        this.list = [...ids];
        this.set = new Set(ids);
        this.loadedAt = this.now();
        return this.list;
      })
      .catch((error: unknown) => {
        this.onError(error);
        return this.list;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  /** Whether a load has succeeded once (before that `has` knows no test account). */
  get loaded(): boolean {
    return this.loadedAt !== null;
  }

  /** Whether `uid` is a test account, from the set already loaded. */
  has(uid: string): boolean {
    if (this.stale() && this.loading === null) void this.ids();
    return this.set.has(uid);
  }
}
