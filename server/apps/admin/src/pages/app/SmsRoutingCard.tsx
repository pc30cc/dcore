import { smsProviders, type AdminConfigItem, type AdminProvider, type AppConfig, type SmsProviderName } from '@app/shared';
import { ChevronUp, Plus, Trash2, X } from 'lucide-react';
import { useId, useState } from 'react';
import { LoadError, TableSkeleton } from '@/components/QueryState';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/select';
import type { MessageKey } from '@/i18n/messages';
import { useI18n } from '@/i18n/useI18n';
import { useWording } from '@/i18n/useWording';
import { appKeys, latestChange, putConfig, storeConfigItem, useSmsRouting } from '@/lib/appSettings';
import { asApiError } from '@/lib/http';
import { fieldText, problemText } from '@/lib/problemText';
import { queryClient } from '@/lib/queries';
import { can } from '@/lib/session';
import { showToast } from '@/lib/toast';
import { useSession } from '@/lib/useSession';
import { cn } from '@/lib/utils';
import { SettingsCard } from './SettingsCard';

/**
 * Which SMS providers send sign-in codes to a number: by its longest
 * matching prefix, in order (the next is tried when one is down), else
 * "Other numbers" (empty: refused). A name not set up is marked; the test
 * provider is refused in production by the API.
 */

type Routing = AppConfig['auth.sms_routing'];
interface RouteRow {
  rowId: number;
  prefix: string;
  providers: SmsProviderName[];
}
interface RoutingForm {
  routes: RouteRow[];
  fallback: SmsProviderName[];
}

let nextRow = 1;
const formOf = (value: Routing): RoutingForm => ({
  routes: value.routes.map((r) => ({
    rowId: nextRow++,
    prefix: r.prefix,
    providers: [...r.providers],
  })),
  fallback: [...value.default],
});
const valueOf = (form: RoutingForm): Routing => ({
  routes: form.routes.map((r) => ({
    prefix: r.prefix.trim(),
    providers: r.providers,
  })),
  default: form.fallback,
});
const PREFIX = /^\+[1-9][0-9]{0,5}$/;

const smsName: Readonly<Record<SmsProviderName, MessageKey>> = {
  kavenegar: 'provider.kavenegar',
  smsir: 'provider.smsir',
  telnyx: 'provider.telnyx',
  fake: 'provider.fake',
};

export function SmsRoutingCard({ providers }: { providers: readonly AdminProvider[] }) {
  const routing = useSmsRouting();
  const item = routing.data?.items.find((entry) => entry.key === 'auth.sms_routing');
  if (routing.isPending) return <TableSkeleton rows={3} />;
  if (routing.isError) return <LoadError error={routing.error} onRetry={() => void routing.refetch()} />;
  if (!item) return null;
  return <RoutingEditor key={item.version} item={item} providers={providers} />;
}

function RoutingEditor({ item, providers }: { item: AdminConfigItem; providers: readonly AdminProvider[] }) {
  const { t } = useI18n();
  const { me } = useSession();
  const id = useId();
  const [initial] = useState(() => formOf(item.value as Routing));
  const [form, setForm] = useState(initial);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [notice, setNotice] = useWording();
  const [saving, setSaving] = useState(false);
  const writable = item.write !== null && can(me, item.write);
  const dirty = JSON.stringify(valueOf(form)) !== JSON.stringify(valueOf(initial));
  const unset = (name: SmsProviderName) => {
    const source = providers.find((p) => p.kind === name)?.source;
    return source === 'off' || source === 'none' || source === 'unreadable';
  };

  function update(next: RoutingForm) {
    setForm(next);
    setProblems({});
    setNotice(null);
  }
  const setRoute = (index: number, patch: Partial<RouteRow>) =>
    update({
      ...form,
      routes: form.routes.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    });

  async function submit() {
    const found: Record<string, string> = {};
    const seen = new Set<string>();
    form.routes.forEach((route, i) => {
      const prefix = route.prefix.trim();
      if (!PREFIX.test(prefix)) found[`routes/${i}/prefix`] = t('providers.routing.error.prefix');
      else if (seen.has(prefix)) found[`routes/${i}/prefix`] = t('providers.routing.error.twice');
      seen.add(prefix);
      if (route.providers.length === 0) found[`routes/${i}/providers`] = t('providers.routing.error.empty');
    });
    setProblems(found);
    if (Object.keys(found).length > 0) {
      setNotice((t) => t('form.fixMarked'));
      return;
    }
    setSaving(true);
    try {
      storeConfigItem(await putConfig('auth.sms_routing', valueOf(form), item.version));
      showToast((t) => t('common.saved'));
    } catch (error) {
      const failure = asApiError(error);
      if (failure.code === 'conflict' && failure.reason === 'settings_changed') {
        showToast((t) => t('settings.conflict'), 'error', 6_000);
        void queryClient.invalidateQueries({ queryKey: appKeys.routing });
      } else if (failure.code === 'field_invalid') {
        const fields: Record<string, string> = {};
        for (const issue of failure.errors) {
          const path = issue.pointer.replace(/^\/value\/?/, '');
          const field = /^routes\/\d+\/providers/.test(path) ? path.replace(/\/\d+$/, '') : path.startsWith('default') ? 'default' : path;
          fields[field] = fieldText(issue.code, t, issue.pointer) ?? t('appConfig.error.invalid');
        }
        setProblems(fields);
        setNotice((t) => t('form.fixMarked'));
      } else {
        setNotice((t, lang) => problemText(failure, t, lang));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsCard
      title={t('providers.routing.title')}
      writable={writable}
      dirty={dirty}
      saving={saving}
      notice={notice}
      changed={latestChange([item])}
      onSubmit={() => void submit()}
      onDiscard={() => {
        setForm(initial);
        setProblems({});
        setNotice(null);
      }}
    >
      <ul className="grid gap-4">
        {form.routes.map((route, i) => {
          const prefixError = problems[`routes/${i}/prefix`];
          const listError = problems[`routes/${i}/providers`];
          return (
            <li key={route.rowId} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 sm:grid-cols-[7rem_minmax(0,1fr)_auto] sm:gap-3">
              <div className="grid gap-1">
                <Input
                  dir="ltr"
                  inputMode="tel"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={t('providers.routing.prefix')}
                  aria-invalid={Boolean(prefixError)}
                  aria-describedby={prefixError ? `${id}-${route.rowId}-prefix` : undefined}
                  className="w-28 font-mono"
                  value={route.prefix}
                  onChange={(event) => setRoute(i, { prefix: event.target.value })}
                />
                {prefixError && (
                  <p id={`${id}-${route.rowId}-prefix`} className="text-sm text-destructive">
                    {prefixError}
                  </p>
                )}
              </div>
              <Chips
                className="col-span-2 sm:col-span-1"
                label={t('providers.routing.providersOf', {
                  prefix: route.prefix.trim() || t('providers.routing.prefix'),
                })}
                value={route.providers}
                unset={unset}
                error={listError}
                onChange={(providers) => setRoute(i, { providers })}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="col-start-2 row-start-1 justify-self-end sm:col-start-3"
                aria-label={t('providers.routing.remove', {
                  prefix: route.prefix.trim(),
                })}
                onClick={() =>
                  update({
                    ...form,
                    routes: form.routes.filter((_, j) => j !== i),
                  })
                }
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </li>
          );
        })}
        <li className="grid gap-2 sm:grid-cols-[7rem_minmax(0,1fr)_auto] sm:items-start sm:gap-3">
          <span className="text-sm font-medium sm:pt-2">{t('providers.routing.default')}</span>
          <Chips
            label={t('providers.routing.default')}
            value={form.fallback}
            unset={unset}
            empty={t('providers.routing.refuse')}
            error={problems['default']}
            onChange={(fallback) => update({ ...form, fallback })}
          />
          <span className="hidden size-9 sm:block" aria-hidden="true" />
        </li>
      </ul>
      {writable && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          disabled={form.routes.length >= 300}
          onClick={() =>
            update({
              ...form,
              routes: [...form.routes, { rowId: nextRow++, prefix: '+', providers: [] }],
            })
          }
        >
          <Plus aria-hidden="true" />
          {t('providers.routing.add')}
        </Button>
      )}
    </SettingsCard>
  );
}

/** Providers in order of preference: each can be moved earlier or removed; the select adds one at the end. */
function Chips({
  className,
  label,
  value,
  unset,
  empty,
  error,
  onChange,
}: {
  className?: string;
  label: string;
  value: SmsProviderName[];
  unset: (name: SmsProviderName) => boolean;
  empty?: string;
  error?: string | undefined;
  onChange: (next: SmsProviderName[]) => void;
}) {
  const { t } = useI18n();
  const left = smsProviders.filter((name) => !value.includes(name));
  return (
    <div className={cn('grid min-w-0 gap-1.5', className)} role="group" aria-label={label}>
      <div className="flex min-h-9 flex-wrap items-center gap-2">
        {value.length === 0 && empty && <span className="text-sm text-muted-foreground">{empty}</span>}
        {value.map((name, i) => (
          <span key={name} className="inline-flex items-center gap-1 rounded-md border bg-muted/40 py-0.5 ps-2 pe-0.5 text-sm">
            <bdi>{t(smsName[name])}</bdi>
            {name !== 'fake' && unset(name) && <Badge variant="warning">{t('providers.routing.notSetUp')}</Badge>}
            {i > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6"
                aria-label={t('providers.routing.earlier', {
                  name: t(smsName[name]),
                })}
                onClick={() => onChange([...value.slice(0, i - 1), name, value[i - 1]!, ...value.slice(i + 1)])}
              >
                <ChevronUp className="size-3.5 -rotate-90 rtl:rotate-90" aria-hidden="true" />
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label={t('providers.routing.removeProvider', {
                name: t(smsName[name]),
              })}
              onClick={() => onChange(value.filter((held) => held !== name))}
            >
              <X className="size-3.5" aria-hidden="true" />
            </Button>
          </span>
        ))}
        {left.length > 0 && (
          <div className="w-44">
            <NativeSelect
              aria-label={t('providers.routing.addProvider')}
              className="h-8 text-sm"
              value=""
              onChange={(event) => {
                const name = event.target.value as SmsProviderName;
                if (name) onChange([...value, name]);
              }}
            >
              <option value="">{t('providers.routing.addProvider')}</option>
              {left.map((name) => (
                <option key={name} value={name}>
                  {t(smsName[name])}
                </option>
              ))}
            </NativeSelect>
          </div>
        )}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
