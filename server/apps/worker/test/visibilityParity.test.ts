import { accountStatus, canSee, canSeeCases, checkedContexts, listableCases, userListable, visibilityChange, visibleSubset, visibilityContext } from '@app/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasDatabase, migratedDatabase, type TestDatabase } from './db.js';

/**
 * The visibility rule has two homes: SQL (`user_listable`, `can_see`,
 * `visible_subset` of migration 0006, which every SQL list goes through)
 * and its TypeScript mirror (`@app/shared` visibility.ts, which the
 * zero-statement paths decide with). Both are checked here against the one
 * table of cases, and against each other over random pairs, on the real
 * migrations.
 */

const STATUSES = accountStatus.codes;

describe('the visibility case table (TypeScript)', () => {
  it('covers every account status with and without a shadowban, once each', () => {
    const seen = new Set(listableCases.map((c) => `${c.status}:${c.shadowbanned}`));
    expect(seen.size).toBe(listableCases.length);
    expect(seen.size).toBe(STATUSES.length * 2);
  });

  it('is what the mirror answers', () => {
    for (const c of listableCases) {
      const status = accountStatus.code(c.status);
      expect(userListable(status, c.shadowbanned, visibilityContext.discovery), `${c.status} ${c.shadowbanned} discovery`).toBe(c.discovery);
      expect(userListable(status, c.shadowbanned, visibilityContext.relationship), `${c.status} ${c.shadowbanned} relationship`).toBe(c.relationship);
      for (const ctx of checkedContexts.filter((x) => x !== 1 && x !== 2)) expect(userListable(status, c.shadowbanned, ctx)).toBe(false);
    }
    for (const c of canSeeCases) {
      const viewer = { id: '1', flags: c.viewer.test ? 1 : 0 };
      const target = {
        id: c.self ? '1' : '2',
        flags: c.target.test ? 1 : 0,
        status: accountStatus.code(c.target.status),
        shadowbanned: c.target.shadowbanned === true,
      };
      expect(canSee(viewer, target, c.block !== undefined, 1), `${c.name} discovery`).toBe(c.discovery);
      expect(canSee(viewer, target, c.block !== undefined, 2), `${c.name} relationship`).toBe(c.relationship);
    }
  });

  it('says what a change of state does to the lists of others', () => {
    const active = { status: 3, shadowbanned: false };
    expect(visibilityChange(active, { status: 6, shadowbanned: false })).toEqual({
      leftDiscovery: true,
      leftRelationships: true,
      joinedDiscovery: false,
      joinedRelationships: false,
    });
    // A snooze leaves discovery only: the person stays in their conversations.
    expect(visibilityChange(active, { status: 4, shadowbanned: false })).toMatchObject({ leftDiscovery: true, leftRelationships: false });
    expect(visibilityChange(active, { status: 3, shadowbanned: true })).toMatchObject({ leftDiscovery: true, leftRelationships: true });
    expect(visibilityChange({ status: 5, shadowbanned: false }, active)).toMatchObject({ joinedDiscovery: true, joinedRelationships: true });
    expect(visibilityChange(active, active)).toEqual({ leftDiscovery: false, leftRelationships: false, joinedDiscovery: false, joinedRelationships: false });
  });
});

describe.skipIf(!hasDatabase)('the visibility rule: SQL and its TypeScript mirror agree (PostgreSQL)', () => {
  let db: TestDatabase;
  let next = 0n;

  beforeAll(async () => {
    db = await migratedDatabase();
    next = BigInt((await db.admin.query<{ id: string }>('SELECT id_next()::text AS id')).rows[0]!.id);
  }, 90_000);
  afterAll(async () => {
    await db?.drop();
  });

  function newId(): string {
    next += 1n;
    return next.toString();
  }

  async function account(status: number, shadowbanned: boolean, test: boolean): Promise<string> {
    const id = newId();
    const purged = status === 8;
    await db.admin.query(
      `INSERT INTO users (id, status, birth_date, gender, country, deleted_at, is_shadowbanned, flags)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $2::smallint IN (7, 8) THEN now() END, $6, $7)`,
      [id, status, purged ? null : '1990-01-01', purged ? null : 1, purged ? null : 'TR', shadowbanned, test ? 1 : 0],
    );
    return id;
  }

  async function block(by: string, of: string): Promise<void> {
    const lo = BigInt(by) < BigInt(of) ? by : of;
    const hi = lo === by ? of : by;
    const bit = lo === by ? 1 : 2;
    await db.admin.query(
      `INSERT INTO blocks (user_lo, user_hi, blocked_by) VALUES ($1, $2, $3)
       ON CONFLICT (user_lo, user_hi) DO UPDATE SET blocked_by = blocks.blocked_by | EXCLUDED.blocked_by`,
      [lo, hi, bit],
    );
  }

  it('user_listable answers the case table for every status, shadowban and context', async () => {
    const rows = (
      await db.admin.query<{ s: number; b: boolean; c: number; v: boolean }>(
        `SELECT s, b, c, user_listable(s::smallint, b, c) AS v
           FROM unnest($1::int[]) AS s, unnest(ARRAY[false, true]) AS b, unnest($2::int[]) AS c`,
        [STATUSES, [...checkedContexts]],
      )
    ).rows;
    expect(rows).toHaveLength(STATUSES.length * 2 * checkedContexts.length);
    for (const r of rows) {
      const name = accountStatus.name(r.s);
      const expected = listableCases.find((c) => c.status === name && c.shadowbanned === r.b)!;
      const want = r.c === 1 ? expected.discovery : r.c === 2 ? expected.relationship : false;
      expect(r.v, `${name} shadowbanned=${r.b} ctx=${r.c}`).toBe(want);
      expect(userListable(r.s, r.b, r.c)).toBe(r.v);
    }
  });

  it('can_see and visible_subset answer every pair of the case table', async () => {
    for (const c of canSeeCases) {
      const viewer = await account(accountStatus.code(c.viewer.status), c.viewer.shadowbanned === true, c.viewer.test === true);
      const target = c.self
        ? viewer
        : await account(accountStatus.code(c.target.status), c.target.shadowbanned === true, c.target.test === true);
      if (c.block === 'viewer' || c.block === 'both') await block(viewer, target);
      if (c.block === 'target' || c.block === 'both') await block(target, viewer);
      for (const [ctx, want] of [
        [1, c.discovery],
        [2, c.relationship],
      ] as const) {
        const { rows } = await db.admin.query<{ point: boolean; batch: string[] }>(
          `SELECT can_see($1, $2, $3) AS point, ARRAY(SELECT x::text FROM visible_subset($1, ARRAY[$2::bigint], $3) AS x) AS batch`,
          [viewer, target, ctx],
        );
        expect(rows[0]!.point, `${c.name} ctx=${ctx} (can_see)`).toBe(want);
        expect(rows[0]!.batch.length === 1, `${c.name} ctx=${ctx} (visible_subset)`).toBe(want);
      }
    }
  });

  it('agrees with the mirror on 400 random pairs, blocks either way included', async () => {
    const viewers: { id: string; flags: number }[] = [];
    for (let i = 0; i < 20; i += 1) {
      const test = Math.random() < 0.2;
      viewers.push({ id: await account(STATUSES[Math.floor(Math.random() * 7)]!, Math.random() < 0.15, test), flags: test ? 1 : 0 });
    }
    const targets: { id: string; flags: number; status: number; shadowbanned: boolean }[] = [];
    for (let i = 0; i < 20; i += 1) {
      const status = STATUSES[Math.floor(Math.random() * STATUSES.length)]!;
      const shadowbanned = Math.random() < 0.2;
      const test = Math.random() < 0.2;
      targets.push({ id: await account(status, shadowbanned, test), flags: test ? 1 : 0, status, shadowbanned });
    }
    const blocked = new Set<string>();
    for (const v of viewers) {
      for (const t of targets) {
        const roll = Math.random();
        if (roll < 0.1) await block(v.id, t.id);
        else if (roll < 0.2) await block(t.id, v.id);
        else continue;
        blocked.add(`${v.id}:${t.id}`);
      }
    }
    for (const ctx of [1, 2]) {
      const { rows } = await db.admin.query<{ v: string; ids: string[] }>(
        `SELECT v::text, ARRAY(SELECT x::text FROM visible_subset(v, $2::bigint[], $3) AS x) AS ids FROM unnest($1::bigint[]) AS v`,
        [viewers.map((v) => v.id), targets.map((t) => t.id), ctx],
      );
      for (const row of rows) {
        const viewer = viewers.find((v) => v.id === row.v)!;
        const mirror = visibleSubset(viewer, targets.map((t) => ({ ...t, blocked: blocked.has(`${viewer.id}:${t.id}`) })), ctx);
        expect([...row.ids].sort(), `viewer ${viewer.id} ctx ${ctx}`).toEqual([...mirror].sort());
      }
      const points = await db.admin.query<{ v: string; t: string; ok: boolean }>(
        `SELECT v::text, t::text, can_see(v, t, $3) AS ok FROM unnest($1::bigint[]) AS v, unnest($2::bigint[]) AS t`,
        [viewers.map((v) => v.id), targets.map((t) => t.id), ctx],
      );
      expect(points.rows).toHaveLength(400);
      for (const p of points.rows) {
        const viewer = viewers.find((v) => v.id === p.v)!;
        const target = targets.find((t) => t.id === p.t)!;
        expect(canSee(viewer, target, blocked.has(`${p.v}:${p.t}`), ctx), `${p.v} → ${p.t} ctx ${ctx}`).toBe(p.ok);
      }
    }
  });
});
