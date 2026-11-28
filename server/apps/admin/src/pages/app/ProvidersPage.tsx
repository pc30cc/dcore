import type { AdminProvider, AdminProviders, ProviderKind, SecretView } from '@app/shared';
import { KeyRound, Pencil, RotateCcw, TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadError, TableSkeleton } from '@/components/QueryState';
import { ConfirmDialog } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import type { MessageKey } from '@/i18n/messages';
import { useI18n } from '@/i18n/useI18n';
import { apiRequest } from '@/lib/api';
import { appKeys, storeProvider, useProviders } from '@/lib/appSettings';
import { formatPlain } from '@/lib/format';
import { asApiError } from '@/lib/http';
import { problemText } from '@/lib/problemText';
import { appliedSummary, providerName, providerTone, settingFields, shownValues } from '@/lib/providerForm';
import { queryClient } from '@/lib/queries';
import { can } from '@/lib/session';
import { showToast } from '@/lib/toast';
import { useSession } from '@/lib/useSession';
import { ProviderDialog } from './ProviderDialog';
import { RtcCard } from './RtcCard';
import { SmsRoutingCard } from './SmsRoutingCard';

/**
 * `/app/providers` (owner only): the sign-in message, store, push and call
 * providers. Each row says where its credentials come from (set here, the
 * deployment's, off, unreadable, none), shows its secrets as fingerprints
 * only, and which running servers use them. Storage, LiveKit and photo
 * moderation are the deployment's and shown read-only.
 */
export function ProvidersPage() {
  const { t } = useI18n();
  const { me } = useSession();
  const providers = useProviders();
  const [editing, setEditing] = useState<AdminProvider | null>(null);

  if (providers.isPending) return <TableSkeleton rows={8} />;
  if (providers.isError) return <LoadError error={providers.error} onRetry={() => void providers.refetch()} />;
  const view = providers.data;
  const byKind = (kind: ProviderKind) => view.items.find((item) => item.kind === kind);
  const rows = (kinds: readonly ProviderKind[]) =>
    kinds
      .map((kind) => byKind(kind))
      .filter((item): item is AdminProvider => item !== undefined)
      .map((item) => <ProviderRow key={item.kind} provider={item} appliedKnown={view.appliedKnown} onEdit={() => setEditing(item)} />);

  return (
    <div className="mx-auto grid max-w-5xl grid-cols-1 gap-8">
      <PageHeader icon={KeyRound} title={t('providers.title')} meta={!view.appliedKnown && <span className="text-muted-foreground">{t('providers.applied.unknown')}</span>} />

      <Section title={t('providers.section.sms')}>
        <List>{rows(SMS_KINDS)}</List>
        {can(me, 'config.read') && <SmsRoutingCard providers={view.items} />}
      </Section>

      <Section title={t('providers.section.stores')}>
        <List>{rows(STORE_KINDS)}</List>
      </Section>

      <Section title={t('providers.section.push')}>
        <List>{rows(PUSH_KINDS)}</List>
      </Section>

      <Section title={t('providers.section.calls')}>
        <RtcCard />
        <List>
          <ReadOnlyRow name={t('provider.livekit')} configured={view.readOnly.livekit.configured}>
            <Facts>
              {view.readOnly.livekit.apiUrl && <Fact label={t('providers.field.url')} value={view.readOnly.livekit.apiUrl} />}
              {view.readOnly.livekit.apiKey && <Fact label={t('providers.field.apiKey')} value={view.readOnly.livekit.apiKey} />}
            </Facts>
            <Secrets
              secrets={{
                apiSecret: view.readOnly.livekit.apiSecret,
                identitySecret: view.readOnly.livekit.identitySecret,
              }}
            />
          </ReadOnlyRow>
        </List>
      </Section>

      <Section title={t('providers.section.storage')}>
        <List>
          <StorageRow storage={view.readOnly.storage} />
        </List>
      </Section>

      <Section title={t('providers.section.moderation')}>
        <List>
          <ReadOnlyRow name={t('provider.moderation')} configured>
            {view.readOnly.moderation.autoApprove ? (
              <Badge variant="warning" className="whitespace-normal">
                <TriangleAlert aria-hidden="true" />
                {t('providers.moderation.autoApprove')}
              </Badge>
            ) : (
              <span className="text-sm text-muted-foreground">{view.readOnly.moderation.autoApprove === false ? t('providers.moderation.none') : t('common.none')}</span>
            )}
          </ReadOnlyRow>
        </List>
      </Section>

      {editing && <ProviderDialog key={editing.kind} provider={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

const SMS_KINDS: readonly ProviderKind[] = ['kavenegar', 'smsir', 'telnyx'];
const STORE_KINDS: readonly ProviderKind[] = ['play', 'bazaar'];
const PUSH_KINDS: readonly ProviderKind[] = ['fcm'];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid grid-cols-1 gap-3">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function List({ children }: { children: ReactNode }) {
  return (
    <Card className="gap-0 py-0">
      <ul className="divide-y">{children}</ul>
    </Card>
  );
}

function Facts({ children }: { children: ReactNode }) {
  return <dl className="flex flex-wrap gap-x-5 gap-y-1 text-sm">{children}</dl>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex max-w-full min-w-0 items-baseline gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd dir="ltr" className="min-w-0 truncate font-mono text-xs" title={value}>
        {value}
      </dd>
    </div>
  );
}

/** Secrets by fingerprint: "••• 1a2b3c4d5e6f"; one that cannot be opened in red. */
function Secrets({ secrets }: { secrets: Readonly<Record<string, SecretView>> }) {
  const { t } = useI18n();
  const shown = Object.entries(secrets).filter(([, view]) => view.set);
  if (shown.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2">
      {shown.map(([name, view]) => (
        <li key={name}>
          <Badge variant={view.unreadable ? 'destructive' : 'outline'} className="font-mono" title={secretLabel(name, t)}>
            <span className="font-sans font-normal text-muted-foreground">{secretLabel(name, t)}</span>
            <span aria-hidden="true" dir="ltr">
              ••• {view.fingerprint ?? ''}
            </span>
            <span className="sr-only">{view.fingerprint ? t('providers.fingerprint', { fp: view.fingerprint }) : t('providers.source.unreadable')}</span>
          </Badge>
        </li>
      ))}
    </ul>
  );
}

const SECRET_LABEL: Readonly<Record<string, MessageKey>> = {
  apiKey: 'providers.field.apiKey',
  serviceAccountJson: 'providers.field.serviceAccount',
  pishkhanToken: 'providers.field.pishkhanToken',
  clientSecret: 'providers.field.clientSecret',
  refreshToken: 'providers.field.refreshToken',
  apiSecret: 'providers.field.apiSecret',
  identitySecret: 'providers.field.identitySecret',
  accessKeyId: 'providers.field.accessKeyId',
  secretAccessKey: 'providers.field.secretAccessKey',
  signingKey: 'providers.field.signingKey',
};
const secretLabel = (name: string, t: (key: MessageKey) => string) => (SECRET_LABEL[name] ? t(SECRET_LABEL[name]) : name);

function ProviderRow({ provider, appliedKnown, onEdit }: { provider: AdminProvider; appliedKnown: boolean; onEdit: () => void }) {
  const { t, locale } = useI18n();
  const [clearing, setClearing] = useState(false);
  const [busy, setBusy] = useState(false);
  const name = t(providerName[provider.kind]);
  const shown = shownValues(provider);
  const settings = shown?.settings ?? {};
  const summary = appliedSummary(provider);
  const live = provider.source === 'panel' || provider.source === 'env';
  const facts = settingFields[provider.kind].filter((field) => field.input !== 'textarea' && settings[field.name] !== null && settings[field.name] !== undefined && settings[field.name] !== '');
  const inUse = [
    ...(summary.api > 0 ? [t('providers.applied.api', { count: summary.api })] : []),
    ...(summary.worker > 0 ? [t('providers.applied.worker', { count: summary.worker })] : []),
    ...(summary.older > 0 ? [t('providers.applied.older', { count: summary.older })] : []),
  ];

  async function clear() {
    setBusy(true);
    try {
      storeProvider(await apiRequest<AdminProvider>(`/v1/admin/providers/${provider.kind}`, { method: 'DELETE', body: { baseVersion: provider.version } }));
      showToast((t) => t('common.saved'));
      setClearing(false);
    } catch (error) {
      setClearing(false);
      const failure = asApiError(error);
      if (failure.code === 'conflict' && failure.reason === 'settings_changed') {
        showToast((t) => t('settings.conflict'), 'error', 6_000);
        void queryClient.invalidateQueries({ queryKey: appKeys.providers });
      } else showToast((t, lang) => problemText(failure, t, lang), 'error', 6_000);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-3 px-4 py-4 sm:px-6">
      <div className="grid min-w-0 flex-1 basis-64 grid-cols-1 gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{name}</span>
          <Badge variant={providerTone[provider.source]}>{t(`providers.source.${provider.source}` as MessageKey)}</Badge>
          {provider.kind === 'bazaar' && settings['auth'] && <Badge variant="muted">{t(settings['auth'] === 'oauth' ? 'providers.field.authOauth' : 'providers.field.authPishkhan')}</Badge>}
        </div>
        {provider.source === 'unreadable' && <p className="text-sm text-destructive">{t('providers.unreadable.help')}</p>}
        {(facts.length > 0 || shown?.account) && (
          <Facts>
            {facts.map((field) => (
              <Fact key={field.name} label={t(field.label)} value={typeof settings[field.name] === 'number' ? formatPlain(settings[field.name] as number, 'en') : String(settings[field.name])} />
            ))}
            {shown?.account && <Fact label={t('providers.field.account')} value={shown.account.clientEmail} />}
          </Facts>
        )}
        {shown && <Secrets secrets={shown.secrets} />}
        {appliedKnown && live && inUse.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {t('providers.applied', {
              list: inUse.join(locale === 'fa' ? '، ' : ', '),
            })}
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {provider.panel && (
          <Button variant="ghost" size="sm" onClick={() => setClearing(true)}>
            <RotateCcw aria-hidden="true" />
            {t('providers.useEnv')}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={onEdit} aria-label={t('providers.edit.title', { name })}>
          <Pencil aria-hidden="true" />
          {t('common.edit')}
        </Button>
      </div>
      <ConfirmDialog
        open={clearing}
        onOpenChange={(open) => !open && !busy && setClearing(false)}
        title={t('providers.clear.title', { name })}
        description={t('providers.clear.confirm')}
        confirmLabel={t('providers.useEnv')}
        busy={busy}
        onConfirm={() => void clear()}
      />
    </li>
  );
}

function ReadOnlyRow({ name, configured, children }: { name: string; configured: boolean; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <li className="grid grid-cols-1 gap-2 px-4 py-4 sm:px-6">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{name}</span>
        <Badge variant={configured ? 'secondary' : 'outline'}>{t(configured ? 'providers.readOnly' : 'providers.source.none')}</Badge>
      </div>
      {children}
    </li>
  );
}

function StorageRow({ storage }: { storage: AdminProviders['readOnly']['storage'] }) {
  const { t } = useI18n();
  const buckets = [storage.privateBucket, storage.mediaBucket].filter((b): b is string => Boolean(b)).join(' · ');
  return (
    <ReadOnlyRow name={t('provider.storage')} configured={storage.configured}>
      <Facts>
        {storage.endpoint && <Fact label={t('providers.storage.endpoint')} value={storage.endpoint} />}
        {storage.region && <Fact label={t('providers.storage.region')} value={storage.region} />}
        {buckets && <Fact label={t('providers.storage.buckets')} value={buckets} />}
        {storage.cdn && <Fact label={t('providers.storage.cdn')} value={storage.cdn.baseUrl} />}
      </Facts>
      <Secrets
        secrets={{
          accessKeyId: storage.accessKeyId,
          secretAccessKey: storage.secretAccessKey,
          ...(storage.cdn ? { signingKey: storage.cdn.signingKey } : {}),
        }}
      />
    </ReadOnlyRow>
  );
}
