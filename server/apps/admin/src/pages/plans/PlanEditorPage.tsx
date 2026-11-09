import { FREE_PLAN_KEY, PLAN_DESCRIPTION_MAX, PLAN_NAME_MAX, planQuotaKeys, type AdminPlan, type PlanFlag, type PlanQuota } from '@app/shared';
import { Archive, ArchiveRestore, ArrowLeft, Infinity as InfinityIcon, Info, Layers, Plus, Save, TriangleAlert } from 'lucide-react';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Field } from '@/components/form/Field';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadError, TableSkeleton } from '@/components/QueryState';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ConfirmDialog } from '@/components/ui/alert-dialog';
import { Badge, StatusDot } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { localeNames } from '@/i18n/messages';
import { useI18n } from '@/i18n/useI18n';
import { apiRequest } from '@/lib/api';
import { asApiError } from '@/lib/http';
import { formatDateTime, localized } from '@/lib/format';
import {
  featuresOf,
  hasErrors,
  newPlanForm,
  planBadges,
  planCreateBody,
  planFormOf,
  planLocales,
  planPatchBody,
  planStatus,
  serverPlanErrors,
  validatePlanForm,
  type PlanErrors,
  type PlanForm,
} from '@/lib/plans';
import { problemText } from '@/lib/problemText';
import { queryClient, storePlan, usePlans, type PlanList } from '@/lib/queries';
import { can } from '@/lib/session';
import { showToast } from '@/lib/toast';
import { useSession } from '@/lib/useSession';
import { cn } from '@/lib/utils';
import { badgeText, flagGroups, flagText, quotaText, statusText } from './planText';

/** `/revenue/plans/new` and `/revenue/plans/:key`: everything a plan is, in one form. */
export function PlanEditorPage({ mode }: { mode: 'create' | 'edit' }) {
  const { t } = useI18n();
  const { key } = useParams();
  const plans = usePlans();
  if (plans.isPending) return <TableSkeleton rows={6} />;
  if (plans.isError) return <LoadError error={plans.error} onRetry={() => void plans.refetch()} />;
  if (mode === 'create') return <PlanEditor list={plans.data} />;
  const plan = plans.data.items.find((item) => item.key === key);
  if (!plan) {
    return (
      <div className="mx-auto grid max-w-xl gap-4 py-10">
        <Alert>
          <Info aria-hidden="true" />
          <AlertTitle>{t('plan.notFound')}</AlertTitle>
          <AlertDescription>
            <Link to="/revenue/plans" className="underline underline-offset-4">
              {t('plan.backToList')}
            </Link>
          </AlertDescription>
        </Alert>
      </div>
    );
  }
  // A saved change (or a newer read) starts the form again from the plan as the API now has it.
  return <PlanEditor key={`${plan.key}@${plan.updatedAt}`} list={plans.data} plan={plan} />;
}

function PlanEditor({ list, plan }: { list: PlanList; plan?: AdminPlan }) {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const { me } = useSession();
  const baseId = useId();
  const mode = plan ? 'edit' : 'create';
  const [initial] = useState<PlanForm>(() => (plan ? planFormOf(plan) : newPlanForm()));
  const [form, setForm] = useState<PlanForm>(initial);
  const [attempted, setAttempted] = useState(false);
  const [serverErrors, setServerErrors] = useState<PlanErrors>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<'archive' | 'unarchive' | null>(null);
  const canWrite = can(me, 'billing.catalog');
  const isFree = plan?.key === FREE_PLAN_KEY;
  const archived = plan ? plan.archivedAt !== null : false;
  const context = { mode, plan, plans: list.items } as const;
  const errors: PlanErrors = { ...(attempted ? validatePlanForm(form, context) : {}), ...serverErrors };
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const err = (path: string) => {
    const key = errors[path];
    return key ? t(key, { max: path.startsWith('names') ? PLAN_NAME_MAX : PLAN_DESCRIPTION_MAX }) : undefined;
  };

  function update(patch: Partial<PlanForm>) {
    setForm((current) => ({ ...current, ...patch }));
    setServerErrors({});
    setNotice(null);
  }

  function failed(error: unknown) {
    const failure = asApiError(error);
    if (failure.code === 'field_invalid' || failure.code === 'validation_failed') {
      const mapped = serverPlanErrors(failure.errors);
      setServerErrors(mapped.errors);
      setNotice(mapped.rest.length > 0 ? t('common.error.invalid', { detail: mapped.rest.map((issue) => issue.message).join('; ') }) : t('form.fixMarked'));
    } else {
      setNotice(problemText(failure, t));
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving || !canWrite) return;
    setAttempted(true);
    const found = validatePlanForm(form, context);
    if (hasErrors(found)) {
      setNotice(t('form.fixMarked'));
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      if (!plan) {
        const created = await apiRequest<AdminPlan>('/v1/admin/plans', { method: 'POST', body: planCreateBody(form) });
        storePlan(created);
        showToast(t('plan.created', { name: localized(created.names, locale, created.key) }));
        await navigate(`/revenue/plans/${created.key}`, { replace: true });
        return;
      }
      const body = planPatchBody(form, plan);
      if (!body) {
        showToast(t('plan.nothingChanged'), 'info');
        return;
      }
      const saved = await apiRequest<AdminPlan>(`/v1/admin/plans/${plan.key}`, { method: 'PATCH', body });
      storePlan(saved);
      showToast(t('plan.saved'));
    } catch (error) {
      failed(error);
    } finally {
      setSaving(false);
    }
  }

  async function archiveOrRestore(action: 'archive' | 'unarchive') {
    if (!plan) return;
    setSaving(true);
    try {
      const saved = await apiRequest<AdminPlan>(`/v1/admin/plans/${plan.key}/${action}`, { method: 'POST' });
      storePlan(saved);
      // Archiving turns the plan's store products off.
      await queryClient.invalidateQueries({ queryKey: ['products'] });
      showToast(t(action === 'archive' ? 'plan.archived' : 'plan.unarchived'));
      setConfirm(null);
    } catch (error) {
      setConfirm(null);
      failed(error);
    } finally {
      setSaving(false);
    }
  }

  const status = plan ? statusText[planStatus(plan)] : null;
  const title = plan ? localized(plan.names, locale, plan.key) : t('plan.newTitle');
  const copySources = list.items.filter((item) => item.key !== plan?.key);

  return (
    <form className="mx-auto grid max-w-5xl gap-6 pb-24" onSubmit={(event) => void submit(event)} noValidate>
      <PageHeader
        icon={Layers}
        eyebrow={
          <Link to="/revenue/plans" className="inline-flex items-center gap-1 hover:text-foreground">
            <ArrowLeft className="size-4 rtl:rotate-180" aria-hidden="true" />
            {t('plans.title')}
          </Link>
        }
        title={title}
        description={plan ? t('plan.editIntro') : t('plan.newIntro')}
        actions={
          status && (
            <div className="flex items-center gap-3">
              {plan?.hasLiveSubscriptions && <Badge variant="secondary">{t('plan.hasHolders')}</Badge>}
              <StatusDot tone={status.tone}>{t(status.label)}</StatusDot>
            </div>
          )
        }
      />

      {!canWrite && (
        <Alert>
          <Info aria-hidden="true" />
          <AlertDescription>{t('plan.readOnly')}</AlertDescription>
        </Alert>
      )}
      {archived && (
        <Alert variant="warning">
          <Archive aria-hidden="true" />
          <AlertTitle>{t('plan.archivedTitle')}</AlertTitle>
          <AlertDescription>{t('plan.archivedBody', { date: plan?.archivedAt ? formatDateTime(plan.archivedAt, locale) : '' })}</AlertDescription>
        </Alert>
      )}

      <fieldset disabled={!canWrite || saving} className="grid min-w-0 gap-6">
        <Section title={t('plan.section.identity')} description={plan ? t('plan.section.identity.edit') : t('plan.section.identity.new')}>
          <div className="grid gap-5 md:grid-cols-2">
            {plan ? (
              <div className="grid gap-2">
                <span className="text-sm font-medium">{t('plan.key')}</span>
                <code dir="ltr" className="flex h-9 items-center rounded-md border bg-muted/50 px-3 font-mono text-sm">
                  {plan.key}
                </code>
                <p className="text-xs text-muted-foreground">{t('plan.key.fixed')}</p>
              </div>
            ) : (
              <Field id={`${baseId}-key`} label={t('plan.key')} hint={t('plan.key.hint')} error={err('key')}>
                {(control) => (
                  <Input
                    {...control}
                    dir="ltr"
                    className="font-mono"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="gold"
                    value={form.key}
                    onChange={(event) => update({ key: event.target.value.toLowerCase() })}
                  />
                )}
              </Field>
            )}
            {!plan && (
              <Field id={`${baseId}-copy`} label={t('plan.copyFrom')} hint={t('plan.copyFrom.hint')} optional={t('form.optional')}>
                {(control) => (
                  <NativeSelect
                    {...control}
                    value={form.copyFrom}
                    onChange={(event) => {
                      const source = copySources.find((item) => item.key === event.target.value);
                      update({ copyFrom: event.target.value, ...(source ? featuresOf(source) : {}) });
                    }}
                  >
                    <option value="">{t('plan.copyFrom.none')}</option>
                    {copySources.map((item) => (
                      <option key={item.key} value={item.key}>
                        {localized(item.names, locale, item.key)} ({item.key})
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
            )}
            {plan && (
              <div className="grid content-start gap-2 text-sm">
                <span className="font-medium">{t('plan.lastChange')}</span>
                <span className="flex h-9 items-center text-muted-foreground">{formatDateTime(plan.updatedAt, locale)}</span>
              </div>
            )}
          </div>
        </Section>

        <Section title={t('plan.section.texts')} description={t('plan.section.texts.body')}>
          {errors.names && (
            <p className="text-sm text-destructive" role="alert">
              {t(errors.names)}
            </p>
          )}
          <div className="grid gap-6 md:grid-cols-3">
            {planLocales.map((code) => (
              <div key={code} lang={code} className="grid content-start gap-4 rounded-lg border bg-muted/20 p-4">
                <div className="flex items-center justify-between text-sm font-medium">
                  {localeNames[code]}
                  {(code === 'fa' || code === 'en') && <span className="text-xs font-normal text-muted-foreground">{t('plan.names.fallback')}</span>}
                </div>
                <Field id={`${baseId}-name-${code}`} label={t('plan.name')} error={err(`names.${code}`)}>
                  {(control) => (
                    <div className="grid gap-1">
                      <Input
                        {...control}
                        dir={code === 'fa' ? 'rtl' : 'ltr'}
                        value={form.names[code]}
                        aria-invalid={control['aria-invalid'] || (code !== 'tr' && Boolean(errors.names))}
                        onChange={(event) => update({ names: { ...form.names, [code]: event.target.value } })}
                      />
                      <Counter value={form.names[code]} max={PLAN_NAME_MAX} />
                    </div>
                  )}
                </Field>
                <Field id={`${baseId}-description-${code}`} label={t('plan.description')} error={err(`descriptions.${code}`)} optional={t('form.optional')}>
                  {(control) => (
                    <div className="grid gap-1">
                      <Textarea
                        {...control}
                        dir={code === 'fa' ? 'rtl' : 'ltr'}
                        rows={3}
                        value={form.descriptions[code]}
                        onChange={(event) => update({ descriptions: { ...form.descriptions, [code]: event.target.value } })}
                      />
                      <Counter value={form.descriptions[code]} max={PLAN_DESCRIPTION_MAX} />
                    </div>
                  )}
                </Field>
              </div>
            ))}
          </div>
        </Section>

        <Section title={t('plan.section.sale')} description={t('plan.section.sale.body')}>
          <div className="grid gap-5 md:grid-cols-3">
            <Field
              id={`${baseId}-rank`}
              label={t('plan.rank')}
              hint={isFree ? t('plan.rank.free') : plan ? t('plan.rank.hint') : t('plan.rank.newHint')}
              error={err('rank')}
              {...(plan ? {} : { optional: t('form.optional') })}
            >
              {(control) => (
                <Input
                  {...control}
                  dir="ltr"
                  inputMode="numeric"
                  disabled={isFree}
                  value={isFree ? '0' : form.rank}
                  placeholder={plan ? undefined : t('plan.rank.auto')}
                  onChange={(event) => update({ rank: event.target.value })}
                />
              )}
            </Field>
            <Field id={`${baseId}-sort`} label={t('plan.sort')} hint={t('plan.sort.hint')} error={err('sort')} {...(plan ? {} : { optional: t('form.optional') })}>
              {(control) => <Input {...control} dir="ltr" inputMode="numeric" value={form.sort} placeholder={plan ? undefined : '0'} onChange={(event) => update({ sort: event.target.value })} />}
            </Field>
            <Field id={`${baseId}-badge`} label={t('plan.badge')} hint={t('plan.badge.hint')}>
              {(control) => (
                <NativeSelect {...control} value={form.badge} onChange={(event) => update({ badge: event.target.value as PlanForm['badge'] })}>
                  <option value="">{t('badge.none')}</option>
                  {planBadges.map((badge) => (
                    <option key={badge} value={badge}>
                      {t(badgeText[badge])}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
          </div>
          <SwitchRow
            id={`${baseId}-active`}
            label={t('plan.active')}
            help={isFree ? t('plan.active.free') : archived ? t('plan.active.archived') : t('plan.active.help')}
            checked={isFree ? true : form.active && !archived}
            disabled={isFree || archived}
            onCheckedChange={(active) => update({ active })}
          />
        </Section>

        <Section title={t('plan.section.features')} description={t('plan.section.features.body')}>
          <div className="grid gap-6 lg:grid-cols-2">
            {flagGroups.map((group) => (
              <div key={group.label} className="grid content-start gap-1">
                <h3 className="pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">{t(group.label)}</h3>
                <div className="divide-y rounded-lg border">
                  {group.flags.map((flag: PlanFlag) => (
                    <SwitchRow
                      key={flag}
                      id={`${baseId}-flag-${flag}`}
                      className="px-4"
                      label={t(flagText[flag].label)}
                      help={t(flagText[flag].help)}
                      checked={form.features[flag]}
                      onCheckedChange={(on) => update({ features: { ...form.features, [flag]: on } })}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section title={t('plan.section.quotas')} description={t('plan.section.quotas.body')}>
          <div className="divide-y rounded-lg border">
            {planQuotaKeys.map((quota: PlanQuota) => (
              <QuotaRow
                key={quota}
                id={`${baseId}-quota-${quota}`}
                label={t(quotaText[quota].label)}
                help={t(quotaText[quota].help)}
                error={err(`quotas.${quota}`)}
                field={form.quotas[quota]}
                onChange={(field) => update({ quotas: { ...form.quotas, [quota]: field } })}
              />
            ))}
          </div>
        </Section>
      </fieldset>

      {plan && !isFree && canWrite && (
        <Card className="border-destructive/30">
          <CardHeader>
            <CardTitle>{archived ? t('plan.unarchive.title') : t('plan.archive.title')}</CardTitle>
            <CardDescription>{archived ? t('plan.unarchive.body') : t('plan.archive.body')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button type="button" variant={archived ? 'outline' : 'destructive'} disabled={saving} onClick={() => setConfirm(archived ? 'unarchive' : 'archive')}>
              {archived ? <ArchiveRestore aria-hidden="true" /> : <Archive aria-hidden="true" />}
              {archived ? t('plan.unarchive.action') : t('plan.archive.action')}
            </Button>
          </CardContent>
        </Card>
      )}

      {canWrite && (
        <div className="sticky bottom-0 z-20 -mx-4 border-t bg-background/95 px-4 py-3 backdrop-blur lg:-mx-8 lg:px-8">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1 text-sm" aria-live="polite">
              {notice ? (
                <span className="flex items-center gap-2 text-destructive">
                  <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
                  {notice}
                </span>
              ) : (
                <span className="hidden text-muted-foreground sm:inline">{dirty ? t('form.unsaved') : plan ? t('form.noChanges') : t('plan.newHint')}</span>
              )}
            </div>
            {plan && (
              <Button
                type="button"
                variant="ghost"
                disabled={!dirty || saving}
                onClick={() => {
                  setForm(initial);
                  setAttempted(false);
                  setServerErrors({});
                  setNotice(null);
                }}
              >
                {t('form.discard')}
              </Button>
            )}
            <Button type="submit" disabled={saving || (plan !== undefined && !dirty)}>
              {plan ? <Save aria-hidden="true" /> : <Plus aria-hidden="true" />}
              {saving ? t('common.saving') : plan ? t('form.save') : t('plan.create')}
            </Button>
          </div>
        </div>
      )}

      {plan && (
        <ConfirmDialog
          open={confirm !== null}
          onOpenChange={(open) => !open && setConfirm(null)}
          title={confirm === 'unarchive' ? t('plan.unarchive.confirmTitle', { name: title }) : t('plan.archive.confirmTitle', { name: title })}
          description={
            confirm === 'unarchive' ? (
              <p>{t('plan.unarchive.confirmBody')}</p>
            ) : (
              <>
                <p>{t('plan.archive.confirmBody')}</p>
                {plan.hasLiveSubscriptions && <p className="font-medium text-foreground">{t('plan.archive.holders')}</p>}
              </>
            )
          }
          confirmLabel={confirm === 'unarchive' ? t('plan.unarchive.action') : t('plan.archive.action')}
          destructive={confirm === 'archive'}
          busy={saving}
          onConfirm={() => void archiveOrRestore(confirm ?? 'archive')}
        />
      )}
    </form>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <Card className="gap-5">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="grid gap-5">{children}</CardContent>
    </Card>
  );
}

function Counter({ value, max }: { value: string; max: number }) {
  const { t } = useI18n();
  const length = [...value.trim()].length;
  return (
    <span className={cn('justify-self-end text-xs tabular-nums', length > max ? 'text-destructive' : 'text-muted-foreground')} aria-hidden="true">
      {t('form.counter', { count: length, max })}
    </span>
  );
}

function SwitchRow({
  id,
  label,
  help,
  checked,
  disabled,
  onCheckedChange,
  className,
}: {
  id: string;
  label: string;
  help: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-4 py-3', className)}>
      <div className="grid gap-0.5">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <p id={`${id}-help`} className="text-xs leading-relaxed text-muted-foreground">
          {help}
        </p>
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} aria-describedby={`${id}-help`} className="mt-0.5" />
    </div>
  );
}

function QuotaRow({
  id,
  label,
  help,
  error,
  field,
  onChange,
}: {
  id: string;
  label: string;
  help: string;
  error: string | undefined;
  field: PlanForm['quotas'][PlanQuota];
  onChange: (field: PlanForm['quotas'][PlanQuota]) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="grid gap-0.5">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <p id={`${id}-help`} className="text-xs text-muted-foreground">
          {help}
        </p>
        {error && (
          <p id={`${id}-error`} className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
      <div className="flex items-center gap-4">
        <div className="relative w-36">
          <Input
            id={id}
            dir="ltr"
            inputMode="numeric"
            className="pe-3 text-end tabular-nums"
            disabled={field.unlimited}
            value={field.unlimited ? '' : field.value}
            placeholder={field.unlimited ? '∞' : '0'}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? `${id}-error ${id}-help` : `${id}-help`}
            onChange={(event) => onChange({ ...field, value: event.target.value })}
          />
        </div>
        <label className="flex items-center gap-2 text-sm whitespace-nowrap">
          <Switch checked={field.unlimited} onCheckedChange={(unlimited) => onChange({ ...field, unlimited })} aria-label={t('plan.quota.unlimitedFor', { name: label })} />
          <InfinityIcon className="size-4 text-muted-foreground" aria-hidden="true" />
          {t('plan.quota.unlimited')}
        </label>
      </div>
    </div>
  );
}

