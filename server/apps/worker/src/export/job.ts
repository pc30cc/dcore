import { exportAccount, exportOwnMessages, type ExportMessageRow } from '@app/db';
import { accountStatus, messageKind, realtimeEnvelope, userChannel, wireTime } from '@app/shared';
import { EXPORT_LINK_TTL_SECONDS, exportDataSchema, exportObjectKey, photoVariantKey, type ExportData, type MediaStore } from '@app/shared/server';
import { DelayedError, type Job } from 'bullmq';
import type { JobContext } from '../queues/types.js';
import { buildZip, type ZipEntry } from './zip.js';

/**
 * `account/export`: a copy of the person's data, as a ZIP in the private
 * bucket, then `account` with a presigned link to it, then (the same job,
 * delayed) the archive removed once the link ran out.
 *
 * The archive: `account.json` (account, profile, fields, prompts,
 * preferences, consents), `conversations.json` (when each began and whether
 * it is still on; never who the other person is), `messages.json` (the
 * person's own messages, by conversation), `purchases.json` (store
 * purchases, subscriptions, the wallet's movements) and `photos/<n>.webp`
 * (the largest stripped variant of each photo the person still has). One
 * statement reads the account, then a keyset read per {@link MESSAGES_PAGE}
 * messages.
 *
 * Steps are kept in the job: a retry after the upload publishes the same
 * archive under the same event id, and a published one only waits for its
 * expiry.
 */

export const MESSAGES_PAGE = 5_000;
const PHOTO_SIZE = 1080 as const;

/** What a run ends with; a run that announced the archive ends delayed until its link runs out. */
export type ExportResult = { outcome: 'missing' | 'removed' };

interface Built {
  bytes: Buffer;
  status: number;
}

async function later(job: Job, context: JobContext, atMs: number): Promise<never> {
  if (!context.token) throw new Error('a delayed step needs the job token');
  await job.moveToDelayed(Math.max(Date.now() + 1_000, atMs), context.token);
  throw new DelayedError();
}

function json(value: unknown): Uint8Array {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function ownMessages(context: JobContext, userId: string, conversationIds: readonly string[]): Promise<{ conversationId: string; messages: Record<string, unknown>[] }[]> {
  const byConversation = new Map<string, Record<string, unknown>[]>();
  let after: Pick<ExportMessageRow, 'conversationId' | 'id'> | null = null;
  for (;;) {
    const page: ExportMessageRow[] = await exportOwnMessages(context.services.pg, userId, conversationIds, after, MESSAGES_PAGE);
    for (const m of page) {
      const list = byConversation.get(m.conversationId) ?? [];
      list.push({
        id: m.id,
        kind: messageKind.nameOrUndefined(m.kind) ?? m.kind,
        ...(m.refId ? { refId: m.refId } : {}),
        ...(m.body !== null ? { body: m.body } : {}),
        flags: m.flags,
      });
      byConversation.set(m.conversationId, list);
    }
    if (page.length < MESSAGES_PAGE) break;
    const last: ExportMessageRow = page.at(-1)!;
    after = { conversationId: last.conversationId, id: last.id };
  }
  return [...byConversation].map(([conversationId, messages]) => ({ conversationId, messages }));
}

async function photos(media: MediaStore, rows: readonly { id: string; position: number; status: number; blobVer: number }[]): Promise<ZipEntry[]> {
  const entries: ZipEntry[] = [];
  // Processing photos have no variants yet; rejected ones are not the profile's.
  for (const photo of rows.filter((p) => p.status === 2 || p.status === 3)) {
    const bytes = await media.storage.getObject(media.mediaBucket, photoVariantKey(photo.id, photo.blobVer, PHOTO_SIZE));
    if (bytes) entries.push({ name: `photos/${photo.position + 1}.webp`, data: bytes, compress: false });
  }
  return entries;
}

async function build(context: JobContext, media: MediaStore, userId: string): Promise<Built | null> {
  const account = await exportAccount(context.services.pg, userId);
  if (!account) return null;
  const { data } = account;
  const status = accountStatus.nameOrUndefined(account.status) ?? account.status;
  const entries: ZipEntry[] = [
    {
      name: 'account.json',
      data: json({
        account: { ...(data['account'] as Record<string, unknown>), status },
        profile: data['profile'] ?? null,
        fields: data['fields'],
        prompts: data['prompts'],
        preferences: data['preferences'] ?? null,
        consents: data['consents'],
      }),
    },
    { name: 'conversations.json', data: json(data['conversations']) },
    { name: 'messages.json', data: json(await ownMessages(context, userId, account.conversationIds)) },
    { name: 'purchases.json', data: json({ purchases: data['purchases'], subscriptions: data['subscriptions'], wallet: data['wallet'] }) },
    ...(await photos(media, account.photos)),
  ];
  return { bytes: buildZip(entries), status: account.status };
}

export async function exportJob(job: Job, context: JobContext): Promise<ExportResult> {
  const { services, log } = context;
  const data: ExportData = exportDataSchema.parse(job.data);
  const media = services.media;
  // Failed (and retried) rather than dropped: the person asked for it.
  if (!media) throw new Error('export: no object storage is configured');

  if (data.stored && data.published) {
    if (Date.now() < data.stored.expiresAtMs) return later(job, context, data.stored.expiresAtMs);
    await media.storage.deleteObject(media.privateBucket, data.stored.key);
    log.info({ exportId: data.exportId }, 'export: the archive was removed after its link ran out');
    return { outcome: 'removed' };
  }

  let status: number | null = null;
  let bytes = 0;
  if (!data.stored) {
    const built = await build(context, media, data.userId);
    if (!built) {
      log.info({ exportId: data.exportId }, 'export: the account is gone; nothing to export');
      return { outcome: 'missing' };
    }
    const key = exportObjectKey(data.exportId);
    await media.storage.putObject(media.privateBucket, key, built.bytes, { contentType: 'application/zip' });
    data.stored = { key, eventId: services.ids.nextId(), expiresAtMs: Date.now() + EXPORT_LINK_TTL_SECONDS * 1_000 };
    await job.updateData(data);
    status = built.status;
    bytes = built.bytes.length;
  }

  const stored = data.stored;
  const remaining = Math.floor((stored.expiresAtMs - Date.now()) / 1_000);
  if (remaining >= 60) {
    if (services.realtime) {
      const link = await media.storage.presignGet({ bucket: media.privateBucket, key: stored.key, expiresInSeconds: remaining });
      // A retry after the upload reads the status again (one statement) rather than keeping it in the job.
      status ??= (await exportAccount(services.pg, data.userId))?.status ?? null;
      // An account deleted meanwhile is not told (its status is not one an app reads).
      const wire = status === null ? undefined : accountStatus.nameOrUndefined(status);
      if (wire !== undefined && wire !== 'purged') {
        const payload = { status: wire, export: { url: link.url, expiresAt: wireTime(stored.expiresAtMs) } };
        // The event id is the job's, so a retried publish is delivered once.
        await services.realtime.publish(userChannel(services.publicIds.user.encode(data.userId)), realtimeEnvelope('account', stored.eventId, Date.now(), payload));
      }
    } else {
      log.warn({ exportId: data.exportId }, 'export: no Centrifugo configured; the link was not sent');
    }
  }
  data.published = true;
  await job.updateData(data);
  log.info({ exportId: data.exportId, bytes }, 'export: archive stored and announced');
  // The same job removes the archive once the link has run out.
  return later(job, context, stored.expiresAtMs);
}
