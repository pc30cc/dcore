import type { AdminConfigItem, AdminConfigKey } from '@app/shared';
import { Info, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadError, TableSkeleton } from '@/components/QueryState';
import { Alert, AlertDescription } from '@/components/ui/alert';
import type { Wording } from '@/i18n/translate';
import { useI18n } from '@/i18n/useI18n';
import { useAppConfig } from '@/lib/appSettings';
import { can } from '@/lib/session';
import { useSession } from '@/lib/useSession';
import { CallsCard, CountriesCard, LegalCard, LimitsCard, MaintenanceCard, RetentionCard, SignupCard, VersionsCard, type CardNotice } from './ConfigCards';

type CardId = 'versions' | 'maintenance' | 'signup' | 'calls' | 'countries' | 'limits' | 'legal' | 'retention';

/**
 * `/app/config`: the app's settings, one card each (versions, maintenance,
 * sign-up, calls, countries, limits, legal, retention). A key the API does
 * not answer is not drawn. Each card is keyed by its settings' versions, so
 * it starts again from what is stored after a save or a newer read; its
 * last refusal lives here, so it outlives that.
 */
export function AppConfigPage() {
  const { t } = useI18n();
  const { me } = useSession();
  const config = useAppConfig();
  const [notices, setNotices] = useState<Partial<Record<CardId, Wording | null>>>({});

  if (config.isPending) return <TableSkeleton rows={8} />;
  if (config.isError) return <LoadError error={config.error} onRetry={() => void config.refetch()} />;

  const items = Object.fromEntries(config.data.items.map((item) => [item.key, item])) as Partial<Record<AdminConfigKey, AdminConfigItem>>;
  const notice = (card: CardId): CardNotice => ({
    notice: notices[card] ?? null,
    setNotice: (text) => setNotices((held) => ({ ...held, [card]: text })),
  });
  const versionOf = (...keys: AdminConfigKey[]) => keys.map((key) => items[key]?.version ?? '').join(':');
  const writesAny = config.data.items.some((item) => item.write !== null && can(me, item.write));
  const retention = config.data.items.filter((item) => item.key.startsWith('retention.'));

  return (
    <div className="mx-auto grid max-w-5xl grid-cols-1 gap-6">
      <PageHeader icon={SlidersHorizontal} title={t('appConfig.title')} />
      {!writesAny && (
        <Alert>
          <Info aria-hidden="true" />
          <AlertDescription>{t('appConfig.readOnly')}</AlertDescription>
        </Alert>
      )}
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
        {items['app.min_version'] && <VersionsCard key={versionOf('app.min_version')} item={items['app.min_version']} {...notice('versions')} />}
        {items['app.maintenance'] && <MaintenanceCard key={versionOf('app.maintenance')} item={items['app.maintenance']} {...notice('maintenance')} />}
        {items['onboarding.waitlist'] && <SignupCard key={versionOf('onboarding.waitlist')} item={items['onboarding.waitlist']} {...notice('signup')} />}
        {items['calls.enabled'] && <CallsCard key={versionOf('calls.enabled')} item={items['calls.enabled']} {...notice('calls')} />}
        {items['signup.countries'] && <CountriesCard key={versionOf('signup.countries')} item={items['signup.countries']} {...notice('countries')} />}
        {items['limits.rates'] && <LimitsCard key={versionOf('limits.rates')} item={items['limits.rates']} {...notice('limits')} />}
        {items['legal.versions'] && items['safety.child_safety_contact'] && (
          <LegalCard key={versionOf('legal.versions', 'safety.child_safety_contact')} versions={items['legal.versions']} contact={items['safety.child_safety_contact']} {...notice('legal')} />
        )}
        {retention.length > 0 && <RetentionCard key={retention.map((item) => item.version).join(':')} items={items} {...notice('retention')} />}
      </div>
    </div>
  );
}
