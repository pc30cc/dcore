import { deviceBanKind, isAutomaticBanReason, moderationReason, type AdminDeviceBan, type DeviceBanKind, type ModerationReason } from '@app/shared';
import type { MessageKey } from '@/i18n/messages';
import type { Translate } from '@/i18n/translate';

/** Device, phone and Google-account bans in the panel: the kinds and the end a choice gives. */

export const banKinds: readonly DeviceBanKind[] = deviceBanKind.names;

export const isBanKind = (value: string | null): value is DeviceBanKind => value !== null && deviceBanKind.has(value);

export type BanExpiry = 'permanent' | '30d' | '1y' | 'date';

const DAY_MS = 86_400_000;

/** The end of a ban: a preset counts from now, a date ends at the end of that day in the admin's time zone; permanent is none. */
export function banExpiry(choice: BanExpiry, date: string, now: number): { expiresAt?: string; error?: MessageKey } {
  if (choice === 'permanent') return {};
  if (choice === '30d') return { expiresAt: new Date(now + 30 * DAY_MS).toISOString() };
  if (choice === '1y') return { expiresAt: new Date(now + 365 * DAY_MS).toISOString() };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'action.error.date' };
  const at = new Date(`${date}T23:59:00`).getTime();
  if (Number.isNaN(at) || at < now + 60_000) return { error: 'action.error.untilPast' };
  return { expiresAt: new Date(at).toISOString() };
}

const DIGITS = /[\u06f0-\u06f9\u0660-\u0669]/g;

/**
 * A number written the local way (a leading 0, not 00): the API takes
 * numbers with their country code only, so the panel says so without
 * spending a lookup.
 */
export function lacksCountryCode(value: string): boolean {
  const compact = value.replace(/[\s\u200c\u200e\u200f().-]/g, '').replace(DIGITS, (d) => {
    const code = d.charCodeAt(0);
    return String(code - (code >= 0x06f0 ? 0x06f0 : 0x0660));
  });
  return /^0[1-9]/.test(compact);
}

/**
 * A ban's reason as the panel shows it: the words for a reason the server
 * writes by itself (no admin, no action: `under_age`), else the text as typed.
 */
export function banReasonText(ban: Pick<AdminDeviceBan, 'reason' | 'createdBy' | 'actionId'>, t: Translate): string {
  if (ban.createdBy === null && ban.actionId === null && isAutomaticBanReason(ban.reason)) return t(`deviceBans.reason.${ban.reason}`);
  // Made with a suspension or a ban, without a note: that action's reason.
  const code = ban.actionId !== null ? ACTION_REASON.exec(ban.reason)?.[1] : undefined;
  if (code !== undefined && (moderationReason.names as readonly string[]).includes(code)) return t(`reason.moderation.${code as ModerationReason}`);
  return ban.reason;
}

const ACTION_REASON = /^moderation:([a-z_0-9]+)$/;

/** The reason a ban made with a suspension or a ban stores when the admin wrote no note: a code, worded on display. */
export function actionBanReason(reason: ModerationReason | ''): string {
  return `moderation:${reason || 'other'}`;
}
