import type { AdminAppeal, AdminHold, AdminQueuePhoto, AdminReportDetail, AdminReportSummary, AdminTextItem, Permission } from '@app/shared';
import { adminWith } from './panel';
import { action } from './userFixtures';

/** The moderation pages' records as the admin API answers them. */

export const MOD: Permission[] = ['users.read', 'moderation.read', 'moderation.decide', 'reports.read', 'reports.assign', 'reports.resolve', 'reports.view_chat', 'reports.hold', 'appeals.read', 'appeals.decide', 'users.warn', 'users.suspend', 'users.ban', 'users.shadowban', 'users.lift'];
export const moderator = adminWith(MOD, ['moderator']);
/** Reads the queues and reports, decides nothing. */
export const reader = adminWith(['users.read', 'moderation.read', 'reports.read', 'appeals.read'], ['support']);

const uid = (n: number) => `user${'abcdefghij'[n] ?? 'z'}aaaaaaaa`.slice(0, 13);

export function person(n: number, name = `Person ${n}`) {
  return { id: uid(n), name, status: 'active' as const };
}

export function queuePhoto(id: string, n = 1, overrides: Partial<AdminQueuePhoto> = {}): AdminQueuePhoto {
  return {
    id,
    position: 0,
    modFlags: [],
    hasFace: true,
    width: 1080,
    height: 1350,
    uploadedAt: '2026-11-25T10:00:00.000Z',
    user: { ...person(n), age: 29, gender: 'woman', country: 'IR', verified: false },
    others: [],
    ...overrides,
  };
}

export function textItem(n: number, overrides: Partial<AdminTextItem> = {}): AdminTextItem {
  return {
    user: person(n),
    version: 10 + n,
    about: { text: `About text ${n}`, state: 'checking' },
    job: null,
    prompts: [{ position: 0, promptId: 4, question: { en: 'A good day', fa: 'یک روز خوب' }, answer: `Answer ${n}`, status: 'checking' }],
    ...overrides,
  };
}

export function reportSummary(id: string, overrides: Partial<AdminReportSummary> = {}): AdminReportSummary {
  return {
    id,
    priority: 60,
    reason: 'harassment',
    context: 'chat',
    status: 'open',
    filedAt: '2026-11-25T09:00:00.000Z',
    reported: person(1, 'Reported One'),
    reporter: person(2, 'Reporter Two'),
    assignee: null,
    evidence: 'complete',
    filed: false,
    ...overrides,
  };
}

export function reportDetail(id: string, overrides: Partial<AdminReportDetail> = {}): AdminReportDetail {
  return {
    ...reportSummary(id),
    details: 'They kept writing after I asked them to stop.',
    conversationId: '5001',
    evidenceAt: '2026-11-25T09:01:00.000Z',
    filings: [
      {
        id,
        at: '2026-11-25T09:00:00.000Z',
        context: 'chat',
        reason: 'harassment',
        details: 'They kept writing after I asked them to stop.',
        conversationId: '5001',
        messages: 2,
        profile: { name: 'Reported One', about: 'Hello there', job: null, textState: 'approved', prompts: [], photos: [{ id: '71', status: 'approved' }] },
      },
    ],
    holds: [],
    filing: null,
    actions: [],
    otherOpen: [],
    history: [],
    ...overrides,
  };
}

export function hold(id: string, overrides: Partial<AdminHold> = {}): AdminHold {
  return {
    id,
    kind: 'authority',
    user: person(1, 'Held Person'),
    conversationId: null,
    reportId: '900',
    createdAt: '2026-11-24T10:00:00.000Z',
    createdBy: { id: '3', displayName: 'Mina' },
    authorityRef: 'REQ-7',
    evidenceCopiedAt: null,
    releasedAt: null,
    releasedBy: null,
    releasedReason: null,
    filing: null,
    ...overrides,
  };
}

export function appeal(id: string, overrides: Partial<AdminAppeal> = {}): AdminAppeal {
  return {
    id,
    status: 'open',
    body: 'I did not do this, please look again.',
    filedAt: '2026-11-25T08:00:00.000Z',
    decisionText: null,
    decidedAt: null,
    decidedBy: null,
    action: action('61', { kind: 'ban', reason: 'harassment', reasonText: 'You harassed other members.', appeal: null }),
    user: { ...person(3, 'Appealing Person'), status: 'banned' },
    history: [action('60', { kind: 'warning', reasonText: 'Please be kind.', standing: false })],
    locale: 'tr',
    ...overrides,
  };
}

export const page = <T>(items: T[], nextCursor: string | null = null) => ({ items, nextCursor });
