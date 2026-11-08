import { randomBytes } from 'node:crypto';
import { applyModeration, blockUser, createMatch, createPool, type Pool, type PoolClient } from '@app/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureGroupRoles, hasDatabase, loginRole, migratedDatabase, type TestDatabase } from './db.js';

/**
 * A match and a block, a ban or a deletion of the same people at the same
 * moment (migration 0017): whichever commits first, the other sees it, so
 * a blocked pair never keeps an active match and a banned person never
 * gets a new one. Each race holds one side's transaction open and checks
 * that the other waits for it instead of passing it.
 */

const quietMs = 300;

describe.skipIf(!hasDatabase)('a match racing a block, a ban or a deletion (PostgreSQL)', () => {
  let db: TestDatabase;
  let pg: Pool;
  let role: Awaited<ReturnType<typeof loginRole>>;
  let next = BigInt(`${Date.now()}`) * 1_000n;
  const id = () => String((next += 1n));

  beforeAll(async () => {
    await ensureGroupRoles();
    role = await loginRole(['app_rw']);
    db = await migratedDatabase();
    pg = createPool({ connectionString: db.urlFor(role.name, role.password), applicationName: `race-${randomBytes(2).toString('hex')}`, max: 6 });
  }, 90_000);

  afterAll(async () => {
    await pg?.end();
    await db?.drop();
    await role?.drop();
  });

  async function person(): Promise<string> {
    const uid = id();
    await db.admin.query(`INSERT INTO users (id, status, birth_date, gender, country, onboarding_step) VALUES ($1, 3, DATE '1995-02-03', 2, 'IR', 30)`, [uid]);
    await db.admin.query(`INSERT INTO profiles (user_id, display_name) VALUES ($1, 'Sam')`, [uid]);
    return uid;
  }

  async function state(a: string, b: string): Promise<number | null> {
    const { rows } = await db.admin.query<{ state: number }>(
      `SELECT state FROM matches WHERE user_lo = least($1::bigint, $2::bigint) AND user_hi = greatest($1::bigint, $2::bigint)`,
      [a, b],
    );
    return rows[0]?.state ?? null;
  }

  /** Runs `first` in a transaction left open, starts `second`, checks that it waits, then commits `first`. */
  async function race<T>(first: (tx: PoolClient) => Promise<unknown>, second: () => Promise<T>): Promise<T> {
    const tx = await pg.connect();
    try {
      await tx.query('BEGIN');
      await first(tx);
      let settled = false;
      const pending = second().finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, quietMs));
      expect(settled, 'the second writer must wait for the first one').toBe(false);
      await tx.query('COMMIT');
      return await pending;
    } catch (error) {
      await tx.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      tx.release();
    }
  }

  it('ends a match whose INSERT was in flight when the block came', async () => {
    const [a, b] = [await person(), await person()];
    const matchId = id();
    const outcome = await race(
      (tx) => createMatch(tx, { matchId, actorId: a, targetId: b, source: 1 }),
      () => blockUser(pg, b, a),
    );
    expect(outcome).toMatchObject({ found: true, endedNow: true, match: { matchId, state: 3 } });
    expect(await state(a, b)).toBe(3);
  });

  it('makes no match for a pair whose block was in flight', async () => {
    const [a, b] = [await person(), await person()];
    const row = await race(
      (tx) => blockUser(tx, b, a),
      () => createMatch(pg, { matchId: id(), actorId: a, targetId: b, source: 1 }),
    );
    expect(row).toBeNull();
    expect(await state(a, b)).toBeNull();
  });

  it('makes no match with a person whose ban was in flight, and the ban ends a match that was', async () => {
    const [a, b] = [await person(), await person()];
    const banned = await race(
      (tx) => applyModeration(tx, { actionId: id(), userId: b, kind: 3, reasonCode: 1, reasonText: 'Spam' }),
      () => createMatch(pg, { matchId: id(), actorId: a, targetId: b, source: 1 }),
    );
    expect(banned).toBeNull();
    expect(await state(a, b)).toBeNull();

    const [c, d] = [await person(), await person()];
    const matchId = id();
    const outcome = await race(
      (tx) => createMatch(tx, { matchId, actorId: c, targetId: d, source: 1 }),
      () => applyModeration(pg, { actionId: id(), userId: d, kind: 3, reasonCode: 1, reasonText: 'Spam' }),
    );
    expect(outcome).toMatchObject({ outcome: 'applied', ended: [{ matchId }] });
    expect(await state(c, d)).toBe(4);
  });

  it('makes no match with a person whose deletion was in flight', async () => {
    const [a, b] = [await person(), await person()];
    const row = await race(
      (tx) => tx.query(`UPDATE users SET status = 7, restore_status = status, deleted_at = now() WHERE id = $1`, [b]),
      () => createMatch(pg, { matchId: id(), actorId: a, targetId: b, source: 1 }),
    );
    expect(row).toBeNull();
    expect(await state(a, b)).toBeNull();
  });

  it('still answers the pair\'s existing match to the second of two writers of the same match', async () => {
    const [a, b] = [await person(), await person()];
    const matchId = id();
    const row = await race(
      (tx) => createMatch(tx, { matchId, actorId: a, targetId: b, source: 1 }),
      () => createMatch(pg, { matchId: id(), actorId: b, targetId: a, source: 1 }),
    );
    expect(row).toMatchObject({ id: matchId, created: false, state: 1 });
  });
});
