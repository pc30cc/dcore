import { adminPurchaseActionResultSchema } from '@app/shared';
import { FakeGooglePlay, PlayStoreVerifier } from '@app/shared/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryJobProducer } from '../src/services/jobs.js';
import { call, migratedDatabase, row, seedUser, type SeededUser, type TestDatabase } from './accountSupport.js';
import { admin, adminAs, lastAudit, startAdminHarness, type AdminHarness, type AdminSession } from './adminSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * An admin's refund of a Google Play subscription against a local fake of
 * Google's Developer API, which answers as Google does: a subscription that
 * is no longer live (refunded before, or simply run out) is refused by
 * `subscriptionsv2.revoke` and reads SUBSCRIPTION_STATE_EXPIRED either way.
 * The server then applies what Google shows and never records a refund that
 * did not happen; a live one is refunded, revoked and recorded once.
 */

const DAY = 86_400_000;
const PACKAGE = 'com.example.app';

describe.skipIf(!hasInfrastructure)('admin: a Play refund against a fake Google', () => {
  let db: TestDatabase;
  let h: AdminHarness;
  let finance: AdminSession;
  const google = new FakeGooglePlay({ packageName: PACKAGE });
  const jobs = new MemoryJobProducer();

  beforeAll(async () => {
    await google.start();
    db = await migratedDatabase();
    await db.sql.query(`UPDATE store_products SET is_active = true WHERE store = 1`);
    h = await startAdminHarness(db, {}, { jobs, store: { verifiers: { play: new PlayStoreVerifier({ api: google.api() }) } } });
    finance = await adminAs(h, 'finance');
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    await db?.drop();
    await google.stop();
  });

  beforeEach(() => {
    google.reset();
  });

  const billingRef = (u: SeededUser) => h.app.publicIds.billing.encode(u.id);
  /** The person's app sends the token; Google shows it as `state` until `expiryTimeMs`. */
  async function bought(u: SeededUser, token: string, state: string, expiryTimeMs: number): Promise<string> {
    google.putSubscription(token, { state, productId: 'sub.plus', basePlanId: 'm1', startTimeMs: Date.now() - 20 * DAY, expiryTimeMs, accountRef: billingRef(u), acknowledged: true, autoRenew: state === 'SUBSCRIPTION_STATE_ACTIVE' });
    const res = await call(h, '/v1/store/play/purchases', { method: 'POST', token: u.token, client: 'play/120', body: { productId: 'sub.plus', purchaseToken: token, kind: 'subscription' } });
    expect(res.statusCode, res.body).toBe(200);
    return (await row<{ id: string }>(db, `SELECT id::text AS id FROM store_purchases WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [u.id])).id;
  }
  const refund = (id: string, from: string) => admin(h, `/v1/admin/purchases/${id}/refund`, { from, note: 'Asked for a refund' }, { token: finance.accessToken });
  const events = async (id: string) => (await db.sql.query<{ event: number; source: number; state_to: number }>('SELECT event, source, state_to FROM store_events WHERE purchase_id = $1 ORDER BY id', [id])).rows;

  it('a subscription that ran out at Google before its row caught up: no refund recorded, the expiry applied', async () => {
    const u = await seedUser(h, { store: 1, name: 'Pat' });
    const token = `tok-adm-ranout-${u.id}`;
    // Renewal off, still in its period when the app sent it.
    const id = await bought(u, token, 'SUBSCRIPTION_STATE_CANCELED', Date.now() + DAY);
    // The period ended at Google; neither the notification nor the server's end job has landed yet.
    google.putSubscription(token, { state: 'SUBSCRIPTION_STATE_EXPIRED', productId: 'sub.plus', basePlanId: 'm1', startTimeMs: Date.now() - 20 * DAY, expiryTimeMs: Date.now() - 60_000, accountRef: billingRef(u), acknowledged: true });
    const res = await refund(id, 'canceled');
    expect(res.statusCode, res.body).toBe(200);
    expect(google.count('subscriptionsv2.revoke')).toBe(1);
    const out = adminPurchaseActionResultSchema.parse(res.json());
    expect(out).toMatchObject({ outcome: 'already', purchase: { state: 'expired', counts: false } });
    const written = await events(id);
    expect(written.filter((e) => e.event === 10)).toEqual([]);
    expect(written.at(-1)).toMatchObject({ source: 5, state_to: 7 });
    // The admin's request is on the record (its row was written before Google was asked).
    expect((await lastAudit(db, { action: 'purchase.refund', targetType: 5, targetId: id }))?.detail).toMatchObject({ from: 'canceled', prorated: false });
  });

  it('a live subscription: Google refunds and revokes it, one refund event, access ends now', async () => {
    const u = await seedUser(h, { store: 1, name: 'Ray' });
    const token = `tok-adm-live-${u.id}`;
    const id = await bought(u, token, 'SUBSCRIPTION_STATE_ACTIVE', Date.now() + 25 * DAY);
    const res = await refund(id, 'active');
    expect(res.statusCode, res.body).toBe(200);
    expect(adminPurchaseActionResultSchema.parse(res.json())).toMatchObject({ outcome: 'done', purchase: { state: 'revoked', counts: false } });
    expect((await events(id)).filter((e) => e.event === 10)).toHaveLength(1);
    expect((await db.sql.query('SELECT 1 FROM subscriptions WHERE user_id = $1 AND store = 1', [u.id])).rowCount).toBe(0);
  });
});
