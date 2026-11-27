import type { AdminAction, AdminChatList, AdminChatMessage, AdminChatPage, AdminChatSummary, AdminReasons, AdminUserDetail, AdminUserSummary, Permission } from '@app/shared';
import { adminWith } from './panel';

/** People and records as the admin API answers them, for the user pages' tests. */

export const READ: Permission[] = ['users.read'];
export const MODERATOR: Permission[] = ['users.read', 'users.warn', 'users.suspend', 'users.ban', 'users.shadowban', 'users.lift', 'users.revoke_sessions', 'reports.read', 'moderation.read', 'moderation.decide'];
export const ADMIN: Permission[] = [...MODERATOR, 'users.view_phone', 'users.edit', 'users.delete', 'audit.read'];

export const moderatorAdmin = adminWith(MODERATOR, ['moderator']);
export const fullAdmin = adminWith(ADMIN, ['admin']);
export const readOnlyAdmin = adminWith(READ, ['support']);

export function summary(id: string, overrides: Partial<AdminUserSummary> = {}): AdminUserSummary {
  return {
    id,
    name: `Person ${id.slice(0, 3)}`,
    status: 'active',
    shadowbanned: false,
    test: false,
    verified: false,
    country: 'IR',
    createdAt: '2026-11-20T10:00:00.000Z',
    lastActiveOn: '2026-11-25',
    ...overrides,
  };
}

export const SARA = 'saraaaaaaaaaa';

export function action(id: string, overrides: Partial<AdminAction> = {}): AdminAction {
  return {
    id,
    kind: 'warning',
    reason: 'spam',
    reasonText: 'Please stop sending links.',
    note: null,
    startsAt: '2026-11-21T09:00:00.000Z',
    endsAt: null,
    revokedAt: null,
    admin: { id: '3', displayName: 'Mina' },
    revokedBy: null,
    reportId: null,
    standing: true,
    appeal: null,
    ...overrides,
  };
}

export function detail(overrides: Partial<AdminUserDetail> = {}): AdminUserDetail {
  return {
    ...summary(SARA, { name: 'Sara Ahmadi' }),
    locale: 'fa',
    gender: 'woman',
    birthDate: '1995-03-01',
    deletedAt: null,
    purgeAt: null,
    deletedVia: null,
    restoreStatus: null,
    onboardingStep: 20,
    phoneOnFile: true,
    googleOnFile: false,
    heldNow: false,
    profile: {
      name: 'Sara Ahmadi',
      about: 'I like mountains',
      job: 'Architect',
      textState: 'checking',
      completeness: 70,
      version: 12,
      prompts: [
        { position: 0, promptId: 4, question: { en: 'A good day', fa: 'یک روز خوب' }, answer: 'Tea at sunrise', status: 'checking' },
        { position: 1, promptId: 5, question: { en: 'My travel', fa: 'سفر من' }, answer: 'Yazd', status: 'approved' },
      ],
    },
    standing: [],
    openReports: { count: 2, more: false },
    ...overrides,
  };
}

const texts = (en: string, fa: string, tr: string) => ({ en, fa, tr });

export const reasons: AdminReasons = {
  moderation: [
    { reason: 'fake', texts: texts('Your profile does not appear to represent a real person.', 'به نظر نمی‌رسد پروفایل شما متعلق به یک شخص واقعی باشد.', 'Profiliniz gerçek bir kişiyi temsil ediyor görünmüyor.') },
    { reason: 'harassment', texts: texts('You harassed or bullied other members.', 'شما دیگر کاربران را آزار داده‌اید یا مزاحمشان شده‌اید.', 'Diğer üyeleri taciz ettiniz veya rahatsız ettiniz.') },
    { reason: 'spam', texts: texts('Your account sent spam or unwanted promotion.', 'از حساب شما پیام‌های ناخواسته یا تبلیغاتی فرستاده شده است.', 'Hesabınızdan istenmeyen mesaj veya reklam gönderildi.') },
  ],
  photo: [],
  text: [],
};

/** The empty tabs a page reads when it opens on the profile. */
export const emptyPhotos = { items: [] };

// ─── Chats ──────────────────────────────────────────────────────────────

/** The admin role as seeded: the user page's chats come with users.chats (0033). */
export const CHATS_ADMIN: Permission[] = [...ADMIN, 'users.chats'];
export const chatsAdmin = adminWith(CHATS_ADMIN, ['admin']);

export const LEO = 'leooooooooooo';

export function chatSummary(id: string, overrides: Partial<AdminChatSummary> = {}): AdminChatSummary {
  return {
    id,
    other: { id: LEO, name: 'Leo Brandt', status: 'active' },
    state: 'active',
    source: 'like',
    startedAt: '2026-11-03T10:00:00.000Z',
    endedAt: null,
    endedBy: null,
    lastActivityAt: '2026-11-25T14:05:00.000Z',
    messages: { count: 12, more: false },
    held: false,
    visibility: { subjectSeesOther: true, otherSeesSubject: true },
    retentionDays: null,
    ...overrides,
  };
}

export function chatMessage(id: string, overrides: Partial<AdminChatMessage> = {}): AdminChatMessage {
  return {
    id,
    from: 'other',
    kind: 'text',
    flags: [],
    body: `Message ${id}`,
    refId: null,
    at: '2026-11-25T14:00:00.000Z',
    unsentAt: null,
    shadowed: false,
    pending: false,
    ...overrides,
  };
}

export function chatPage(conversation: AdminChatSummary, items: AdminChatMessage[], overrides: Partial<AdminChatPage> = {}): AdminChatPage {
  return { conversation, items, nextCursor: null, stream: 'complete', ...overrides };
}

export function chatList(items: AdminChatSummary[], nextCursor: string | null = null, overrides: Partial<AdminChatList> = {}): AdminChatList {
  return { items, nextCursor, streamComplete: true, ...overrides };
}
