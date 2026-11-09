import type { PlanFlag, PlanQuota } from '@app/shared';
import type { MessageKey } from '@/i18n/messages';
import type { PlanBadge, PlanStatus } from '@/lib/plans';

/** The words of every switch, quota, badge and status the editor shows. */

export const flagGroups: readonly { label: MessageKey; flags: readonly PlanFlag[] }[] = [
  { label: 'plan.flags.group.discovery', flags: ['see_likes', 'priority_likes', 'second_look', 'rewind', 'advanced_filters', 'travel_mode'] },
  { label: 'plan.flags.group.privacy', flags: ['incognito', 'profile_views', 'read_receipts'] },
  { label: 'plan.flags.group.calls', flags: ['audio_calls', 'video_calls'] },
];

export const flagText: Readonly<Record<PlanFlag, { label: MessageKey; help: MessageKey }>> = {
  see_likes: { label: 'plan.flag.see_likes', help: 'plan.flag.see_likes.help' },
  rewind: { label: 'plan.flag.rewind', help: 'plan.flag.rewind.help' },
  read_receipts: { label: 'plan.flag.read_receipts', help: 'plan.flag.read_receipts.help' },
  incognito: { label: 'plan.flag.incognito', help: 'plan.flag.incognito.help' },
  travel_mode: { label: 'plan.flag.travel_mode', help: 'plan.flag.travel_mode.help' },
  advanced_filters: { label: 'plan.flag.advanced_filters', help: 'plan.flag.advanced_filters.help' },
  profile_views: { label: 'plan.flag.profile_views', help: 'plan.flag.profile_views.help' },
  second_look: { label: 'plan.flag.second_look', help: 'plan.flag.second_look.help' },
  priority_likes: { label: 'plan.flag.priority_likes', help: 'plan.flag.priority_likes.help' },
  audio_calls: { label: 'plan.flag.audio_calls', help: 'plan.flag.audio_calls.help' },
  video_calls: { label: 'plan.flag.video_calls', help: 'plan.flag.video_calls.help' },
};

export const quotaText: Readonly<Record<PlanQuota, { label: MessageKey; help: MessageKey }>> = {
  daily_likes: { label: 'plan.quota.daily_likes', help: 'plan.quota.daily_likes.help' },
  weekly_superlikes: { label: 'plan.quota.weekly_superlikes', help: 'plan.quota.weekly_superlikes.help' },
  daily_dm: { label: 'plan.quota.daily_dm', help: 'plan.quota.daily_dm.help' },
  weekly_dm_gift: { label: 'plan.quota.weekly_dm_gift', help: 'plan.quota.weekly_dm_gift.help' },
  monthly_boosts: { label: 'plan.quota.monthly_boosts', help: 'plan.quota.monthly_boosts.help' },
};

export const badgeText: Readonly<Record<PlanBadge, MessageKey>> = {
  popular: 'badge.popular',
  best_value: 'badge.best_value',
  new: 'badge.new',
};

export const statusText: Readonly<Record<PlanStatus, { label: MessageKey; tone: 'green' | 'amber' | 'gray' | 'blue' }>> = {
  free: { label: 'plan.status.free', tone: 'blue' },
  onSale: { label: 'plan.status.onSale', tone: 'green' },
  paused: { label: 'plan.status.paused', tone: 'amber' },
  archived: { label: 'plan.status.archived', tone: 'gray' },
};
