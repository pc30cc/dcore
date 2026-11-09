import { pushTargetsOf, type Queryable } from '@app/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasDatabase, migratedDatabase, type TestDatabase } from './db.js';

/**
 * Where a push goes is read on every push, ring and missed call: the live
 * session of each device must be found by the account's index, never by a
 * scan of every session there is.
 */

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}

function nodesOf(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodesOf)];
}

describe.skipIf(!hasDatabase)('push targets (PostgreSQL)', () => {
  let db: TestDatabase;
  const user = '700000000000000001';
  const other = '700000000000000002';

  beforeAll(async () => {
    db = await migratedDatabase();
    const a = db.admin;
    for (const id of [user, other]) {
      await a.query(`INSERT INTO users (id, status, birth_date, gender, country, onboarding_step, notify_flags, locale) VALUES ($1, 3, DATE '1994-05-17', 2, 'IR', 30, 15, 'en')`, [id]);
    }
    // The person's phone with a live session, a signed-out tablet, and many other people's sessions.
    await a.query(`INSERT INTO devices (id, user_id, app_version, platform, store, push_token, push_token_hash, locale) VALUES
                     (710000000000000001, $1, 100, 1, 2, 'tok-phone', sha256('tok-phone'::bytea), 'fa'),
                     (710000000000000002, $1, 100, 1, 2, 'tok-tablet', sha256('tok-tablet'::bytea), 'en'),
                     (710000000000000003, $2, 100, 1, 2, 'tok-other', sha256('tok-other'::bytea), 'en')`, [user, other]);
    await a.query(`INSERT INTO sessions (id, user_id, device_id, expires_at, store, refresh_hash) VALUES
                     (720000000000000001, $1, 710000000000000001, now() + interval '30 days', 2, sha256('one'::bytea)),
                     (720000000000000002, $1, 710000000000000002, now() + interval '30 days', 2, sha256('two'::bytea))`, [user]);
    await a.query(`UPDATE sessions SET revoked_at = now(), revoke_reason = 1 WHERE id = 720000000000000002`);
    await a.query(
      `INSERT INTO sessions (id, user_id, device_id, expires_at, store, refresh_hash, revoked_at, revoke_reason)
       SELECT 730000000000000000 + g, $1, 710000000000000003, now() + interval '30 days', 2, sha256(int4send(g)), CASE WHEN g % 2 = 0 THEN now() END, CASE WHEN g % 2 = 0 THEN 1 END
         FROM generate_series(1, 5000) g`,
      [other],
    );
    await a.query('ANALYZE sessions');
  }, 90_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('finds the devices with a live session through the account’s sessions only', async () => {
    const client = await db.admin.connect();
    try {
      const target = await pushTargetsOf(client, user);
      expect(target?.devices.map((d) => d.token)).toEqual(['tok-phone']);
      // Whether an index path exists at all: with sequential scans priced out, any scan of sessions left is forced.
      await client.query('SET enable_seqscan = off');
      let plan: PlanNode | null = null;
      const explaining = {
        async query(config: { text: string; values?: unknown[] }) {
          const result = await client.query({ text: `EXPLAIN (FORMAT JSON) ${config.text}`, values: config.values ?? [] });
          plan = (result.rows[0] as { 'QUERY PLAN': { Plan: PlanNode }[] })['QUERY PLAN'][0]!.Plan;
          return { ...result, rows: [], rowCount: 0 };
        },
      } as unknown as Queryable;
      await pushTargetsOf(explaining, user);
      expect(plan).not.toBeNull();
      const onSessions = nodesOf(plan!).filter((n) => n['Relation Name'] === 'sessions');
      expect(onSessions.length).toBeGreaterThan(0);
      expect(onSessions.filter((n) => n['Node Type'] === 'Seq Scan')).toEqual([]);
    } finally {
      await client.query('RESET enable_seqscan').catch(() => undefined);
      client.release();
    }
  });
});
