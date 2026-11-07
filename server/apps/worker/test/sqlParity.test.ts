import { ID_DATABASE_GENERATOR, ID_EPOCH_MS, composeId, idFloor, idParts, idTime } from '@app/shared';
import { cellResolution, homeCell, parentCell } from '@app/shared/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasDatabase, migratedDatabase, type TestDatabase } from './db.js';

/**
 * The SQL helpers against the application's own code, on the real
 * migrations: ids (time, floor, the database's generator), H3 cells (parent,
 * resolution, validity) on thousands of cells, partition routing by id, and
 * the read-pointer flush as heap-only updates. The application and the
 * database must compute the same numbers: partitions, deck cells and
 * "rows since T" ranges are built on both sides.
 */

describe.skipIf(!hasDatabase)('SQL helpers agree with the application', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await migratedDatabase();
  }, 90_000);
  afterAll(async () => {
    await db?.drop();
  });

  it('reads and floors ids the way the application mints them', async () => {
    const ids: bigint[] = [];
    for (let i = 0; i < 500; i += 1) {
      ids.push(composeId({ ms: ID_EPOCH_MS + Math.floor(Math.random() * 2 ** 40), generator: i % 1024, sequence: (i * 37) % 4096 }));
    }
    ids.push(composeId({ ms: ID_EPOCH_MS, generator: 0, sequence: 1 }), composeId({ ms: ID_EPOCH_MS + 2 ** 41 - 1, generator: 1023, sequence: 4095 }));
    const { rows } = await db.admin.query<{ id: string; ms: string }>(`SELECT x::text AS id, id_ms(x)::text AS ms FROM unnest($1::bigint[]) AS x`, [ids.map(String)]);
    for (const row of rows) expect(Number(row.ms), row.id).toBe(idTime(row.id).getTime());
    const times = await db.admin.query<{ id: string; ms: string }>(
      `SELECT x::text AS id, floor(extract(epoch FROM id_time(x)) * 1000)::bigint::text AS ms FROM unnest($1::bigint[]) AS x`,
      [ids.slice(0, 50).map(String)],
    );
    for (const row of times.rows) expect(Math.abs(Number(row.ms) - idTime(row.id).getTime()), row.id).toBeLessThanOrEqual(1);

    const instants = [ID_EPOCH_MS, ID_EPOCH_MS + 1, Date.UTC(2026, 10, 7, 9, 14, 3, 120), Date.UTC(2031, 0, 1), Date.UTC(2025, 0, 1)];
    const floors = await db.admin.query<{ ms: string; floor: string }>(
      `SELECT t::text AS ms, id_floor(to_timestamp(t / 1000.0))::text AS floor FROM unnest($1::bigint[]) AS t`,
      [instants.map(String)],
    );
    for (const row of floors.rows) {
      if (Number(row.ms) >= ID_EPOCH_MS) expect(BigInt(row.floor), row.ms).toBe(idFloor(Number(row.ms)));
      // Before the epoch SQL gives a negative bound and the application 0: both lie below every id.
      else expect([BigInt(row.floor) < 0n, idFloor(Number(row.ms))]).toEqual([true, 0n]);
    }

    const minted = await db.admin.query<{ id: string }>(`SELECT id_next()::text AS id FROM generate_series(1, 5)`);
    for (const { id } of minted.rows) {
      const parts = idParts(id);
      expect(parts.generator).toBe(ID_DATABASE_GENERATOR);
      expect(Math.abs(parts.ms - Date.now())).toBeLessThan(60_000);
    }
  });

  it('agrees on H3 parents, resolutions and validity for 7,200 cells around two cities', async () => {
    const cells = new Set<string>();
    for (const centre of [
      { lat: 41.0082, lng: 28.9784 },
      { lat: 35.6892, lng: 51.389 },
    ]) {
      for (let i = 0; i < 60; i += 1) {
        for (let j = 0; j < 60; j += 1) cells.add(homeCell({ lat: centre.lat - 1.5 + i * 0.05, lng: centre.lng - 1.5 + j * 0.05 }));
      }
    }
    expect(cells.size).toBeGreaterThan(3_000);
    const list = [...cells];
    const { rows } = await db.admin.query<{ cell: string; res: number; valid: boolean; r5: string; r3: string }>(
      `SELECT c::text AS cell, h3_resolution(c) AS res, h3_is_cell(c) AS valid, h3_parent(c, 5)::text AS r5, h3_parent(c, 3)::text AS r3
         FROM unnest($1::bigint[]) AS c`,
      [list],
    );
    expect(rows).toHaveLength(list.length);
    const wrong = rows.filter(
      (row) => row.res !== cellResolution(row.cell) || row.res !== 7 || !row.valid || row.r5 !== parentCell(row.cell, 5) || row.r3 !== parentCell(row.cell, 3),
    );
    expect(wrong).toEqual([]);
    // Not cells: zero, a negative number, a cell id with the wrong mode, a vertex-mode id.
    const sample = BigInt(list[0]!);
    const notCells = [0n, -1n, sample & ~(15n << 59n), (sample & ~(15n << 59n)) | (4n << 59n)];
    const refused = await db.admin.query<{ valid: boolean }>(`SELECT h3_is_cell(c) AS valid FROM unnest($1::bigint[]) AS c`, [notCells.map(String)]);
    expect(refused.rows.map((r) => r.valid)).toEqual([false, false, false, false]);
  });

  it('routes a row to the partition whose id range holds its time, and refuses one no partition holds', async () => {
    const now = new Date();
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const nextMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
    const { rows } = await db.admin.query<{ name: string; bound: string }>(
      `SELECT c.oid::regclass::text AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
         FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'public.messages'::regclass`,
    );
    const expected = `FOR VALUES FROM ('${idFloor(monthStart)}') TO ('${idFloor(nextMonth)}')`;
    const current = rows.find((row) => row.bound === expected);
    expect(current, `a partition ${expected} among ${rows.map((r) => r.bound).join('; ')}`).toBeDefined();
    expect(current!.name.startsWith('part.')).toBe(true);

    const id = composeId({ ms: now.getTime(), generator: 7, sequence: 1 });
    const routed = await db.admin.query<{ partition: string }>(
      `INSERT INTO messages (match_id, id, sender_id, kind, body) VALUES (1, $1, 1, 1, 'x') RETURNING tableoid::regclass::text AS partition`,
      [String(id)],
    );
    expect(routed.rows[0]?.partition).toBe(current!.name);
    const far = composeId({ ms: Date.UTC(2090, 0, 1), generator: 7, sequence: 1 });
    await expect(db.admin.query(`INSERT INTO messages (match_id, id, sender_id, kind, body) VALUES (1, $1, 1, 1, 'x')`, [String(far)])).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('flushes read pointers forward only, as heap-only updates', async () => {
    const users: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const { rows } = await db.admin.query<{ id: string }>(
        `INSERT INTO users (id, status, birth_date, gender, country, onboarding_step) VALUES (id_next(), 3, DATE '1994-05-17', 2, 'IR', 30) RETURNING id::text`,
      );
      users.push(rows[0]!.id);
    }
    const [lo, hi] = [...users].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    const { rows } = await db.admin.query<{ id: string }>(`INSERT INTO matches (id, user_lo, user_hi, source) VALUES (id_next(), $1, $2, 1) RETURNING id::text`, [lo, hi]);
    const matchId = rows[0]!.id;

    const client = await db.admin.connect();
    try {
      await client.query('BEGIN');
      const flush = async (loRead: number, hiRead: number) =>
        (await client.query<{ n: number }>(`SELECT matches_flush_read(ARRAY[$1::bigint], ARRAY[$2::bigint], ARRAY[$3::bigint]) AS n`, [matchId, loRead, hiRead])).rows[0]!.n;
      expect(await flush(5, 0)).toBe(1);
      expect(await flush(5, 0)).toBe(0);
      expect(await flush(3, 7)).toBe(1);
      const stats = await client.query<{ upd: string; hot: string }>(
        `SELECT n_tup_upd::text AS upd, n_tup_hot_upd::text AS hot FROM pg_stat_xact_user_tables WHERE relid = 'public.matches'::regclass`,
      );
      expect(stats.rows[0]).toEqual({ upd: '2', hot: '2' });
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const after = await db.admin.query(`SELECT lo_read_id::text AS lo, hi_read_id::text AS hi FROM matches WHERE id = $1`, [matchId]);
    expect(after.rows[0]).toEqual({ lo: '5', hi: '7' });
  });
});
