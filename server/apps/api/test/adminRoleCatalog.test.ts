import type { Pool } from '@app/db';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminRoleCatalog } from '../src/admin/roles.js';

/**
 * The roles in memory: a load asked for while one runs runs once more after
 * it (and its caller waits for that one), a failed load is tried again with
 * a backoff until it succeeds, and the catalogue remembers the configuration
 * version it loaded for.
 */

interface Pending {
  resolve(rows: unknown[]): void;
  reject(error: Error): void;
}

function fakePool() {
  const pending: Pending[] = [];
  let grants = ['users.read'];
  const pool = {
    query: () =>
      new Promise((resolve, reject) => {
        const snapshot = [...grants];
        pending.push({
          resolve: (rows) => resolve({ rows: rows.length > 0 ? rows : [{ id: 4, key: 'support', names: {}, grants: snapshot }], rowCount: 1 }),
          reject,
        });
      }),
  } as unknown as Pool;
  return {
    pool,
    pending,
    setGrants(next: string[]) {
      grants = next;
    },
  };
}

const log = pino({ level: 'silent' });
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('the role catalogue', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs one more load for a request made during a load, and the caller waits for it', async () => {
    const fake = fakePool();
    const roles = new AdminRoleCatalog({ pool: fake.pool, log });
    const first = roles.reload(3);
    await tick();
    expect(fake.pending).toHaveLength(1);
    // The change is committed while the first load has read the rows already.
    fake.setGrants(['users.read', 'campaigns.read']);
    let secondDone = false;
    const second = roles.reload(4).then(() => {
      secondDone = true;
    });
    const third = roles.reload(5);
    fake.pending[0]!.resolve([{ id: 4, key: 'support', names: {}, grants: ['users.read'] }]);
    await first;
    expect(roles.current()?.get('support')?.grants).toEqual(['users.read']);
    expect(secondDone).toBe(false);
    await tick();
    // One more load (not two), which reads the committed change.
    expect(fake.pending).toHaveLength(2);
    fake.pending[1]!.resolve([]);
    await Promise.all([second, third]);
    expect(roles.current()?.get('support')?.grants).toEqual(['users.read', 'campaigns.read']);
    expect(roles.state()).toMatchObject({ version: 5, failing: false });
    roles.stop();
  });

  it('tries a failed load again with a backoff until one succeeds, and tells its listeners', async () => {
    vi.useFakeTimers();
    const fake = fakePool();
    const roles = new AdminRoleCatalog({ pool: fake.pool, log });
    const loaded: (number | null)[] = [];
    roles.onLoaded((state) => loaded.push(state.version));
    const first = roles.reload(7);
    fake.pending[0]!.reject(new Error('connection refused'));
    await first;
    expect(roles.current()).toBeNull();
    expect(roles.state().failing).toBe(true);
    await vi.advanceTimersByTimeAsync(499);
    expect(fake.pending).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.pending).toHaveLength(2);
    fake.pending[1]!.reject(new Error('connection refused'));
    await vi.advanceTimersByTimeAsync(999);
    expect(fake.pending).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.pending).toHaveLength(3);
    fake.pending[2]!.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(roles.current()?.get('support')).toBeDefined();
    expect(roles.state()).toMatchObject({ version: 7, failing: false });
    expect(loaded).toEqual([7]);
    roles.stop();
  });

  it('stops trying once stopped, and ignores grants this build does not know', async () => {
    vi.useFakeTimers();
    const fake = fakePool();
    const roles = new AdminRoleCatalog({ pool: fake.pool, log });
    const first = roles.reload();
    fake.pending[0]!.reject(new Error('down'));
    await first;
    roles.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.pending).toHaveLength(1);
    roles.set([{ id: 9, key: 'later', names: {}, grants: ['users.read', 'zzz.*', 'users.fly', '*'] }]);
    expect(roles.current()?.get('later')?.grants).toEqual(['users.read', '*']);
  });
});
