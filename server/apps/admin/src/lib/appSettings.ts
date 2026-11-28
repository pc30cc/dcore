import type { AdminBrand, AdminConfigItem, AdminConfigKey, AdminConfigList, AdminProvider, AdminProviders, RtcSettingsView } from '@app/shared';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from './api';
import { queryClient } from './queries';

/**
 * The app area's reads: the app settings (`/v1/admin/config`), the brand,
 * the providers and the calls network. Each read carries a version; a save
 * names the version its form was built from, and its answer replaces what
 * the page holds (the card or dialog then starts again from it).
 */

/** The settings `/app/config` edits (the SMS routing lives on the providers page). */
export const CONFIG_PAGE_KEYS = [
  'app.min_version',
  'app.maintenance',
  'onboarding.waitlist',
  'signup.countries',
  'calls.enabled',
  'limits.rates',
  'legal.versions',
  'safety.child_safety_contact',
  'retention.deleted_account_days',
  'retention.message_requests_days',
  'retention.unsent_body_hours',
  'retention.report_evidence_days',
  'retention.unmatched_messages_days',
] as const satisfies readonly AdminConfigKey[];

export const ROUTING_KEY = 'auth.sms_routing' satisfies AdminConfigKey;

export const appKeys = {
  config: ['app', 'config'] as const,
  routing: ['app', 'routing'] as const,
  brand: ['app', 'brand'] as const,
  providers: ['app', 'providers'] as const,
  rtc: ['app', 'rtc'] as const,
};

function readConfig(keys: readonly AdminConfigKey[], signal: AbortSignal) {
  return apiRequest<AdminConfigList>(`/v1/admin/config?keys=${keys.map(encodeURIComponent).join(',')}`, { signal });
}

export function useAppConfig() {
  return useQuery({
    queryKey: appKeys.config,
    queryFn: ({ signal }) => readConfig(CONFIG_PAGE_KEYS, signal),
  });
}

/** The SMS routing (read with `config.read`, written with `config.providers`). */
export function useSmsRouting(enabled = true) {
  return useQuery({
    queryKey: appKeys.routing,
    enabled,
    queryFn: ({ signal }) => readConfig([ROUTING_KEY], signal),
  });
}

export function useBrandSettings() {
  return useQuery({
    queryKey: appKeys.brand,
    queryFn: ({ signal }) => apiRequest<AdminBrand>('/v1/admin/brand', { signal }),
  });
}

export function useProviders() {
  return useQuery({
    queryKey: appKeys.providers,
    queryFn: ({ signal }) => apiRequest<AdminProviders>('/v1/admin/providers', { signal }),
  });
}

export function useRtcSettings() {
  return useQuery({
    queryKey: appKeys.rtc,
    queryFn: ({ signal }) => apiRequest<RtcSettingsView>('/v1/admin/providers/rtc', { signal }),
  });
}

/** One setting as the API now has it, in every read that holds it. */
export function storeConfigItem(item: AdminConfigItem): void {
  for (const key of [appKeys.config, appKeys.routing]) {
    queryClient.setQueryData<AdminConfigList>(key, (list) =>
      list
        ? {
            items: list.items.map((held) => (held.key === item.key ? item : held)),
          }
        : list,
    );
  }
}

/** Saves one setting with the version it was read at (the caller stores the answer). */
export async function putConfig(key: AdminConfigKey, value: unknown, baseVersion: string): Promise<AdminConfigItem> {
  const { item } = await apiRequest<{ item: AdminConfigItem }>(`/v1/admin/config/${encodeURIComponent(key)}`, { method: 'PUT', body: { value, baseVersion } });
  return item;
}

/** A provider as the API now has it. */
export function storeProvider(provider: AdminProvider): void {
  queryClient.setQueryData<AdminProviders>(appKeys.providers, (view) =>
    view
      ? {
          ...view,
          items: view.items.map((held) => (held.kind === provider.kind ? provider : held)),
        }
      : view,
  );
}

/** The latest change of a group of settings (a card's footer line). */
export function latestChange(items: readonly AdminConfigItem[]): Pick<AdminConfigItem, 'updatedAt' | 'updatedBy'> | null {
  let latest: AdminConfigItem | null = null;
  for (const item of items) {
    if (item.updatedAt && (!latest?.updatedAt || Date.parse(item.updatedAt) > Date.parse(latest.updatedAt))) latest = item;
  }
  return latest ? { updatedAt: latest.updatedAt, updatedBy: latest.updatedBy } : null;
}
