import {
  PUBLIC_UID_PATTERN,
  FREE_PLAN_KEY,
  GRANT_DAYS_MAX,
  GRANT_START_AHEAD_DAYS_MAX,
  WALLET_CORRECTION_MAX,
  WALLET_GIFT_MAX,
  walletItem,
  type AdminGrantList,
  type AdminMe,
  type AdminPlan,
  type AdminUserPurchases,
  type AdminUserWallet,
  type AdminWalletAdjustmentList,
  type GrantState,
  type WalletBalance,
  type WalletItem,
} from '@app/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { MessageKey } from '@/i18n/messages';
import { apiRequest } from './api';
import { asciiDigits } from './format';
import { queryClient } from './queries';
import { can } from './session';

/**
 * Plan days given by admins and the wallet's admin rows (gifts and
 * corrections). A write carries a `requestId` made once per dialog, so a
 * second click or a retry after a lost answer does the write once (the API
 * answers 409 `duplicate_request`, which the panel treats as done).
 */

export type GrantFilter = 'all' | 'active';

export const grantKeys = {
  list: (state: GrantFilter, user: string | null) => ['grants', state, user ?? ''] as const,
  adjustments: ['walletAdjustments'] as const,
};

const PAGE = 25;

/** Grants: all newest first, or the running and coming ones by their end; `user` one person's. */
export function useGrants(state: GrantFilter, user: string | null = null, enabled = true) {
  return useInfiniteQuery({
    queryKey: grantKeys.list(state, user),
    enabled,
    initialPageParam: null as string | null,
    getNextPageParam: (last: AdminGrantList) => last.nextCursor,
    queryFn: ({ pageParam, signal }) => {
      const query = new URLSearchParams({ state, limit: String(PAGE) });
      if (user) query.set('user', user);
      if (pageParam) query.set('cursor', pageParam);
      return apiRequest<AdminGrantList>(`/v1/admin/grants?${query.toString()}`, { signal });
    },
  });
}

/** Every admin gift and correction of a wallet, newest first. */
export function useWalletAdjustments(enabled = true) {
  return useInfiniteQuery({
    queryKey: grantKeys.adjustments,
    enabled,
    initialPageParam: null as string | null,
    getNextPageParam: (last: AdminWalletAdjustmentList) => last.nextCursor,
    queryFn: ({ pageParam, signal }) => apiRequest<AdminWalletAdjustmentList>(`/v1/admin/wallet-adjustments?limit=${PAGE}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`, { signal }),
  });
}

/** After a grant, an end or a wallet write: the lists and the person's tabs read again. */
export function giftsChanged(userId: string): void {
  void queryClient.invalidateQueries({ queryKey: ['grants'] });
  void queryClient.invalidateQueries({ queryKey: grantKeys.adjustments });
  for (const tab of ['purchases', 'wallet']) void queryClient.invalidateQueries({ queryKey: ['user', userId, tab] });
}

/** Days of a plan and wallet gifts: `billing.grant`, or `users.gift` (a user-page action). */
export const mayGift = (me: AdminMe | null): boolean => can(me, 'billing.grant') || can(me, 'users.gift');
/** Corrections of any balance and ending a grant early: `billing.grant` only. */
export const mayCorrect = (me: AdminMe | null): boolean => can(me, 'billing.grant');

export const grantTone: Readonly<Record<GrantState, 'green' | 'blue' | 'gray' | 'red'>> = {
  scheduled: 'blue',
  active: 'green',
  ended: 'gray',
  revoked: 'red',
};

/** A grant that can still end early: running or to come. */
export const grantEndable = (state: GrantState): boolean => state === 'active' || state === 'scheduled';

/** The plans a grant may give: every one but free and the archived ones, by rank. */
export function grantPlans(plans: readonly AdminPlan[]): AdminPlan[] {
  return plans.filter((plan) => plan.key !== FREE_PLAN_KEY && plan.archivedAt === null).sort((a, b) => a.rank - b.rank);
}

/** The latest end of the person's live subscriptions of `plan` (any store), as an instant; null when they hold none. */
export function currentPlanEnd(purchases: AdminUserPurchases | undefined, plan: string): string | null {
  const ends = (purchases?.subscriptions ?? []).filter((s) => s.plan === plan && Date.parse(s.expiresAt) > Date.now()).map((s) => s.expiresAt);
  return ends.length === 0 ? null : ends.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
}

export type GrantStart = 'now' | 'after' | 'day';
export const grantStarts: readonly GrantStart[] = ['now', 'after', 'day'];
export const GRANT_QUICK_DAYS = [1, 7, 30] as const;

export interface GrantForm {
  person: string;
  plan: string;
  days: string;
  start: GrantStart;
  /** `YYYY-MM-DD` of a start on a later day (local midnight). */
  day: string;
  reason: string;
}

export type GrantField = 'person' | 'plan' | 'days' | 'start' | 'reason';
export type GrantProblems = Partial<Record<GrantField, MessageKey | undefined>>;

const DAY_MS = 86_400_000;

/** The instant a grant starts: none for now, the current plan's end, or the chosen day's local midnight (today: now). */
export function grantStartsAt(form: Pick<GrantForm, 'start' | 'day'>, currentEnd: string | null, now = Date.now()): string | undefined {
  if (form.start === 'after') return currentEnd ?? undefined;
  if (form.start === 'day' && form.day) {
    const at = new Date(`${form.day}T00:00:00`).getTime();
    return at > now ? new Date(at).toISOString() : undefined;
  }
  return undefined;
}

/** A whole number typed in any digits, or null. */
export function wholeNumber(value: string): number | null {
  const text = asciiDigits(value.trim()).replace(/^\+/, '').replace(/^[−–]/, '-');
  return /^-?\d{1,6}$/.test(text) ? Number(text) : null;
}

export function grantProblems(form: GrantForm, currentEnd: string | null, now = Date.now()): GrantProblems {
  const problems: GrantProblems = {};
  if (!form.person.trim()) problems.person = 'form.required';
  if (!form.plan) problems.plan = 'form.required';
  const days = wholeNumber(form.days);
  if (days === null || days < 1 || days > GRANT_DAYS_MAX) problems.days = 'grantDialog.days.range';
  if (form.start === 'after' && currentEnd === null) problems.start = 'form.required';
  if (form.start === 'day') {
    if (!form.day) problems.start = 'form.required';
    else if (new Date(`${form.day}T00:00:00`).getTime() > now + GRANT_START_AHEAD_DAYS_MAX * DAY_MS) problems.start = 'grant.error.startsTooFar';
  }
  if (form.start === 'after' && currentEnd !== null && Date.parse(currentEnd) > now + GRANT_START_AHEAD_DAYS_MAX * DAY_MS) problems.start = 'grant.error.startsTooFar';
  if (!form.reason.trim()) problems.reason = 'form.required';
  return problems;
}

export const walletItems: readonly WalletItem[] = walletItem.names;
export const walletBalances: readonly WalletBalance[] = ['gifts', 'play', 'bazaar'];
export type WalletKind = 'gift' | 'correction';

export interface WalletForm {
  person: string;
  kind: WalletKind;
  item: WalletItem;
  amount: string;
  balance: WalletBalance;
  note: string;
}

export type WalletField = 'person' | 'amount' | 'note';
export type WalletProblems = Partial<Record<WalletField, MessageKey | undefined>>;

export function walletProblems(form: WalletForm): WalletProblems {
  const problems: WalletProblems = {};
  if (!form.person.trim()) problems.person = 'form.required';
  const amount = wholeNumber(form.amount);
  if (form.kind === 'gift' && (amount === null || amount < 1 || amount > WALLET_GIFT_MAX)) problems.amount = 'walletAdjust.amount.giftRange';
  if (form.kind === 'correction' && (amount === null || amount === 0 || Math.abs(amount) > WALLET_CORRECTION_MAX)) problems.amount = 'walletAdjust.amount.correctionRange';
  if (!form.note.trim()) problems.note = 'form.required';
  return problems;
}

/** The balance of one item in one balance (gifts: the server's own, store null) from a wallet page. */
export function balanceOf(wallet: AdminUserWallet | undefined, item: WalletItem, balance: WalletBalance): number | null {
  if (!wallet) return null;
  const store = balance === 'gifts' ? null : balance;
  return wallet.balances.find((b) => b.item === item && b.store === store)?.balance ?? 0;
}

/** A typed public id as the API reads it (lower case, Latin digits). */
export const personId = (value: string): string => asciiDigits(value.trim()).toLowerCase();

/** Whether a typed person id can be a public id (checked before any request). */
export const personIdValid = (value: string): boolean => PUBLIC_UID_PATTERN.test(personId(value));

/** A fresh id for one dialog's write. */
export function newRequestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
