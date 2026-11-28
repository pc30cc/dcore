import { adminProfileDecisionSchema, adminProfileReviewPageSchema, meSchema, reviewResubmitSchema } from '@app/shared';
import { FakeRealtimePublisher } from '@app/shared/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { call, migratedDatabase, row, seedUser, setAppConfig, statements, type SeededUser, type TestDatabase } from './accountSupport.js';
import { admin, adminAs, installAuditFailure, lastAudit, refuseAudit, startAdminHarness, type AdminHarness, type AdminSession } from './adminSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * The new-profile review (decisions §2 row 1): with the waitlist on, a
 * finished sign-up waits in `pending_review`; the queue lists it oldest
 * first; approving makes it active and listable; needs-changes and reject
 * reach the person with the message in their language, and after changes
 * the person sends the profile again.
 */

describe.skipIf(!hasInfrastructure)('admin: the new-profile review', () => {
  let db: TestDatabase;
  let h: AdminHarness;
  let moderator: AdminSession;
  let support: AdminSession;
  const realtime = new FakeRealtimePublisher();

  beforeAll(async () => {
    db = await migratedDatabase();
    await installAuditFailure(db);
    h = await startAdminHarness(db, {}, { realtime });
    moderator = await adminAs(h, 'moderator');
    support = await adminAs(h, 'support');
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    await db?.drop();
  });

  beforeEach(async () => {
    realtime.published.splice(0);
    await refuseAudit(db);
  });

  const queue = async (state = 'waiting', session: AdminSession = moderator, query = '') => {
    const res = await admin(h, `/v1/admin/moderation/profiles?state=${state}${query}`, undefined, { token: session.accessToken });
    return { res, page: res.statusCode === 200 ? adminProfileReviewPageSchema.parse(res.json()) : null };
  };
  const decide = (user: SeededUser, verb: 'approve' | 'reject' | 'needs-changes', body: Record<string, unknown>, session: AdminSession = moderator) =>
    admin(h, `/v1/admin/users/${user.publicUid}/${verb}`, body, { token: session.accessToken });
  const me = async (user: SeededUser) => meSchema.parse((await call(h, '/v1/me', { token: user.token })).json());
  const events = (user: SeededUser, type: string) => realtime.published.filter((p) => p.envelope.t === type && p.channels.some((c) => c.endsWith(user.publicUid)));

  /** A sign-up taken to its end through the app's routes. */
  async function signUp(name: string): Promise<SeededUser> {
    const user = await seedUser(h, { status: 1, country: null });
    expect((await call(h, '/v1/me/profile', { method: 'PATCH', token: user.token, body: { displayName: name, onboardingStep: 2 } })).statusCode).toBe(200);
    expect((await call(h, '/v1/me/basics', { method: 'PUT', token: user.token, body: { birthDate: '1995-03-02', gender: 'woman', consents: { terms: 1, privacy: 1, guidelines: 1 } } })).statusCode).toBe(200);
    expect((await call(h, '/v1/me/preferences', { method: 'PATCH', token: user.token, body: { interestedIn: ['man'] } })).statusCode).toBe(200);
    expect((await call(h, '/v1/me/location', { method: 'PUT', token: user.token, body: { source: 'city', cityId: 112931 } })).statusCode).toBe(200);
    for (const position of [0, 1]) {
      await db.sql.query('INSERT INTO photos (id, user_id, position, status, width, height, blurhash) VALUES ($1, $2, $3, 3, 1080, 1350, $4)', [h.app.ids.nextId(), user.id, position, 'LEHV6nWB2yk8pyo0adR*.7kCMdnj']);
    }
    await h.app.account.changed(user.id);
    const done = await call(h, '/v1/me/profile', { method: 'PATCH', token: user.token, body: { onboardingStep: 30 } });
    expect(done.statusCode, done.body).toBe(200);
    return user;
  }

  it('holds a sign-up under the waitlist, lists it oldest first, and approving makes it listable', async () => {
    await setAppConfig(h, 'onboarding.waitlist', { enabled: true });
    const first = await signUp('First');
    const second = await signUp('Second');
    expect((await me(first)).status).toBe('pending_review');
    expect((await me(first)).review).toEqual({ state: 'waiting' });
    expect((await row<{ status: number }>(db, 'SELECT status FROM discovery WHERE user_id = $1', [first.id]).catch(() => ({ status: -1 }))).status).not.toBe(3);
    const { res, page } = await queue();
    expect(res.statusCode).toBe(200);
    expect(statements(res)).toBe(1);
    const ids = page!.items.map((item) => item.user.id);
    expect(ids.indexOf(first.publicUid)).toBeLessThan(ids.indexOf(second.publicUid));
    const item = page!.items.find((i) => i.user.id === first.publicUid)!;
    expect(item).toMatchObject({ state: 'waiting', rounds: 0, decision: null, user: { name: 'First', gender: 'woman', country: 'IR' } });
    expect(item.photos).toHaveLength(2);
    // One a page: the cursor walks on, and names the last account by its public id only.
    const paged = await queue('waiting', moderator, '&limit=1');
    expect(paged.page!.items).toHaveLength(1);
    const cursor = paged.page!.nextCursor!;
    expect(cursor).not.toBeNull();
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    expect(JSON.parse(decoded)).toEqual({ u: paged.page!.items[0]!.user.id });
    for (const raw of [first.id, second.id]) expect(decoded).not.toContain(raw);
    const nextPage = await queue('waiting', moderator, `&limit=1&cursor=${cursor}`);
    expect(nextPage.page!.items[0]?.user.id).not.toBe(paged.page!.items[0]!.user.id);
    // A cursor with a raw id (or anything else) is refused at the field.
    const forged = Buffer.from(JSON.stringify({ id: first.id })).toString('base64url');
    expect((await queue('waiting', moderator, `&cursor=${forged}`)).res.statusCode).toBe(400);
    const badUid = Buffer.from(JSON.stringify({ u: 'not-a-public-id' })).toString('base64url');
    expect((await queue('waiting', moderator, `&cursor=${badUid}`)).res.json()).toMatchObject({ errors: [{ pointer: '/cursor' }] });

    const approved = await decide(first, 'approve', { from: 'waiting' });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(statements(approved)).toBeLessThanOrEqual(3);
    expect(adminProfileDecisionSchema.parse(approved.json())).toMatchObject({ review: 'approved', user: { status: 'active' }, sideEffects: 'done' });
    expect((await me(first)).status).toBe('active');
    expect((await me(first)).review).toBeUndefined();
    expect((await row<{ n: number }>(db, 'SELECT count(*)::int AS n FROM profile_reviews WHERE user_id = $1', [first.id])).n).toBe(0);
    expect((await row<{ active: boolean }>(db, 'SELECT EXISTS (SELECT 1 FROM discovery WHERE user_id = $1) AS active', [first.id])).active).toBe(true);
    expect(events(first, 'account')).toHaveLength(1);
    expect((await lastAudit(db, { action: 'profile.approve', targetType: 1, targetId: first.id }))?.detail).toMatchObject({ from: 'waiting', to: 'approved' });
    // Decided: another decision is refused.
    expect((await decide(first, 'approve', { from: 'waiting' })).json()).toMatchObject({ code: 'conflict', reason: 'already_decided' });
    expect((await queue()).page!.items.map((i) => i.user.id)).not.toContain(first.publicUid);
    await setAppConfig(h, 'onboarding.waitlist', { enabled: false });
  });

  it('sends a profile back with the message the person reads; after changes it waits again; a rejection says why', async () => {
    const person = await seedUser(h, { status: 2, name: 'Pending' });
    const stale = await decide(person, 'needs-changes', { from: 'needs_changes', reasonText: 'Add a clear photo of your face.' });
    expect(stale.json()).toMatchObject({ reason: 'stale' });
    const sent = await decide(person, 'needs-changes', { from: 'waiting', reasonText: 'Add a clear photo of your face.', note: 'Blurry main photo' });
    expect(sent.statusCode, sent.body).toBe(200);
    expect(adminProfileDecisionSchema.parse(sent.json()).review).toBe('needs_changes');
    const view = await me(person);
    expect(view.review).toMatchObject({ state: 'needs_changes', message: 'Add a clear photo of your face.' });
    expect(view.review?.decidedAt).toBeDefined();
    expect(events(person, 'profile').at(-1)?.envelope.d).toMatchObject({ review: { state: 'needs_changes', message: 'Add a clear photo of your face.' } });
    const back = (await queue('needs_changes')).page!.items.find((i) => i.user.id === person.publicUid)!;
    expect(back).toMatchObject({ rounds: 1, decision: { kind: 'needs_changes', reasonText: 'Add a clear photo of your face.' } });
    expect(back.decision?.decidedBy?.id).toBe(String(moderator.account.id));
    // The person changes the profile and sends it again.
    const resubmit = await call(h, '/v1/me/review/resubmit', { method: 'POST', token: person.token });
    expect(resubmit.statusCode, resubmit.body).toBe(200);
    expect(statements(resubmit)).toBe(1);
    expect(reviewResubmitSchema.parse(resubmit.json()).review.state).toBe('waiting');
    expect((await me(person)).review).toEqual({ state: 'waiting' });
    const again = (await queue()).page!.items.find((i) => i.user.id === person.publicUid);
    expect(again?.rounds).toBe(1);
    // Waiting again, the earlier request shows as what it was.
    expect(again?.decision).toMatchObject({ kind: 'needs_changes', reasonText: 'Add a clear photo of your face.' });
    // A rejection.
    const rejected = await decide(person, 'reject', { from: 'waiting', reasonText: 'This profile does not follow the guidelines.' });
    expect(rejected.statusCode).toBe(200);
    expect((await me(person)).review).toMatchObject({ state: 'rejected', message: 'This profile does not follow the guidelines.' });
    expect((await call(h, '/v1/me/review/resubmit', { method: 'POST', token: person.token })).statusCode).toBe(409);
    expect((await lastAudit(db, { action: 'profile.reject', targetType: 1, targetId: person.id }))?.detail).toMatchObject({ from: 'waiting', to: 'rejected', reasonText: 'This profile does not follow the guidelines.', rounds: 2 });
    // A rejected profile may still be accepted later.
    expect((await decide(person, 'approve', { from: 'rejected' })).statusCode).toBe(200);
    expect((await me(person)).status).toBe('active');
  });

  it('needs moderation.read to list and moderation.decide to decide; an unknown person is a 404', async () => {
    expect((await queue('waiting', support)).res.statusCode).toBe(403);
    const person = await seedUser(h, { status: 2, name: 'Guarded' });
    expect((await decide(person, 'approve', { from: 'waiting' }, support)).statusCode).toBe(403);
    expect((await admin(h, `/v1/admin/users/${h.app.publicIds.user.encode('123456789')}/approve`, { from: 'waiting' }, { token: moderator.accessToken })).statusCode).toBe(404);
    const active = await seedUser(h, { name: 'Active' });
    expect((await decide(active, 'reject', { from: 'waiting', reasonText: 'No.' })).json()).toMatchObject({ reason: 'already_decided' });
    expect((await decide(person, 'reject', { from: 'waiting', reasonText: '' })).statusCode).toBe(400);
  });

  it('keeps the review row with the account: made at the end of sign-up, gone when it is active or purged', async () => {
    const user = await seedUser(h, { status: 1, birthDate: '1994-05-17', gender: 2 });
    await db.sql.query('UPDATE users SET status = 2 WHERE id = $1', [user.id]);
    expect((await row<{ state: number }>(db, 'SELECT state FROM profile_reviews WHERE user_id = $1', [user.id])).state).toBe(1);
    await db.sql.query('UPDATE users SET status = 5 WHERE id = $1', [user.id]);
    await db.sql.query('UPDATE users SET status = 2 WHERE id = $1', [user.id]);
    expect((await row<{ n: number }>(db, 'SELECT count(*)::int AS n FROM profile_reviews WHERE user_id = $1', [user.id])).n).toBe(1);
    await db.sql.query('UPDATE users SET status = 3 WHERE id = $1', [user.id]);
    expect((await row<{ n: number }>(db, 'SELECT count(*)::int AS n FROM profile_reviews WHERE user_id = $1', [user.id])).n).toBe(0);
  });
});
