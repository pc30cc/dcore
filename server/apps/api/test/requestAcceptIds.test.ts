import { randomUUID } from 'node:crypto';
import { conversationBodySchema, sentRequestBodySchema } from '@app/shared';
import { FakeRealtimePublisher } from '@app/shared/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryJobProducer } from '../src/services/jobs.js';
import { call, migratedDatabase, seedUser, startHarness, type Harness, type TestDatabase } from './accountSupport.js';
import { eventsOf, matchOf } from './chatSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * A request accepted into a conversation that exists already (the two
 * matched while it waited): each `conversation` event of the accept has an
 * id of its own, never the id the match (or a first accept) was published
 * under, so neither Centrifugo's idempotency nor the app's dedupe drops it.
 */

describe.skipIf(!hasInfrastructure)('accepting a request into an existing conversation', () => {
  let db: TestDatabase;
  let h: Harness;
  const realtime = new FakeRealtimePublisher();

  beforeAll(async () => {
    db = await migratedDatabase();
    h = await startHarness(db, {}, { realtime, jobs: new MemoryJobProducer() });
  }, 90_000);

  afterAll(async () => {
    await h?.close();
    await db?.drop();
  });

  it('publishes the accepted events with new ids', async () => {
    const a = await seedUser(h, { name: 'Ava' });
    const b = await seedUser(h, { name: 'Ben' });
    // Ben asked first; the request stayed pending while the two matched.
    const sent = await call(h, '/v1/message-requests', { method: 'POST', token: b.token, body: { to: a.publicUid, body: 'Hi Ava', clientId: randomUUID() } });
    expect(sent.statusCode, sent.body).toBe(201);
    const request = sentRequestBodySchema.parse(sent.json()).request;
    const match = await matchOf(h, a.id, b.id);
    const accepted = await call(h, `/v1/message-requests/${request.id}/accept`, { method: 'POST', token: a.token });
    expect(accepted.statusCode, accepted.body).toBe(201);
    const conversation = conversationBodySchema.parse(accepted.json()).conversation;
    expect(conversation.id).toBe(match.id);
    const toBen = eventsOf(realtime, b.publicUid, 'conversation').at(-1)!;
    const toAva = eventsOf(realtime, a.publicUid, 'conversation').at(-1)!;
    expect(toBen.d).toMatchObject({ reason: 'accepted', conversation: { id: match.id } });
    expect(toAva.d).toMatchObject({ reason: 'accepted', conversation: { id: match.id } });
    expect(toBen.id).not.toBe(match.id);
    expect(toAva.id).not.toBe(match.id);
    expect(toBen.id).not.toBe(toAva.id);
  });
});
