import type { Locale, RtcSettingsView } from '@app/shared';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import { Field } from '@/components/form/Field';
import { ConfirmDialog } from '@/components/ui/alert-dialog';
import { LoadError, TableSkeleton } from '@/components/QueryState';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/i18n/useI18n';
import { useWording } from '@/i18n/useWording';
import { apiRequest } from '@/lib/api';
import { inDigitsOf, numberInput, typedNumber, useDigitsFollowLocale, wordedProblems, type Problem, type Problems } from '@/lib/appConfigForm';
import { appKeys, useRtcSettings } from '@/lib/appSettings';
import { formatPlain, listOf, regionName } from '@/lib/format';
import { asApiError } from '@/lib/http';
import { problemText } from '@/lib/problemText';
import { queryClient } from '@/lib/queries';
import { isOwner } from '@/lib/session';
import { showToast } from '@/lib/toast';
import { useSession } from '@/lib/useSession';
import { SettingsCard } from './SettingsCard';

/**
 * The calls network: the signalling address apps are given (empty: the
 * Hosts page's), the TURN relays with their countries and shared secret
 * (write-only, shown as its fingerprint), the credentials' lifetime and a
 * cap on calls at once. A save names the version it was read at.
 */

interface RtcBody {
  baseVersion: string;
  wsUrl: string | null;
  turnUrls: string[];
  countries: string[];
  credentialTtlSeconds: number;
  maxLiveCalls: number | null;
  sharedSecret?: string;
}

const TTL_MIN_MINUTES = 10;
const TTL_MAX_MINUTES = 1_440;
const MAX_LIVE = 1_000_000;

interface RtcForm {
  wsUrl: string;
  turnUrls: string;
  countries: string;
  ttl: string;
  maxLive: string;
  secret: string;
  removeSecret: boolean;
}

const lines = (text: string) =>
  text
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean);
const codes = (text: string) =>
  text
    .split(/[\s,،]+/)
    .map((code) => code.trim().toUpperCase())
    .filter(Boolean);

/** The number fields in `locale`'s digits (after a change of the panel's language). */
const rtcInDigitsOf = (form: RtcForm, locale: Locale): RtcForm => ({ ...form, ttl: inDigitsOf(form.ttl, locale), maxLive: inDigitsOf(form.maxLive, locale) });

export function RtcCard() {
  const rtc = useRtcSettings();
  if (rtc.isPending) return <TableSkeleton rows={4} />;
  if (rtc.isError) return <LoadError error={rtc.error} onRetry={() => void rtc.refetch()} />;
  return <RtcEditor key={rtc.data.version} view={rtc.data} />;
}

function RtcEditor({ view }: { view: RtcSettingsView }) {
  const { t, locale } = useI18n();
  const { me } = useSession();
  const id = useId();
  const plain = (n: number) => formatPlain(n, locale);
  const [initial, setInitial] = useState<RtcForm>(() => ({
    wsUrl: view.wsUrl ?? '',
    turnUrls: view.turnUrls.join('\n'),
    countries: view.countries.join(', '),
    ttl: plain(Math.round(view.credentialTtlSeconds / 60)),
    maxLive: view.maxLiveCalls === null ? '' : plain(view.maxLiveCalls),
    secret: '',
    removeSecret: false,
  }));
  const [form, setForm] = useState(initial);
  useDigitsFollowLocale(locale, rtcInDigitsOf, setInitial, setForm);
  // Kept as data (a key and its numbers) and worded when drawn, so a change of the panel's language redraws them.
  const [problems, setProblems] = useState<Problems>({});
  const errors = wordedProblems(problems, t);
  const [notice, setNotice] = useWording();
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState<RtcBody | null>(null);
  const norm = (f: RtcForm) =>
    JSON.stringify({
      ...f,
      turnUrls: lines(f.turnUrls),
      countries: codes(f.countries),
      ttl: typedNumber(f.ttl),
      maxLive: typedNumber(f.maxLive),
      wsUrl: f.wsUrl.trim(),
    });
  const dirty = norm(form) !== norm(initial);

  function update(next: RtcForm) {
    setForm(next);
    setProblems({});
    setNotice(null);
  }

  async function submit() {
    const found: Record<string, Problem> = {};
    const ttl = typedNumber(form.ttl);
    if (ttl === null || ttl < TTL_MIN_MINUTES || ttl > TTL_MAX_MINUTES) found['credentialTtlSeconds'] = { key: 'appConfig.error.range', values: { min: TTL_MIN_MINUTES, max: TTL_MAX_MINUTES } };
    const maxLive = form.maxLive.trim() === '' ? null : typedNumber(form.maxLive);
    if ((maxLive === null && form.maxLive.trim() !== '') || (maxLive !== null && maxLive > MAX_LIVE)) found['maxLiveCalls'] = { key: 'appConfig.error.range', values: { min: 0, max: MAX_LIVE } };
    codes(form.countries).forEach((code) => {
      if (!/^[A-Z]{2}$/.test(code) && code !== '*') found['countries'] = { key: 'providers.rtc.error.country' };
    });
    setProblems(found);
    if (Object.keys(found).length > 0) {
      setNotice((t) => t('form.fixMarked'));
      return;
    }
    const body: RtcBody = {
      baseVersion: view.version,
      wsUrl: form.wsUrl.trim() || null,
      turnUrls: lines(form.turnUrls),
      countries: codes(form.countries),
      credentialTtlSeconds: (ttl ?? 0) * 60,
      maxLiveCalls: maxLive,
      ...(form.removeSecret ? { sharedSecret: '' } : form.secret.trim() ? { sharedSecret: form.secret.trim() } : {}),
    };
    // Without the secret no relay credential can be made: the callers it serves lose it at once.
    if (form.removeSecret && view.sharedSecret.stored) {
      setConfirming(body);
      return;
    }
    await send(body);
  }

  async function send(body: RtcBody) {
    setSaving(true);
    try {
      queryClient.setQueryData(
        appKeys.rtc,
        await apiRequest<RtcSettingsView>('/v1/admin/providers/rtc', {
          method: 'PUT',
          body,
        }),
      );
      showToast((t) => t('common.saved'));
    } catch (error) {
      const failure = asApiError(error);
      if (failure.code === 'conflict' && failure.reason === 'settings_changed') {
        showToast((t) => t('settings.conflict'), 'error', 6_000);
        void queryClient.invalidateQueries({ queryKey: appKeys.rtc });
        return;
      }
      if (failure.code === 'field_invalid') {
        const fields: Record<string, Problem> = {};
        for (const issue of failure.errors) fields[issue.pointer.replace(/^\//, '').split('/')[0]!] = { key: 'appConfig.error.invalid' };
        setProblems(fields);
      }
      setNotice((t, lang) => problemText(failure, t, lang));
    } finally {
      setSaving(false);
      setConfirming(null);
    }
  }

  const served = view.countries.filter((code) => code !== '*');
  const everyone = view.countries.length === 0 || view.countries.includes('*');

  return (
    <SettingsCard
      title={t('providers.rtc.title')}
      writable
      dirty={dirty}
      saving={saving}
      notice={notice}
      changed={null}
      onSubmit={() => void submit()}
      onDiscard={() => {
        setForm(initial);
        setProblems({});
        setNotice(null);
      }}
    >
      <div className="grid gap-5 md:grid-cols-2">
        <Field
          id={`${id}-ws`}
          label={t('providers.rtc.wsUrl')}
          error={errors['wsUrl']}
          hint={
            !form.wsUrl.trim() && view.effectiveWsUrl ? (
              <>
                <bdi dir="ltr" className="font-mono">
                  {view.effectiveWsUrl}
                </bdi>
                {isOwner(me) && (
                  <>
                    {' · '}
                    <Link to="/hosts" className="text-primary hover:underline">
                      {t('nav.hosts')}
                    </Link>
                  </>
                )}
              </>
            ) : undefined
          }
        >
          {(control) => (
            <Input
              {...control}
              type="url"
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              value={form.wsUrl}
              onChange={(event) => update({ ...form, wsUrl: event.target.value })}
            />
          )}
        </Field>
        <Field id={`${id}-countries`} label={t('providers.rtc.countries')} hint={t('providers.rtc.countries.all')} error={errors['countries']}>
          {(control) => (
            <Input
              {...control}
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              className="font-mono uppercase"
              value={form.countries}
              onChange={(event) => update({ ...form, countries: event.target.value })}
            />
          )}
        </Field>
        <Field id={`${id}-turn`} label={t('providers.rtc.turnUrls')} error={errors['turnUrls']} className="md:col-span-2">
          {(control) => (
            <Textarea {...control} dir="ltr" rows={3} spellCheck={false} className="font-mono text-xs" value={form.turnUrls} onChange={(event) => update({ ...form, turnUrls: event.target.value })} />
          )}
        </Field>
        <Field
          id={`${id}-ttl`}
          label={t('providers.rtc.ttl')}
          hint={t('appConfig.range', {
            min: plain(TTL_MIN_MINUTES),
            max: plain(TTL_MAX_MINUTES),
          })}
          error={errors['credentialTtlSeconds']}
        >
          {(control) => <Input {...control} {...numberInput} className="w-28 tabular-nums" value={form.ttl} onChange={(event) => update({ ...form, ttl: event.target.value })} />}
        </Field>
        <Field id={`${id}-max`} label={t('providers.rtc.maxLive')} hint={t('providers.rtc.maxLive.none')} error={errors['maxLiveCalls']}>
          {(control) => <Input {...control} {...numberInput} className="w-28 tabular-nums" value={form.maxLive} onChange={(event) => update({ ...form, maxLive: event.target.value })} />}
        </Field>
        <Field id={`${id}-secret`} label={t('providers.rtc.secret')} error={errors['sharedSecret']} className="md:col-span-2">
          {(control) => (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                {...control}
                type="password"
                dir={form.secret ? 'ltr' : undefined}
                autoComplete="new-password"
                spellCheck={false}
                disabled={form.removeSecret}
                placeholder={
                  view.sharedSecret.fingerprint
                    ? t('providers.secret.keep', {
                        fp: view.sharedSecret.fingerprint,
                      })
                    : undefined
                }
                className="min-w-0 flex-1 basis-56"
                value={form.secret}
                onChange={(event) => update({ ...form, secret: event.target.value })}
              />
              {view.sharedSecret.stored && (
                <Button
                  type="button"
                  variant={form.removeSecret ? 'secondary' : 'ghost'}
                  size="sm"
                  aria-pressed={form.removeSecret}
                  onClick={() =>
                    update({
                      ...form,
                      removeSecret: !form.removeSecret,
                      secret: '',
                    })
                  }
                >
                  {t('providers.rtc.secret.remove')}
                </Button>
              )}
              {view.sharedSecret.stored && !view.sharedSecret.fingerprint && <Badge variant="destructive">{t('providers.source.unreadable')}</Badge>}
            </div>
          )}
        </Field>
      </div>
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => !open && !saving && setConfirming(null)}
        title={t('providers.rtc.secret.confirm.title')}
        description={
          everyone || served.length === 0
            ? t('providers.rtc.secret.confirm.all')
            : t('providers.rtc.secret.confirm', { countries: listOf(served.map((code) => regionName(code, locale)), locale) })
        }
        confirmLabel={t('providers.rtc.secret.remove')}
        destructive
        busy={saving}
        onConfirm={() => confirming && void send(confirming)}
      />
    </SettingsCard>
  );
}
