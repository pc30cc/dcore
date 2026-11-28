import {
  purchaseState,
  type AdminPurchaseActionResult,
  type AdminPurchaseDetail,
  type AdminPurchaseEventPage,
  type AdminPurchaseList,
  type AdminPurchaseSummary,
  type AppStore,
  type PurchaseAction,
  type PurchaseMatch,
  type PurchaseOutcome,
} from '@app/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { MessageKey } from '@/i18n/messages';
import { apiRequest } from './api';
import { queryClient } from './queries';

/**
 * The purchases of both stores: the list per store (`?store=`, `?state=`
 * in the page's address: nothing personal), one purchase with its events
 * and admin history, and what a write answers. A search's text (an order
 * id, a token) travels in a request body only: never in an address, a
 * query key or the history of the browser.
 */

/** A purchase's state, by its name. */
export type PurchaseState = (typeof purchaseState.names)[number];

export const purchaseKeys = {
  list: (store: AppStore, state: PurchaseState | null) => ['purchases', store, state ?? ''] as const,
  detail: (id: string) => ['purchase', id] as const,
  /** Older events of a purchase, from the cursor its page answered. */
  events: (id: string, from: string) => ['purchase', id, 'events', from] as const,
};

export const purchaseStores: readonly AppStore[] = ['play', 'bazaar'];
export const purchaseStates: readonly PurchaseState[] = purchaseState.names;

const PAGE = 25;

export function isPurchaseState(value: string | null): value is PurchaseState {
  return value !== null && (purchaseStates as readonly string[]).includes(value);
}

/** A store's purchases, newest first (one state at a time), 25 a page. */
export function usePurchases(store: AppStore, state: PurchaseState | null) {
  return useInfiniteQuery({
    queryKey: purchaseKeys.list(store, state),
    initialPageParam: null as string | null,
    getNextPageParam: (last: AdminPurchaseList) => last.nextCursor,
    queryFn: ({ pageParam, signal }) => {
      const query = new URLSearchParams({ store, limit: String(PAGE) });
      if (state) query.set('state', state);
      if (pageParam) query.set('cursor', pageParam);
      return apiRequest<AdminPurchaseList>(`/v1/admin/purchases?${query.toString()}`, { signal });
    },
  });
}

export function usePurchase(id: string) {
  return useQuery({
    queryKey: purchaseKeys.detail(id),
    queryFn: ({ signal }) => apiRequest<AdminPurchaseDetail>(`/v1/admin/purchases/${id}`, { signal }),
  });
}

/**
 * The events older than the purchase page's first 50, read on demand
 * (`enabled` once the admin asks for them), 50 a page.
 */
export function usePurchaseEvents(id: string, from: string | null, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: purchaseKeys.events(id, from ?? ''),
    enabled: enabled && from !== null,
    initialPageParam: from,
    getNextPageParam: (last: AdminPurchaseEventPage) => last.nextCursor,
    queryFn: ({ pageParam, signal }) => apiRequest<AdminPurchaseEventPage>(`/v1/admin/purchases/${id}/events?limit=50${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`, { signal }),
  });
}

/** Puts a purchase as a write answered it into the cache, and drops the lists and older events it made stale. */
export function storePurchase(purchase: AdminPurchaseDetail): void {
  queryClient.setQueryData(purchaseKeys.detail(purchase.id), purchase);
  void queryClient.invalidateQueries({ queryKey: ['purchases'] });
  void queryClient.removeQueries({ queryKey: [...purchaseKeys.detail(purchase.id), 'events'] });
  if (purchase.user) {
    void queryClient.invalidateQueries({ queryKey: ['user', purchase.user.id, 'purchases'] });
    void queryClient.invalidateQueries({ queryKey: ['user', purchase.user.id, 'wallet'] });
  }
}

/** A state's dot: live access green, waiting or at risk amber, over grey, refunded red. */
export const purchaseStateTone: Readonly<Record<PurchaseState, 'green' | 'amber' | 'red' | 'gray'>> = {
  pending: 'amber',
  active: 'green',
  canceled: 'green',
  grace: 'green',
  on_hold: 'amber',
  paused: 'amber',
  expired: 'gray',
  revoked: 'red',
  replaced: 'gray',
  consumed: 'green',
  unclaimed: 'amber',
  purchased: 'green',
};

/** The buttons of a purchase page, in their order; a refund for the unused time is a choice inside the refund dialog. */
export type PurchaseButton = Exclude<PurchaseAction, 'refund_prorated'>;
export const purchaseButtons: readonly PurchaseButton[] = ['recheck', 'cancel', 'refund', 'revoke'];

/** The buttons `available` offers (a prorated refund alone still opens the refund dialog). */
export function offeredButtons(available: readonly PurchaseAction[]): PurchaseButton[] {
  return purchaseButtons.filter((button) => available.includes(button) || (button === 'refund' && available.includes('refund_prorated')));
}

/** The refund modes a dialog offers: full when `refund` is available, for the unused time when `refund_prorated` is. */
export function refundModes(available: readonly PurchaseAction[]): ('full' | 'prorated')[] {
  const modes: ('full' | 'prorated')[] = [];
  if (available.includes('refund')) modes.push('full');
  if (available.includes('refund_prorated')) modes.push('prorated');
  return modes;
}

/** Whether the button's dialog asks for a note (a re-check's is optional). */
export const noteRequired = (button: PurchaseButton): boolean => button !== 'recheck';

export const actionLabel: Readonly<Record<PurchaseButton, MessageKey>> = {
  recheck: 'purchase.action.recheck',
  cancel: 'purchase.action.cancel',
  refund: 'purchase.action.refund',
  revoke: 'purchase.action.revoke',
};

const ACTION_BODY: Readonly<Record<PurchaseButton, MessageKey>> = {
  recheck: 'purchase.action.recheck.body',
  cancel: 'purchase.action.cancel.body',
  refund: 'purchase.action.refund.body',
  revoke: 'purchase.action.revoke.body',
};

/** The confirm's one sentence: a pack gives no access, it takes back what it added to the wallet. */
export function actionBody(button: PurchaseButton, kind: AdminPurchaseSummary['kind']): MessageKey {
  if (kind === 'consumable' && button === 'refund') return 'purchase.action.refund.bodyPack';
  if (kind === 'consumable' && button === 'revoke') return 'purchase.action.revoke.bodyPack';
  return ACTION_BODY[button];
}

/** A history entry names the action (a noun), where a button tells to do it. */
export const historyActionLabel: Readonly<Record<PurchaseButton, MessageKey>> = {
  recheck: 'purchase.history.action.recheck',
  cancel: 'purchase.history.action.cancel',
  refund: 'purchase.history.action.refund',
  revoke: 'purchase.history.action.revoke',
};

export const outcomeText: Readonly<Record<PurchaseOutcome, MessageKey>> = {
  done: 'purchase.done.done',
  already: 'purchase.done.already',
  unchanged: 'purchase.done.unchanged',
  pending: 'purchase.done.pending',
};

/**
 * What an action's answer means: a refund the store would not make of a
 * subscription that had ended there leaves it as the store shows it (ended,
 * nothing refunded now), not refunded.
 */
export function outcomeMessage(button: PurchaseButton, result: Pick<AdminPurchaseActionResult, 'outcome' | 'purchase'>): MessageKey {
  if (button === 'refund' && result.outcome === 'already' && result.purchase.state !== 'revoked') return 'purchase.done.alreadyEnded';
  return outcomeText[result.outcome];
}

export const matchText: Readonly<Record<PurchaseMatch, MessageKey>> = {
  id: 'purchases.matched.id',
  person: 'purchases.matched.person',
  order: 'purchases.matched.order',
  token: 'purchases.matched.token',
};

/** The body of an action: `from` is the state the admin saw, the note trimmed (a re-check sends none when empty). */
export function actionRequest(button: PurchaseButton, purchase: Pick<AdminPurchaseSummary, 'state'>, note: string, prorated: boolean): Record<string, unknown> {
  const text = note.trim();
  if (button === 'recheck') return text ? { note: text } : {};
  if (button === 'refund') return { from: purchase.state, prorated, note: text };
  return { from: purchase.state, note: text };
}

/** What a consumable's credits came to: credited, taken back, and what was spent before a refund (never taken below zero). */
export function walletUse(purchase: Pick<AdminPurchaseDetail, 'state' | 'wallet'>): { credited: number; takenBack: number; used: number | null } | null {
  if (!purchase.wallet) return null;
  const { credited, takenBack } = purchase.wallet;
  return { credited, takenBack, used: purchase.state === 'revoked' && takenBack < credited ? credited - takenBack : null };
}
