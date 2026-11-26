import type { AdminBannedTerm, BannedTermMatch, BannedTermScope, BannedTermSeverity, Locale, SideEffects } from '@app/shared';
import { Ban, MoreHorizontal, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { Field } from '@/components/form/Field';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadError, TableSkeleton } from '@/components/QueryState';
import { ConfirmDialog } from '@/components/ui/alert-dialog';
import { Badge, StatusDot } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { NativeSelect } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { MessageKey } from '@/i18n/messages';
import { useI18n } from '@/i18n/useI18n';
import { apiRequest } from '@/lib/api';
import { languageName } from '@/lib/format';
import { asApiError } from '@/lib/http';
import { problemText } from '@/lib/problemText';
import { queryClient, useTerms } from '@/lib/queries';
import { can } from '@/lib/session';
import { severityTone, termBody, termFormOf, termLocales, termMatches, termProblems, termScopes, termSeverities, type TermForm } from '@/lib/terms';
import { showToast } from '@/lib/toast';
import { savedToast } from '@/lib/users';
import { useSession } from '@/lib/useSession';
import { cn } from '@/lib/utils';
import { EmptyLine } from './QueueParts';

interface TermResult {
  term: AdminBannedTerm;
  sideEffects: SideEffects;
}

const changed = () => void queryClient.invalidateQueries({ queryKey: ['terms'] });

/** `/moderation/terms`: banned terms (`?q=` a part of one), added, changed, switched off and removed. */
export function TermsPage() {
  const { t } = useI18n();
  const { me } = useSession();
  const writer = can(me, 'moderation.terms');
  const [params, setParams] = useSearchParams();
  const q = params.get('q')?.trim() ?? '';
  const [draft, setDraft] = useState(q);
  const terms = useTerms(q);
  const items = terms.data?.pages.flatMap((page) => page.items) ?? [];
  const [editing, setEditing] = useState<AdminBannedTerm | 'new' | null>(null);
  const [removing, setRemoving] = useState<AdminBannedTerm | null>(null);
  const [busy, setBusy] = useState(false);

  function search(event: FormEvent) {
    event.preventDefault();
    const value = draft.trim();
    setParams(value ? { q: value } : {}, { replace: true });
  }

  async function remove(term: AdminBannedTerm) {
    if (busy) return;
    setBusy(true);
    try {
      await apiRequest(`/v1/admin/banned-terms/${term.id}`, { method: 'DELETE' });
      changed();
      showToast(t('terms.removed'));
      setRemoving(null);
    } catch (failure) {
      showToast(problemText(asApiError(failure), t), 'error', 6_000);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6">
      <PageHeader
        icon={Ban}
        title={t('terms.title')}
        actions={
          writer && (
            <Button onClick={() => setEditing('new')}>
              <Plus aria-hidden="true" />
              {t('terms.new')}
            </Button>
          )
        }
      />
      <Card className="gap-0 overflow-hidden py-0">
        <div className="border-b p-3">
          <form role="search" className="flex min-w-0 items-center gap-2" onSubmit={search}>
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                type="text"
                enterKeyHint="search"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={t('terms.search')}
                aria-label={t('terms.search')}
                autoComplete="off"
                className="ps-9"
              />
            </div>
            {q && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('terms.searchClear')}
                onClick={() => {
                  setDraft('');
                  setParams({}, { replace: true });
                }}
              >
                <X aria-hidden="true" />
              </Button>
            )}
            <Button type="submit" variant="secondary">
              {t('common.search')}
            </Button>
          </form>
        </div>
        {terms.isPending ? (
          <TableSkeleton />
        ) : terms.isError && items.length === 0 ? (
          <div className="p-4">
            <LoadError error={terms.error} onRetry={() => void terms.refetch()} />
          </div>
        ) : items.length === 0 ? (
          <EmptyLine text={q ? t('terms.noMatch') : t('terms.empty')} />
        ) : (
          <TermTable rows={items} writer={writer} onEdit={setEditing} onRemove={setRemoving} />
        )}
        {terms.hasNextPage && (
          <div className="border-t p-3 text-center">
            <Button variant="outline" size="sm" onClick={() => void terms.fetchNextPage()} disabled={terms.isFetchingNextPage}>
              {t('common.loadMore')}
            </Button>
          </div>
        )}
      </Card>
      {editing && (
        <TermDialog
          term={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onDone={(result) => {
            changed();
            savedToast(t, result.sideEffects);
            setEditing(null);
          }}
        />
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && !busy && setRemoving(null)}
        title={t('terms.remove.title')}
        description={
          removing && (
            <span className="text-foreground">
              <TermText term={removing} />
            </span>
          )
        }
        confirmLabel={t('terms.remove')}
        destructive
        busy={busy}
        onConfirm={() => removing && void remove(removing)}
      />
    </div>
  );
}

function TermText({ term }: { term: AdminBannedTerm }) {
  return (
    <bdi dir={term.match === 'regex' ? 'ltr' : 'auto'} className={cn('text-sm wrap-anywhere', term.match === 'regex' && 'font-mono')}>
      {term.term}
    </bdi>
  );
}

function TermTable({ rows, writer, onEdit, onRemove }: { rows: readonly AdminBannedTerm[]; writer: boolean; onEdit: (term: AdminBannedTerm) => void; onRemove: (term: AdminBannedTerm) => void }) {
  const { t, locale, dir } = useI18n();
  const [switching, setSwitching] = useState<string | null>(null);

  async function setActive(term: AdminBannedTerm, active: boolean) {
    setSwitching(term.id);
    try {
      const result = await apiRequest<TermResult>(`/v1/admin/banned-terms/${term.id}`, { method: 'PATCH', body: { active } });
      changed();
      savedToast(t, result.sideEffects);
    } catch (failure) {
      showToast(problemText(asApiError(failure), t), 'error', 6_000);
    } finally {
      setSwitching(null);
    }
  }

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>{t('terms.col.term')}</TableHead>
          <TableHead className="hidden sm:table-cell">{t('terms.col.match')}</TableHead>
          <TableHead>{t('terms.col.severity')}</TableHead>
          <TableHead className="hidden md:table-cell">{t('terms.col.where')}</TableHead>
          <TableHead className="hidden lg:table-cell">{t('terms.col.language')}</TableHead>
          <TableHead>{t('terms.col.active')}</TableHead>
          {writer && (
            <TableHead className="w-12">
              <span className="sr-only">{t('common.actions')}</span>
            </TableHead>
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((term) => (
          <TableRow key={term.id} className={cn(!term.active && 'text-muted-foreground')}>
            <TableCell className="max-w-72">
              <TermText term={term} />
            </TableCell>
            <TableCell className="hidden text-sm sm:table-cell">{t(`termMatch.${term.match}` as MessageKey)}</TableCell>
            <TableCell>
              <Badge variant={severityTone[term.severity]}>{t(`termSeverity.${term.severity}` as MessageKey)}</Badge>
            </TableCell>
            <TableCell className="hidden md:table-cell">
              <span className="flex max-w-64 flex-wrap gap-1 lg:max-w-none">
                {term.scope.length === termScopes.length ? (
                  <Badge variant="muted" className="font-normal">
                    {t('terms.scope.all')}
                  </Badge>
                ) : (
                  term.scope.map((scope) => (
                    <Badge key={scope} variant="muted" className="font-normal">
                      {t(`termScope.${scope}` as MessageKey)}
                    </Badge>
                  ))
                )}
              </span>
            </TableCell>
            <TableCell className="hidden text-sm lg:table-cell">{term.locale ? languageName(term.locale, locale) : t('terms.anyLanguage')}</TableCell>
            <TableCell>
              {writer ? (
                <Switch
                  checked={term.active}
                  disabled={switching === term.id}
                  onCheckedChange={(value) => void setActive(term, value)}
                  aria-label={t('terms.activeFor', { term: term.term })}
                  dir={dir}
                />
              ) : (
                // A reader sees the state as words, not as a switch they cannot use.
                <StatusDot tone={term.active ? 'green' : 'gray'}>
                  {term.active ? t('terms.state.on') : t('terms.state.off')}
                </StatusDot>
              )}
            </TableCell>
            {writer && (
              <TableCell className="text-end">
                <DropdownMenu dir={dir}>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label={t('terms.actionsFor', { term: term.term })}>
                      <MoreHorizontal aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => onEdit(term)}>
                      <Pencil aria-hidden="true" />
                      {t('common.edit')}
                    </DropdownMenuItem>
                    <DropdownMenuItem destructive onSelect={() => onRemove(term)}>
                      <Trash2 aria-hidden="true" />
                      {t('terms.remove')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function TermDialog({ term, onClose, onDone }: { term: AdminBannedTerm | null; onClose: () => void; onDone: (result: TermResult) => void }) {
  const { t, locale, dir } = useI18n();
  const id = useId();
  const [form, setForm] = useState<TermForm>(() => termFormOf(term));
  const [problems, setProblems] = useState<{ term?: string | undefined; scope?: string | undefined }>({});
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<TermForm>) => setForm((current) => ({ ...current, ...patch }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found: typeof problems = {};
    if (!form.term.trim()) found.term = t('form.required');
    if (form.scope.length === 0) found.scope = t('terms.error.scope');
    setProblems(found);
    if (Object.keys(found).length > 0 || busy) return;
    const body = termBody(form, term);
    if (term && Object.keys(body).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      const result = term
        ? await apiRequest<TermResult>(`/v1/admin/banned-terms/${term.id}`, { method: 'PATCH', body })
        : await apiRequest<TermResult>('/v1/admin/banned-terms', { method: 'POST', body });
      onDone(result);
    } catch (failure) {
      const problem = asApiError(failure);
      const code = problem.errors[0]?.code ?? '';
      if (problem.code === 'conflict') setProblems({ term: t('terms.error.exists') });
      else if (termProblems[code]) setProblems({ term: t(termProblems[code]) });
      else showToast(problemText(problem, t), 'error', 6_000);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{term ? t('terms.edit') : t('terms.new')}</DialogTitle>
        </DialogHeader>
        <form className="grid gap-5" onSubmit={(event) => void submit(event)} noValidate>
          <Field id={`${id}-term`} label={t('terms.field.term')} error={problems.term}>
            {(control) => (
              <Input
                {...control}
                dir={form.match === 'regex' ? 'ltr' : 'auto'}
                className={cn(form.match === 'regex' && 'font-mono')}
                maxLength={200}
                value={form.term}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  set({ term: event.target.value });
                  setProblems((current) => ({ ...current, term: undefined }));
                }}
              />
            )}
          </Field>
          <div className="grid gap-2">
            <span className="text-sm font-medium">{t('terms.field.match')}</span>
            <Segmented<BannedTermMatch> label={t('terms.field.match')} value={form.match} options={termMatches} text={(m) => t(`termMatch.${m}` as MessageKey)} onChange={(match) => set({ match })} />
          </div>
          <div className="grid gap-2">
            <span className="text-sm font-medium">{t('terms.field.severity')}</span>
            <Segmented<BannedTermSeverity>
              label={t('terms.field.severity')}
              value={form.severity}
              options={termSeverities}
              text={(s) => t(`termSeverity.${s}` as MessageKey)}
              onChange={(severity) => set({ severity })}
            />
          </div>
          <fieldset className="grid gap-2" aria-describedby={problems.scope ? `${id}-scope-error` : undefined}>
            <legend className="mb-2 text-sm font-medium">{t('terms.field.where')}</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {termScopes.map((scope) => (
                <label key={scope} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={form.scope.includes(scope)}
                    onChange={(event) => {
                      const next: BannedTermScope[] = event.target.checked ? [...form.scope, scope] : form.scope.filter((s) => s !== scope);
                      set({ scope: next });
                      setProblems((current) => ({ ...current, scope: undefined }));
                    }}
                  />
                  {t(`termScope.${scope}` as MessageKey)}
                </label>
              ))}
            </div>
            {problems.scope && (
              <p id={`${id}-scope-error`} className="text-sm text-destructive">
                {problems.scope}
              </p>
            )}
          </fieldset>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field id={`${id}-locale`} label={t('terms.field.language')}>
              {(control) => (
                <NativeSelect {...control} value={form.locale} onChange={(event) => set({ locale: event.target.value as Locale | '' })}>
                  <option value="">{t('terms.anyLanguage')}</option>
                  {termLocales.map((l) => (
                    <option key={l} value={l}>
                      {languageName(l, locale)}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <div className="grid content-start gap-2">
              <label htmlFor={`${id}-active`} className="text-sm font-medium">
                {t('terms.col.active')}
              </label>
              <Switch id={`${id}-active`} checked={form.active} onCheckedChange={(active) => set({ active })} dir={dir} className="mt-2" />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? t('common.saving') : term ? t('form.save') : t('terms.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
