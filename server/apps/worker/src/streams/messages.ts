import { insertMessages } from '@app/db';
import { idTime } from '@app/shared';
import { countEventsByDay, parseMessageEntry, StreamEntryError, utcDay, type StoredMessage } from '@app/shared/server';
import type { JobContext } from '../queues/types.js';
import type { BatchResult } from './batch.js';
import type { StreamDelivery } from './consumer.js';

/**
 * The writer of `wb:msg` (batch mode): one statement per batch, the
 * multi-row INSERT (`ON CONFLICT (match_id, id) DO NOTHING`, so a replayed
 * batch and a message written directly, an accepted request's first
 * message, are no-ops), each row routed to its month's partition by id.
 * Everything the people of the conversation needed was done when the
 * message was sent (published, counted, pushed); this only makes it
 * durable. A batch of new entries that inserted fewer rows than it carried
 * points at colliding ids and is logged as an error (a replay of claimed
 * or own pending entries inserts fewer by design).
 *
 * A malformed entry (only a bug can make one: the API validated every
 * field) is dead-lettered without its body; a database outage only pauses
 * the writer; a row the database refuses for its data is dead-lettered on
 * its own (the batch is retried row by row).
 *
 * A batch of new entries also counts its people's messages (kinds 1-4, test
 * accounts left out) per UTC day for the dashboard (`ev:msg:<day>`); a
 * replayed batch counts nothing, so nothing is counted twice (a batch that
 * failed before its count is an undercount).
 */

export interface MessageBatchStats {
  batches: number;
  rows: number;
  inserted: number;
  statements?: number;
}

export function messageBatchHandler(context: JobContext, stats?: MessageBatchStats) {
  const { services, log } = context;
  return async (entries: readonly StreamDelivery[]): Promise<BatchResult> => {
    const poison: string[] = [];
    const messages: StoredMessage[] = [];
    for (const entry of entries) {
      try {
        messages.push(parseMessageEntry(entry.fields));
      } catch (error) {
        if (error instanceof StreamEntryError) poison.push(entry.id);
        else throw error;
      }
    }
    if (messages.length === 0) return { poison };
    // The same message twice in one batch (a replay that met its original) is one row.
    const unique = [...new Map(messages.map((m) => [`${m.matchId}:${m.id}`, m])).values()];
    const inserted = await insertMessages(services.pg, unique);
    const fresh = entries.every((entry) => entry.source === 'new');
    if (fresh && inserted < unique.length) {
      log.error({ inserted, expected: unique.length, batch: entries.length }, 'message batch inserted fewer rows than it carried: colliding ids?');
    }
    if (fresh) countMessages(context, unique);
    if (stats) {
      stats.batches += 1;
      stats.rows += messages.length;
      stats.inserted += inserted;
      stats.statements = (stats.statements ?? 0) + 1;
    }
    return { poison };
  };
}

/**
 * People's messages (text, image, voice, GIF) of a fresh batch per UTC day,
 * test senders left out; never awaited. Until the test-account set has
 * loaded once (after a start) nothing is known about senders, so the count
 * waits for that load and is skipped when it fails.
 */
function countMessages(context: JobContext, messages: readonly StoredMessage[]): void {
  const { services, redis, log } = context;
  const tests = services.testAccounts;
  const ready = tests && !tests.loaded ? tests.ids().then(() => tests.loaded) : Promise.resolve(true);
  ready
    .then(async (known) => {
      if (!known) {
        log.warn({ messages: messages.length }, 'messages: not counted (test accounts unknown)');
        return;
      }
      const perDay = new Map<string, number>();
      for (const m of messages) {
        if (m.kind < 1 || m.kind > 4 || tests?.has(m.senderId)) continue;
        const day = utcDay(idTime(m.id));
        perDay.set(day, (perDay.get(day) ?? 0) + 1);
      }
      if (perDay.size > 0) await countEventsByDay(redis, services.keys, 'msg', perDay);
    })
    .catch((error: unknown) => log.warn({ err: error }, 'messages: not counted'));
}
