import type {
  AdminAccount,
  AdminAppeal,
  AdminAppearance,
  AdminAuditAdmin,
  AdminBannedTerm,
  AdminDeviceBan,
  AdminHold,
  AdminPlan,
  AdminProduct,
  AdminQueuePhoto,
  AdminReasons,
  AdminReportDetail,
  AdminReportSummary,
  AdminReportView,
  AdminTextItem,
  AdminUserDetail,
  AdminUserFilter,
  AdminUserSummary,
  AppStore,
  AuditEntry,
  DeviceBanKind,
  planFeatureCatalog,
} from '@app/shared';
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
  appearance: ['appearance'] as const,
  users: (filter: AdminUserFilter | 'all') => ['users', filter] as const,
  user: (id: string) => ['user', id] as const,
  /** One tab of a person's page (`param`: its view, e.g. the reports side). */
  userTab: (id: string, tab: string, param = '') => ['user', id, tab, param] as const,
  reasons: ['reasons'] as const,
  photoQueue: ['photoQueue'] as const,
  textQueue: ['textQueue'] as const,
  reports: (view: AdminReportView) => ['reports', view] as const,
  report: (id: string) => ['report', id] as const,
  holds: (state: 'active' | 'released') => ['holds', state] as const,
  appeals: (status: 'open' | 'decided') => ['appeals', status] as const,
  terms: (q: string) => ['terms', q] as const,
  deviceBans: (kind: DeviceBanKind | 'all') => ['deviceBans', kind] as const,
  audit: (query: string) => ['audit', query] as const,
  auditAdmins: ['auditAdmins'] as const,
};

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

function pagePath(path: string, cursor: string | null, limit: number): string {
  const join = path.includes('?') ? '&' : '?';
  return `${path}${join}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
}

/** People, newest first (one filter at a time, from its index). */
export function useUsers(filter: AdminUserFilter | null) {
  return useInfiniteQuery({
    queryKey: queryKeys.users(filter ?? 'all'),
    initialPageParam: null as string | null,
    getNextPageParam: (last: Page<AdminUserSummary>) => last.nextCursor,
    queryFn: ({ pageParam, signal }) => apiRequest<Page<AdminUserSummary>>(pagePath(`/v1/admin/users${filter ? `?filter=${filter}` : ''}`, pageParam, 20), { signal }),
  });
}

export function useUser(id: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.user(id),
    queryFn: ({ signal }) => apiRequest<AdminUserDetail>(`/v1/admin/users/${id}`, { signal }),
    enabled,
  });
}

/** A tab read once, on its first open. */
export function useUserTab<T>(id: string, tab: string, path: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.userTab(id, tab),
    enabled,
    queryFn: ({ signal }) => apiRequest<T>(path, { signal }),
  });
}

/** A paged tab (newest first, "Load more"). */
export function useUserPages<T>(id: string, tab: string, path: string, param = '', enabled = true) {
  return useInfiniteQuery({
    queryKey: queryKeys.userTab(id, tab, param),
    enabled,
    initialPageParam: null as string | null,
    getNextPageParam: (last: Page<T>) => last.nextCursor,
    queryFn: ({ pageParam, signal }) => apiRequest<Page<T>>(pagePath(path, pageParam, 20), { signal }),
  });
}

/** Every reason with the text a person reads in each language (rarely changes). */
export function useReasons(enabled = true) {
  return useQuery({
    queryKey: queryKeys.reasons,
    enabled,
    staleTime: 600_000,
    queryFn: ({ signal }) => apiRequest<AdminReasons>('/v1/admin/moderation/reasons', { signal }),
  });
}

// ─── Moderation ─────────────────────────────────────────────────────────

/** A paged list read on demand ("Load more"), oldest or newest first as the route answers. */
function usePages<T>(queryKey: readonly unknown[], path: string, limit: number, enabled = true) {
  return useInfiniteQuery({
    queryKey,
    enabled,
    initialPageParam: null as string | null,
    getNextPageParam: (last: Page<T>) => last.nextCursor,
    queryFn: ({ pageParam, signal }) => apiRequest<Page<T>>(pagePath(path, pageParam, limit), { signal }),
  });
}

/** Photos waiting for a human, oldest first. */
export function usePhotoQueue(enabled = true) {
  return usePages<AdminQueuePhoto>(queryKeys.photoQueue, '/v1/admin/moderation/photos', 24, enabled);
}

/** People with a text waiting, by account. */
export function useTextQueue(enabled = true) {
  return usePages<AdminTextItem>(queryKeys.textQueue, '/v1/admin/moderation/texts', 20, enabled);
}

export function useReports(view: AdminReportView) {
  return usePages<AdminReportSummary>(queryKeys.reports(view), `/v1/admin/reports?view=${view}`, 25);
}

export function useReport(id: string) {
  return useQuery({
    queryKey: queryKeys.report(id),
    queryFn: ({ signal }) => apiRequest<AdminReportDetail>(`/v1/admin/reports/${id}`, { signal }),
  });
}

export function useHolds(state: 'active' | 'released') {
  return usePages<AdminHold>(queryKeys.holds(state), `/v1/admin/holds?state=${state}`, 25);
}

export function useAppeals(status: 'open' | 'decided') {
  return usePages<AdminAppeal>(queryKeys.appeals(status), `/v1/admin/appeals?status=${status}`, 20);
}

// ─── Rules and records ──────────────────────────────────────────────────

/** Banned terms, newest first; `q` a part of the term. */
export function useTerms(q: string) {
  return usePages<AdminBannedTerm>(queryKeys.terms(q), `/v1/admin/banned-terms${q ? `?q=${encodeURIComponent(q)}` : ''}`, 50);
}

/** Device, phone and Google-account bans, newest first. */
export function useDeviceBans(kind: DeviceBanKind | null) {
  return usePages<AdminDeviceBan>(queryKeys.deviceBans(kind ?? 'all'), `/v1/admin/device-bans${kind ? `?kind=${kind}` : ''}`, 50);
}

/** The audit log for a query string of filters (already encoded, without cursor and limit). */
export function useAudit(query: string) {
  return usePages<AuditEntry>(queryKeys.audit(query), `/v1/admin/audit${query ? `?${query}` : ''}`, 50);
}

export function useAuditAdmins(enabled = true) {
  return useQuery({
    queryKey: queryKeys.auditAdmins,
    enabled,
    staleTime: 300_000,
    queryFn: ({ signal }) => apiRequest<{ items: AdminAuditAdmin[] }>('/v1/admin/audit/admins', { signal }),
  });
}

/** Drops one item from a cached paged list (a decided photo, text or appeal leaves its queue). */
export function dropFromPages<T>(queryKey: readonly unknown[], keep: (item: T) => boolean): void {
  queryClient.setQueryData<{ pages: Page<T>[]; pageParams: unknown[] }>(queryKey, (data) =>
    data ? { ...data, pages: data.pages.map((page) => ({ ...page, items: page.items.filter(keep) })) } : data,
  );
}

/** Puts a person's page as a write answered it into the cache, and drops what the write made stale. */
export function storeUser(user: AdminUserDetail, stale: readonly string[] = []): void {
  queryClient.setQueryData(queryKeys.user(user.id), user);
  for (const tab of stale) void queryClient.invalidateQueries({ queryKey: ['user', user.id, tab] });
  void queryClient.invalidateQueries({ queryKey: ['users'] });
}

export interface PlanList {
  items: AdminPlan[];
  catalog: ReturnType<typeof planFeatureCatalog>;
}

export function usePlans(enabled = true) {
  return useQuery({
    queryKey: queryKeys.plans,
    queryFn: ({ signal }) => apiRequest<PlanList>('/v1/admin/plans', { signal }),
    enabled,
  });
}

/** The default template and, for every template this build knows, whether people may choose it. */
export function useAppearance() {
  return useQuery({
    queryKey: queryKeys.appearance,
    queryFn: ({ signal }) => apiRequest<AdminAppearance>('/v1/admin/appearance', { signal }),
  });
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
  return useQuery({
    queryKey: queryKeys.roles,
    enabled,
    staleTime: 300_000,
    queryFn: ({ signal }) => apiRequest<{ items: AdminRole[] }>('/v1/admin/roles', { signal }),
  });
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
  return useQuery({
    queryKey: queryKeys.sessions,
    queryFn: ({ signal }) =>
      apiRequest<{ items: AdminSession[] }>('/v1/admin/me/sessions', {
        signal,
      }),
  });
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
    return {
      items: found ? list.items.map((item) => (item.id === product.id ? product : item)) : [...list.items, product],
    };
  });
}
