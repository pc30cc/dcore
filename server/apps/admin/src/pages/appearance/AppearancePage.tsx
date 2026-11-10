import { uiTemplates, type AdminAppearance, type UiTemplate } from '@app/shared';
import { Check, Contrast, Info, Save, TriangleAlert } from 'lucide-react';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadError, TableSkeleton } from '@/components/QueryState';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ConfirmDialog } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n/useI18n';
import { apiRequest } from '@/lib/api';
import {
  appearanceBody,
  appearanceFormOf,
  appearanceProblem,
  appearanceServerProblem,
  offeredIds,
  sameAppearance,
  templateName,
  templateSwatches,
  withDefault,
  withOffered,
  type AppearanceForm,
} from '@/lib/appearance';
import { asApiError } from '@/lib/http';
import { problemText } from '@/lib/problemText';
import { queryClient, queryKeys, useAppearance } from '@/lib/queries';
import { can } from '@/lib/session';
import { showToast } from '@/lib/toast';
import { useSession } from '@/lib/useSession';
import { cn } from '@/lib/utils';
import { TemplateChip, TemplateSwatch } from './TemplateSwatch';

/** `/app/appearance`: the default template and the templates people may choose. */
export function AppearancePage() {
  const appearance = useAppearance();
  if (appearance.isPending) return <TableSkeleton rows={6} />;
  if (appearance.isError) return <LoadError error={appearance.error} onRetry={() => void appearance.refetch()} />;
  // A save (or a newer read) starts the form again from the setting as the API now has it.
  return <AppearanceEditor key={JSON.stringify(appearance.data)} view={appearance.data} />;
}

function AppearanceEditor({ view }: { view: AdminAppearance }) {
  const { t, locale } = useI18n();
  const { me } = useSession();
  const baseId = useId();
  const [initial] = useState<AppearanceForm>(() => appearanceFormOf(view));
  const [form, setForm] = useState<AppearanceForm>(initial);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const canWrite = can(me, 'config.write');
  const dirty = !sameAppearance(form, initial);
  const swatches = templateSwatches(view.neonGradient);
  const name = (id: UiTemplate) => t(templateName[id]);
  const list = (ids: readonly UiTemplate[]) => new Intl.ListFormat(locale, { type: 'conjunction' }).format(ids.map(name));

  function update(next: AppearanceForm) {
    setForm(next);
    setNotice(null);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canWrite || !dirty || saving) return;
    const problem = appearanceProblem(form);
    if (problem) {
      setNotice(t(problem));
      return;
    }
    setConfirming(true);
  }

  async function save() {
    setSaving(true);
    try {
      const saved = await apiRequest<AdminAppearance>('/v1/admin/appearance', { method: 'PUT', body: appearanceBody(form, view.version) });
      setConfirming(false);
      showToast(t('appearance.saved'));
      queryClient.setQueryData(queryKeys.appearance, saved);
    } catch (error) {
      setConfirming(false);
      const failure = asApiError(error);
      if (failure.code === 'conflict') {
        // Another admin saved meanwhile: the page starts again from their value (the toast outlives the form).
        showToast(t('appearance.conflict'), 'error', 6_000);
        void queryClient.invalidateQueries({ queryKey: queryKeys.appearance });
        return;
      }
      const known = failure.code === 'field_invalid' ? appearanceServerProblem(failure.errors) : null;
      setNotice(known ? t(known) : problemText(failure, t));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="mx-auto grid max-w-5xl gap-6 pb-24" onSubmit={submit} noValidate>
      <PageHeader icon={Contrast} title={t('appearance.title')} />

      {!canWrite && (
        <Alert>
          <Info aria-hidden="true" />
          <AlertDescription>{t('appearance.readOnly')}</AlertDescription>
        </Alert>
      )}

      <fieldset disabled={!canWrite || saving} className="grid min-w-0 gap-6">
        <Section titleId={`${baseId}-default`} title={t('appearance.default.title')}>
          <div role="radiogroup" aria-labelledby={`${baseId}-default`} className="grid gap-4 sm:grid-cols-2">
            {uiTemplates.map((id) => {
              const checked = form.defaultTemplate === id;
              const nameId = `${baseId}-${id}-name`;
              return (
                <label
                  key={id}
                  className={cn(
                    'relative grid cursor-pointer gap-3 rounded-xl border bg-card p-3 transition-shadow',
                    'has-focus-visible:ring-[3px] has-focus-visible:ring-ring/50 has-disabled:cursor-default',
                    checked ? 'border-primary ring-2 ring-primary/30' : 'hover:border-foreground/25',
                  )}
                >
                  <input
                    type="radio"
                    name={`${baseId}-default-template`}
                    value={id}
                    checked={checked}
                    onChange={() => update(withDefault(form, id))}
                    aria-labelledby={nameId}
                    className="sr-only"
                  />
                  <TemplateSwatch id={id} colors={swatches[id]} label={t('appearance.preview', { name: name(id) })} />
                  <div className="flex items-center justify-between gap-3 px-1 pb-1">
                    <span id={nameId} className="font-medium">
                      {name(id)}
                    </span>
                    {checked ? (
                      <Badge>
                        <Check aria-hidden="true" />
                        {t('appearance.default.current')}
                      </Badge>
                    ) : (
                      <span aria-hidden="true" className="size-4 shrink-0 rounded-full border-2 border-muted-foreground/40" />
                    )}
                  </div>
                </label>
              );
            })}
          </div>
        </Section>

        <Section title={t('appearance.offered.title')}>
          <ul className="grid divide-y rounded-lg border">
            {uiTemplates.map((id) => {
              const isDefault = form.defaultTemplate === id;
              const switchId = `${baseId}-${id}-offered`;
              const badgeId = `${switchId}-default`;
              return (
                <li key={id} className="flex items-center gap-4 px-4 py-3">
                  <TemplateChip id={id} colors={swatches[id]} />
                  <label htmlFor={switchId} className="min-w-0 flex-1 text-sm font-medium">
                    {name(id)}
                  </label>
                  {isDefault && (
                    <Badge id={badgeId} variant="secondary">
                      {t('appearance.default.current')}
                    </Badge>
                  )}
                  <Switch
                    id={switchId}
                    checked={form.offered[id]}
                    disabled={isDefault}
                    aria-label={t('appearance.offered.switch', { name: name(id) })}
                    aria-describedby={isDefault ? badgeId : undefined}
                    onCheckedChange={(checked) => update(withOffered(form, id, checked))}
                  />
                </li>
              );
            })}
          </ul>
        </Section>
      </fieldset>

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
                <span className="hidden text-muted-foreground sm:inline">{dirty ? t('form.unsaved') : t('form.noChanges')}</span>
              )}
            </div>
            <Button
              type="button"
              variant="ghost"
              disabled={!dirty || saving}
              onClick={() => {
                setForm(initial);
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
        title={t('appearance.confirm.title')}
        description={
          <ul className="grid gap-1 font-medium text-foreground">
            <li>{t('appearance.confirm.default', { name: name(form.defaultTemplate) })}</li>
            <li>{t('appearance.confirm.offered', { names: list(offeredIds(form)) })}</li>
          </ul>
        }
        confirmLabel={t('appearance.confirm.action')}
        busy={saving}
        onConfirm={() => void save()}
      />
    </form>
  );
}

function Section({ title, titleId, children }: { title: string; titleId?: string; children: ReactNode }) {
  return (
    <Card className="gap-5">
      <CardHeader>
        <CardTitle id={titleId} className="text-base">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-5">{children}</CardContent>
    </Card>
  );
}
