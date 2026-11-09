import type { AdminAccount, AdminPlan, AdminProduct, AppStore, planFeatureCatalog } from '@app/shared';
import { QueryClient, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { apiRequest } from './api';
import { ApiError } from './http';
import { subscribeSession, sessionState } from './session';

/**
 * The admin API's reads, cached per page view. Admin reads go to the
 * database (one statement each), so the panel does not refetch on focus or
 * on a timer; a write updates or invalidates what it changed.
 */

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: (failures, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && failures < 2,
    },
    mutations: { retry: false },
  },
});

// Nothing cached outlives the session it was read in.
subscribeSession(() => {
  if (sessionState().status !== 'signedIn') queryClient.clear();
});

export const queryKeys = {
  plans: ['plans'] as const,
  products: (store: AppStore) => ['products', store] as const,
  admins: ['admins'] as const,
  roles: ['roles'] as const,
  sessions: ['sessions'] as const,
};

export interface PlanList {
  items: AdminPlan[];
  catalog: ReturnType<typeof planFeatureCatalog>;
}

export function usePlans() {
  return useQuery({ queryKey: queryKeys.plans, queryFn: ({ signal }) => apiRequest<PlanList>('/v1/admin/plans', { signal }) });
}

export function useProducts(store: AppStore) {
  return useQuery({
    queryKey: queryKeys.products(store),
    queryFn: ({ signal }) => apiRequest<{ items: AdminProduct[] }>(`/v1/admin/store-products?store=${store}`, { signal }),
  });
}

export interface AdminRole {
  key: string;
  names: Record<string, string>;
  grants: string[];
  permissions: string[];
}

export function useRoles(enabled = true) {
  return useQuery({ queryKey: queryKeys.roles, enabled, staleTime: 300_000, queryFn: ({ signal }) => apiRequest<{ items: AdminRole[] }>('/v1/admin/roles', { signal }) });
}

export function useAdmins() {
  return useInfiniteQuery({
    queryKey: queryKeys.admins,
    initialPageParam: null as string | null,
    getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor,
    queryFn: ({ pageParam, signal }) =>
      apiRequest<{ items: AdminAccount[]; nextCursor: string | null }>(`/v1/admin/admins?limit=50${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`, { signal }),
  });
}

export interface AdminSession {
  id: string;
  createdAt: string;
  refreshedAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

export function useSessions() {
  return useQuery({ queryKey: queryKeys.sessions, queryFn: ({ signal }) => apiRequest<{ items: AdminSession[] }>('/v1/admin/me/sessions', { signal }) });
}

/** Puts one changed plan into the cached list (the write's own answer), so the list shows it without a new read. */
export function storePlan(plan: AdminPlan): void {
  queryClient.setQueryData<PlanList>(queryKeys.plans, (list) => {
    if (!list) return list;
    const found = list.items.some((item) => item.key === plan.key);
    const items = found ? list.items.map((item) => (item.key === plan.key ? plan : item)) : [...list.items, plan];
    return { ...list, items: items.sort((a, b) => a.rank - b.rank) };
  });
}

export function storeProduct(product: AdminProduct): void {
  queryClient.setQueryData<{ items: AdminProduct[] }>(queryKeys.products(product.store), (list) => {
    if (!list) return list;
    const found = list.items.some((item) => item.id === product.id);
    return { items: found ? list.items.map((item) => (item.id === product.id ? product : item)) : [...list.items, product] };
  });
}
