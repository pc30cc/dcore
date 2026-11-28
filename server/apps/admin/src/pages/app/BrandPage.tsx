import { BRAND_APP_NAME_MAX, type AdminBrand, type BrandValueKey } from '@app/shared';
import { ArrowDown, ArrowUp, ExternalLink, Image as ImageIcon, Info, Lock, Palette, Plus, Save, Trash2, TriangleAlert } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Field } from '@/components/form/Field';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadError, TableSkeleton } from '@/components/QueryState';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ConfirmDialog } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import type { MessageKey } from '@/i18n/messages';
import { useI18n } from '@/i18n/useI18n';
import { useWording } from '@/i18n/useWording';
import { Worded } from '@/i18n/Worded';
import { apiRequest } from '@/lib/api';
import { appKeys, useBrandSettings } from '@/lib/appSettings';
import {
  brandBody,
  brandFormOf,
  brandLabel,
  brandProblems,
  brandServerProblems,
  brandUrlKeys,
  changedBrandFields,
  changesLegal,
  newImageRow,
  previewable,
  WELCOME_IMAGES_MAX,
  type BrandForm,
} from '@/lib/brandForm';
import { formatDateTime } from '@/lib/format';
import { asApiError } from '@/lib/http';
import { problemText } from '@/lib/problemText';
import { queryClient } from '@/lib/queries';
import { runtimeConfig } from '@/lib/runtimeConfig';
import { can } from '@/lib/session';
import { showToast } from '@/lib/toast';
import { useSession } from '@/lib/useSession';

/** `/app/brand`: the app's name, support e-mail, legal links and welcome pictures as the app reads them at run time. */
export function BrandPage() {
  const brand = useBrandSettings();
  if (brand.isPending) return <TableSkeleton rows={6} />;
  if (brand.isError) return <LoadError error={brand.error} onRetry={() => void brand.refetch()} />;
  return <BrandEditor key={brand.data.version} view={brand.data} />;
}

function BrandEditor({ view }: { view: AdminBrand }) {
  const { t, locale } = useI18n();
  const { me } = useSession();
  const id = useId();
  const [initial] = useState<BrandForm>(() => brandFormOf(view));
  const [form, setForm] = useState<BrandForm>(initial);
  const [problems, setProblems] = useState<Record<string, MessageKey>>({});
  const [notice, setNotice] = useWording();
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mismatch, setMismatch] = useState(false);
  const canWrite = can(me, 'config.write') && !mismatch;
  // The support e-mail and the legal links need config.legal (and the second factor while one is required).
  const canLegal = canWrite && can(me, 'config.legal');
  const changed = changedBrandFields(form, initial);
  const dirty = changed.length > 0;
  const config = runtimeConfig();
  const cdnOrigin = config.ok ? config.config.cdnOrigin : null;

  function update(next: BrandForm) {
    setForm(next);
    setProblems({});
    setNotice(null);
  }
  const setValue = (key: BrandValueKey, value: string) => update({ ...form, values: { ...form.values, [key]: value } });
  const setImages = (images: BrandForm['images']) => update({ ...form, images });

  function submit() {
    if (!canWrite || !dirty || saving) return;
    if (!canLegal && changesLegal(form, initial)) return;
    const found = brandProblems(form, view);
    setProblems(found);
    if (Object.keys(found).length > 0) {
      setNotice((t) => t('form.fixMarked'));
      return;
    }
    setConfirming(true);
  }

  async function save() {
    setSaving(true);
    try {
      const saved = await apiRequest<AdminBrand>('/v1/admin/brand', {
        method: 'PUT',
        body: brandBody(form, view.version),
      });
      setConfirming(false);
      showToast((t) => t('common.saved'));
      queryClient.setQueryData(appKeys.brand, saved);
    } catch (error) {
      setConfirming(false);
      const failure = asApiError(error);
      if (failure.code === 'conflict' && failure.reason === 'settings_changed') {
        showToast((t) => t('settings.conflict'), 'error', 6_000);
        void queryClient.invalidateQueries({ queryKey: appKeys.brand });
        return;
      }
      if (failure.code === 'conflict' && failure.reason === 'brand_mismatch') {
        setMismatch(true);
        return;
      }
      if (failure.code === 'field_invalid' || failure.code === 'validation_failed') {
        const found = brandServerProblems(failure.errors);
        if (Object.keys(found).length > 0) {
          setProblems(found);
          setNotice((t) => t('form.fixMarked'));
          return;
        }
      }
      setNotice((t, lang) => problemText(failure, t, lang));
    } finally {
      setSaving(false);
    }
  }

  const effective = (key: BrandValueKey) => form.values[key].trim() || view.build[key];

  return (
    <form
      className="mx-auto grid max-w-5xl grid-cols-1 gap-6 pb-24"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <PageHeader
        icon={Palette}
        title={t('brand.title')}
        meta={
          view.updatedAt && (
            <span className="text-xs text-muted-foreground">
              {view.updatedBy ? (
                <Worded
                  text={(t) =>
                    t('settings.changedBy', {
                      time: formatDateTime(view.updatedAt!, locale),
                      name: view.updatedBy?.displayName ?? '',
                    })
                  }
                />
              ) : (
                t('settings.changedAt', {
                  time: formatDateTime(view.updatedAt, locale),
                })
              )}
            </span>
          )
        }
      />
      {mismatch && (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertDescription>{t('brand.mismatch')}</AlertDescription>
        </Alert>
      )}
      {!can(me, 'config.write') && (
        <Alert>
          <Info aria-hidden="true" />
          <AlertDescription>{t('brand.readOnly')}</AlertDescription>
        </Alert>
      )}

      <fieldset disabled={!canWrite || saving} className="grid min-w-0 grid-cols-1 items-start gap-6 lg:grid-cols-2">
        <Section title={t('brand.name.title')}>
          <Field
            id={`${id}-appName`}
            label={
              <span className="flex w-full items-center gap-2">
                <span className="flex-1">{t('brand.appName')}</span>
                <span className="text-xs font-normal text-muted-foreground tabular-nums">
                  {t('form.counter', {
                    count: [...form.values.appName].length,
                    max: BRAND_APP_NAME_MAX,
                  })}
                </span>
              </span>
            }
            error={problems['appName'] && t(problems['appName'])}
          >
            {(control) => (
              <Input
                {...control}
                dir="auto"
                autoComplete="off"
                maxLength={BRAND_APP_NAME_MAX}
                placeholder={view.build.appName}
                value={form.values.appName}
                onChange={(event) => setValue('appName', event.target.value)}
              />
            )}
          </Field>
          <Field id={`${id}-supportEmail`} label={t('brand.supportEmail')} error={problems['supportEmail'] && t(problems['supportEmail'])}>
            {(control) => (
              <Input
                {...control}
                disabled={!canLegal}
                type="email"
                dir="ltr"
                autoComplete="off"
                placeholder={view.build.supportEmail}
                value={form.values.supportEmail}
                onChange={(event) => setValue('supportEmail', event.target.value)}
              />
            )}
          </Field>
        </Section>

        <Section title={t('brand.legal.title')} badge={canWrite && !canLegal ? <LegalLock /> : undefined}>
          {brandUrlKeys.map((key) => (
            <Field key={key} id={`${id}-${key}`} label={t(brandLabel[key])} error={problems[key] && t(problems[key])}>
              {(control) => (
                <div className="flex items-center gap-2">
                  <Input
                    {...control}
                    disabled={!canLegal}
                    type="url"
                    dir="ltr"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={view.build[key]}
                    value={form.values[key]}
                    onChange={(event) => setValue(key, event.target.value)}
                  />
                  <Button asChild variant="ghost" size="icon" className="shrink-0">
                    <a href={effective(key)} target="_blank" rel="noreferrer" aria-label={t('brand.open', { name: t(brandLabel[key]) })} title={t('brand.open', { name: t(brandLabel[key]) })}>
                      <ExternalLink aria-hidden="true" />
                    </a>
                  </Button>
                </div>
              )}
            </Field>
          ))}
        </Section>

        <Section title={t('brand.welcome.title')} className="lg:col-span-2">
          {form.images.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('brand.welcome.empty')}</p>
          ) : (
            <ol className="grid gap-3">
              {form.images.map((row, i) => {
                const error = problems[`images/${i}`];
                const inputId = `${id}-image-${row.rowId}`;
                const label = t('brand.welcome.url', { n: i + 1 });
                return (
                  <li key={row.rowId} className="grid gap-1">
                    <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                      <span className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-md border bg-muted text-muted-foreground">
                        {previewable(row.url.trim(), cdnOrigin) ? <img src={row.url.trim()} alt="" className="size-full object-cover" /> : <ImageIcon className="size-4" aria-hidden="true" />}
                      </span>
                      <Input
                        id={inputId}
                        type="url"
                        dir="ltr"
                        autoComplete="off"
                        spellCheck={false}
                        aria-label={label}
                        aria-invalid={Boolean(error)}
                        aria-describedby={error ? `${inputId}-error` : undefined}
                        className="min-w-0 flex-1 basis-48"
                        value={row.url}
                        onChange={(event) => setImages(form.images.map((held, j) => (j === i ? { ...held, url: event.target.value } : held)))}
                      />
                      <div className="ms-auto flex shrink-0">
                        <Button type="button" variant="ghost" size="icon" disabled={i === 0} aria-label={t('brand.welcome.up', { n: i + 1 })} onClick={() => setImages(swap(form.images, i, i - 1))}>
                          <ArrowUp aria-hidden="true" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          disabled={i === form.images.length - 1}
                          aria-label={t('brand.welcome.down', { n: i + 1 })}
                          onClick={() => setImages(swap(form.images, i, i + 1))}
                        >
                          <ArrowDown aria-hidden="true" />
                        </Button>
                        <Button type="button" variant="ghost" size="icon" aria-label={t('brand.welcome.remove', { n: i + 1 })} onClick={() => setImages(form.images.filter((_, j) => j !== i))}>
                          <Trash2 aria-hidden="true" />
                        </Button>
                      </div>
                    </div>
                    {error && (
                      <p id={`${inputId}-error`} className="text-sm text-destructive">
                        {t(error)}
                      </p>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          {canWrite && (
            <Button type="button" variant="outline" size="sm" className="w-fit" disabled={form.images.length >= WELCOME_IMAGES_MAX} onClick={() => setImages([...form.images, newImageRow()])}>
              <Plus aria-hidden="true" />
              {t('brand.welcome.add')}
            </Button>
          )}
        </Section>
      </fieldset>

      <Section title={t('brand.build.title')} badge={<Badge variant="muted">{t('brand.build.badge')}</Badge>}>
        <dl className="grid gap-4 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-8">
          <dt className="text-muted-foreground">{t('brand.build.id')}</dt>
          <dd dir="ltr" className="justify-self-start font-mono">
            {view.brandId}
          </dd>
          <dt className="text-muted-foreground">{t('brand.build.colors')}</dt>
          <dd className="grid grid-cols-2 gap-3 sm:flex sm:flex-wrap sm:gap-4">
            {COLOR_ROLES.flatMap((role) =>
              THEMES.map((theme) => (
                <span key={`${role}-${theme}`} className="flex items-center gap-2">
                  <span aria-hidden="true" className="size-6 shrink-0 rounded-md border" style={{ background: view.colors[role][theme] }} />
                  <span className="grid leading-tight">
                    <span className="text-xs">{t(role === 'brand' ? 'brand.color.brand' : 'brand.color.onBrand')}</span>
                    <span className="text-xs text-muted-foreground">
                      {t(theme === 'light' ? 'brand.color.light' : 'brand.color.dark')} · <bdi className="font-mono uppercase">{view.colors[role][theme]}</bdi>
                    </span>
                  </span>
                </span>
              )),
            )}
          </dd>
          <dt className="text-muted-foreground">{t('brand.build.fonts')}</dt>
          <dd dir="ltr" className="justify-self-start">
            {view.fonts.latin} · {view.fonts.persian}
          </dd>
        </dl>
      </Section>

      {canWrite && (
        <div className="sticky bottom-0 z-20 -mx-4 border-t bg-background/95 px-4 py-3 backdrop-blur lg:-mx-8 lg:px-8">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1 text-sm" aria-live="polite">
              {notice ? (
                <span className="flex items-center gap-2 text-destructive">
                  <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
                  <Worded text={notice} />
                </span>
              ) : (
                <span className="hidden text-muted-foreground sm:inline">{dirty ? t('form.unsaved') : t('form.noChanges')}</span>
              )}
            </div>
            <Button
              type="button"
              variant="ghost"
              disabled={!dirty || saving}
              onClick={() => {
                setForm(initial);
                setProblems({});
                setNotice(null);
              }}
            >
              {t('form.discard')}
            </Button>
            <Button type="submit" disabled={!dirty || saving}>
              <Save aria-hidden="true" />
              {saving ? t('common.saving') : t('form.save')}
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => !open && !saving && setConfirming(false)}
        title={t('brand.confirm.title')}
        description={
          <ul className="grid list-disc gap-1 ps-5 font-medium text-foreground">
            {changed.map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ul>
        }
        confirmLabel={t('settings.save')}
        busy={saving}
        onConfirm={() => void save()}
      />
    </form>
  );
}

const COLOR_ROLES = ['brand', 'onBrand'] as const;
const THEMES = ['light', 'dark'] as const;

function swap<T>(list: readonly T[], a: number, b: number): T[] {
  const next = [...list];
  [next[a], next[b]] = [next[b]!, next[a]!];
  return next;
}

function LegalLock() {
  const { t } = useI18n();
  return (
    <Badge variant="muted">
      <Lock aria-hidden="true" />
      {t('settings.readOnlyBadge')}
    </Badge>
  );
}

function Section({ title, badge, className, children }: { title: string; badge?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <Card className={className ? `gap-5 ${className}` : 'gap-5'}>
      <CardHeader className="flex flex-wrap items-center gap-2">
        <CardTitle className="text-base">{title}</CardTitle>
        {badge}
      </CardHeader>
      <CardContent className="grid gap-5">{children}</CardContent>
    </Card>
  );
}
