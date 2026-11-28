import type { AdminProvider } from '@app/shared';
import { useId, useState, type FormEvent } from 'react';
import { Field } from '@/components/form/Field';
import { ConfirmDialog } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import type { MessageKey } from '@/i18n/messages';
import { useI18n } from '@/i18n/useI18n';
import { useWording } from '@/i18n/useWording';
import { Worded } from '@/i18n/Worded';
import { apiRequest } from '@/lib/api';
import { appKeys, storeProvider } from '@/lib/appSettings';
import { asApiError } from '@/lib/http';
import { fieldText, problemText } from '@/lib/problemText';
import {
  authOf,
  bazaarAuths,
  missingSecrets,
  providerBody,
  providerFormOf,
  providerName,
  providerServerProblems,
  settingProblems,
  shownSecrets,
  shownSettings,
  shownValues,
  storedSecret,
  storeKinds,
  type ProviderForm,
} from '@/lib/providerForm';
import { queryClient } from '@/lib/queries';
import { showToast } from '@/lib/toast';

/**
 * Sets a provider's credentials: on or off, its settings, and its secrets.
 * A secret input is never filled: an empty one keeps the stored secret (its
 * fingerprint is the placeholder); what is typed is sent once and cleared
 * with the dialog. Turning a provider off, or moving a store to another
 * package, is confirmed first.
 */
export function ProviderDialog({ provider, onClose }: { provider: AdminProvider; onClose: () => void }) {
  const { t } = useI18n();
  const id = useId();
  const [form, setForm] = useState<ProviderForm>(() => providerFormOf(provider));
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [notice, setNotice] = useWording();
  const [confirm, setConfirm] = useState<'off' | 'package' | null>(null);
  const [busy, setBusy] = useState(false);
  const name = t(providerName[provider.kind]);
  const current = shownValues(provider);
  const wasOn = provider.panel ? provider.panel.enabled : provider.source === 'env';

  function change(next: ProviderForm) {
    setForm(next);
    setProblems({});
    setNotice(null);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const found: Record<string, string> = Object.fromEntries(Object.entries(settingProblems(provider.kind, form)).map(([field, key]) => [field, t(key)]));
    for (const secret of missingSecrets(provider, form)) found[`secrets/${secret}`] = t('providers.error.secretRequired');
    setProblems(found);
    if (Object.keys(found).length > 0) {
      setNotice((t) => t('form.fixMarked'));
      return;
    }
    const packageMoved = storeKinds.includes(provider.kind) && typeof current?.settings?.['packageName'] === 'string' && current.settings['packageName'] !== form.settings['packageName']?.trim();
    if (wasOn && !form.enabled) setConfirm('off');
    else if (packageMoved) setConfirm('package');
    else void save();
  }

  async function save() {
    setBusy(true);
    try {
      const saved = await apiRequest<AdminProvider>(`/v1/admin/providers/${provider.kind}`, { method: 'PUT', body: providerBody(provider, form) });
      storeProvider(saved);
      showToast((t) => t('common.saved'));
      onClose();
    } catch (error) {
      setConfirm(null);
      const failure = asApiError(error);
      if (failure.code === 'conflict' && failure.reason === 'settings_changed') {
        showToast((t) => t('settings.conflict'), 'error', 6_000);
        void queryClient.invalidateQueries({ queryKey: appKeys.providers });
        onClose();
        return;
      }
      if (failure.code === 'field_invalid' || failure.code === 'validation_failed') {
        const codes = providerServerProblems(failure.errors);
        if (Object.keys(codes).length > 0) {
          setProblems(Object.fromEntries(Object.entries(codes).map(([field, code]) => [field, fieldText(code, t) ?? t('appConfig.error.invalid')])));
          setNotice((t) => t('form.fixMarked'));
          return;
        }
      }
      setNotice((t, lang) => problemText(failure, t, lang));
    } finally {
      setBusy(false);
    }
  }

  const settings = shownSettings(provider.kind, form);
  const secrets = shownSecrets(provider.kind, form);

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('providers.edit.title', { name })}</DialogTitle>
        </DialogHeader>
        <form className="grid gap-5" onSubmit={submit} noValidate autoComplete="off">
          <div className="flex items-center gap-3">
            <label htmlFor={`${id}-enabled`} className="min-w-0 flex-1 text-sm font-medium">
              {t('providers.enabled')}
            </label>
            <Switch id={`${id}-enabled`} checked={form.enabled} onCheckedChange={(enabled) => change({ ...form, enabled })} />
          </div>
          {provider.kind === 'bazaar' && (
            <div className="grid gap-2">
              <span className="text-sm font-medium">{t('providers.field.auth')}</span>
              <Segmented
                label={t('providers.field.auth')}
                value={authOf(form)}
                options={bazaarAuths}
                text={(auth) => t(auth === 'pishkhan' ? 'providers.field.authPishkhan' : 'providers.field.authOauth')}
                onChange={(auth) => change({ ...form, settings: { ...form.settings, auth } })}
              />
            </div>
          )}
          {settings.map((field) => (
            <Field
              key={field.name}
              id={`${id}-${field.name}`}
              label={t(field.label)}
              {...(field.optional && field.name !== 'clientId' ? { optional: t('form.optional') } : {})}
              error={problems[`settings/${field.name}`]}
            >
              {(control) =>
                field.input === 'textarea' ? (
                  <Textarea
                    {...control}
                    dir="ltr"
                    rows={4}
                    spellCheck={false}
                    className="font-mono text-xs break-all"
                    value={form.settings[field.name] ?? ''}
                    onChange={(event) =>
                      change({
                        ...form,
                        settings: {
                          ...form.settings,
                          [field.name]: event.target.value,
                        },
                      })
                    }
                  />
                ) : (
                  <Input
                    {...control}
                    dir="ltr"
                    type={field.input === 'email' ? 'email' : 'text'}
                    inputMode={field.input === 'number' ? 'numeric' : undefined}
                    spellCheck={false}
                    autoComplete="off"
                    className="font-mono"
                    value={form.settings[field.name] ?? ''}
                    onChange={(event) =>
                      change({
                        ...form,
                        settings: {
                          ...form.settings,
                          [field.name]: event.target.value,
                        },
                      })
                    }
                  />
                )
              }
            </Field>
          ))}
          {secrets.map((field) => {
            const stored = storedSecret(provider, field.name);
            const placeholder = stored?.fingerprint ? t('providers.secret.keep', { fp: stored.fingerprint }) : undefined;
            const label: MessageKey = field.label;
            return (
              <Field key={field.name} id={`${id}-secret-${field.name}`} label={t(label)} error={problems[`secrets/${field.name}`]}>
                {(control) =>
                  field.multiline ? (
                    <Textarea
                      {...control}
                      // The placeholder is a sentence in the panel's language; what is typed is JSON, left to right.
                      dir={form.secrets[field.name] ? 'ltr' : undefined}
                      rows={5}
                      spellCheck={false}
                      autoComplete="off"
                      placeholder={placeholder}
                      className={form.secrets[field.name] ? 'font-mono text-xs break-all' : undefined}
                      value={form.secrets[field.name] ?? ''}
                      onChange={(event) =>
                        change({
                          ...form,
                          secrets: {
                            ...form.secrets,
                            [field.name]: event.target.value,
                          },
                        })
                      }
                    />
                  ) : (
                    <Input
                      {...control}
                      dir={form.secrets[field.name] ? 'ltr' : undefined}
                      type="password"
                      autoComplete="new-password"
                      spellCheck={false}
                      placeholder={placeholder}
                      value={form.secrets[field.name] ?? ''}
                      onChange={(event) =>
                        change({
                          ...form,
                          secrets: {
                            ...form.secrets,
                            [field.name]: event.target.value,
                          },
                        })
                      }
                    />
                  )
                }
              </Field>
            );
          })}
          {notice && (
            <p className="text-sm text-destructive" aria-live="polite">
              <Worded text={notice} />
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? t('common.saving') : t('settings.save')}
            </Button>
          </DialogFooter>
        </form>
        <ConfirmDialog
          open={confirm !== null}
          onOpenChange={(open) => !open && !busy && setConfirm(null)}
          title={confirm === 'off' ? t('providers.off.title', { name }) : t('providers.package.title')}
          description={t(confirm === 'off' ? 'providers.off.confirm' : 'providers.package.confirm')}
          confirmLabel={confirm === 'off' ? t('settings.turnOff') : t('settings.save')}
          destructive={confirm === 'off'}
          busy={busy}
          onConfirm={() => void save()}
        />
      </DialogContent>
    </Dialog>
  );
}
