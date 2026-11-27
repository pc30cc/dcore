import type { AdminHold, LegalHoldKind } from '@app/shared';
import { Lock, MoreHorizontal, Plus, Unlock } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { CopyId } from '@/components/CopyId';
import { Field } from '@/components/form/Field';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadError, TableSkeleton } from '@/components/QueryState';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { UserRef } from '@/components/UserRef';
import type { MessageKey } from '@/i18n/messages';
import { useI18n } from '@/i18n/useI18n';
import { apiRequest } from '@/lib/api';
import { asciiDigits, formatDate } from '@/lib/format';
import { asApiError } from '@/lib/http';
import { holdKindTone, holdKinds } from '@/lib/moderation';
import { problemText } from '@/lib/problemText';
import { queryClient, useHolds } from '@/lib/queries';
import { showToast } from '@/lib/toast';
import { EmptyLine, RefreshButton } from './QueueParts';

type HoldState = 'active' | 'released';

/** `/moderation/holds`: legal holds, active and released (`?state=`); a new hold by hand and a release with its reason. */
export function HoldsPage() {
  const { t, dir } = useI18n();
  const [params, setParams] = useSearchParams();
  const state: HoldState = params.get('state') === 'released' ? 'released' : 'active';
  const holds = useHolds(state);
  const items = holds.data?.pages.flatMap((page) => page.items) ?? [];
  const [creating, setCreating] = useState(false);
  const [releasing, setReleasing] = useState<AdminHold | null>(null);

  function changed() {
    void queryClient.invalidateQueries({ queryKey: ['holds'] });
    void queryClient.invalidateQueries({ queryKey: ['report'] });
  }

  return (
    <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6">
      <PageHeader
        icon={Lock}
        title={t('holds.title')}
        actions={
          <>
            <RefreshButton onClick={() => void holds.refetch()} busy={holds.isFetching} />
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden="true" />
              {t('holds.new')}
            </Button>
          </>
        }
      />
      <Tabs value={state} onValueChange={(value) => setParams(value === 'active' ? {} : { state: value }, { replace: true })} dir={dir} className="gap-4">
        <TabsList aria-label={t('holds.title')}>
          <TabsTrigger value="active">{t('holds.active')}</TabsTrigger>
          <TabsTrigger value="released">{t('holds.released')}</TabsTrigger>
        </TabsList>
        <TabsContent value={state}>
          <section className="overflow-hidden rounded-xl border bg-card text-card-foreground shadow-xs">
            {holds.isPending ? (
              <TableSkeleton />
            ) : holds.isError && items.length === 0 ? (
              <div className="p-4">
                <LoadError error={holds.error} onRetry={() => void holds.refetch()} />
              </div>
            ) : items.length === 0 ? (
              <EmptyLine text={t('holds.empty')} />
            ) : (
              <HoldTable rows={items} released={state === 'released'} onRelease={setReleasing} />
            )}
            {holds.hasNextPage && (
              <div className="border-t p-3 text-center">
                <Button variant="outline" size="sm" onClick={() => void holds.fetchNextPage()} disabled={holds.isFetchingNextPage}>
                  {t('common.loadMore')}
                </Button>
              </div>
            )}
          </section>
        </TabsContent>
      </Tabs>
      {creating && (
        <NewHoldDialog
          onClose={() => setCreating(false)}
          onDone={() => {
            changed();
            showToast((t) => t('common.saved'));
            setCreating(false);
          }}
        />
      )}
      {releasing && (
        <ReleaseDialog
          hold={releasing}
          onClose={() => setReleasing(null)}
          onDone={() => {
            changed();
            showToast((t) => t('holds.releasedToast'));
            setReleasing(null);
          }}
        />
      )}
    </div>
  );
}

function HoldTable({ rows, released, onRelease }: { rows: readonly AdminHold[]; released: boolean; onRelease: (hold: AdminHold) => void }) {
  const { t, locale, dir } = useI18n();
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>{t('holds.col.kind')}</TableHead>
          <TableHead>{t('holds.col.what')}</TableHead>
          <TableHead className="hidden md:table-cell">{t('holds.col.report')}</TableHead>
          <TableHead className="hidden sm:table-cell">{t('holds.col.created')}</TableHead>
          <TableHead className="hidden lg:table-cell">{t('holds.col.case')}</TableHead>
          <TableHead className="hidden lg:table-cell">{t('holds.col.filing')}</TableHead>
          {released ? <TableHead className="hidden sm:table-cell">{t('holds.col.released')}</TableHead> : <TableHead className="w-12" />}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((hold) => (
          <TableRow key={hold.id}>
            <TableCell>
              <Badge variant={holdKindTone[hold.kind]} className="whitespace-normal sm:whitespace-nowrap">
                {t(`holdKind.${hold.kind}` as MessageKey)}
              </Badge>
            </TableCell>
            <TableCell className="max-w-64">
              <div className="grid gap-1">
                {hold.user && <UserRef user={hold.user} />}
                {hold.conversationId && (
                  <span className="flex min-w-0 items-center gap-x-1.5 text-sm text-muted-foreground">
                    {t('holds.conversationWord')}
                    <CopyId value={hold.conversationId} truncate />
                  </span>
                )}
                {/* On a phone the report and the release sit under the subject (their columns are hidden). */}
                {hold.reportId && (
                  <Link to={`/moderation/reports/${hold.reportId}`} className="text-xs text-primary hover:underline md:hidden">
                    {t('holds.col.report')}
                  </Link>
                )}
                {released && (
                  <span className="grid gap-0.5 text-xs text-muted-foreground sm:hidden">
                    <span className="flex flex-wrap gap-x-2">
                      <span>
                        {t('holds.col.released')}: {hold.releasedAt ? formatDate(hold.releasedAt, locale) : t('common.none')}
                      </span>
                      {hold.releasedBy && <bdi>{hold.releasedBy.displayName}</bdi>}
                    </span>
                    {hold.releasedReason && <span className="bidi-plain">{hold.releasedReason}</span>}
                  </span>
                )}
              </div>
            </TableCell>
            <TableCell className="hidden md:table-cell">
              {hold.reportId ? (
                <Link to={`/moderation/reports/${hold.reportId}`} className="font-mono text-xs text-primary hover:underline" dir="ltr">
                  {hold.reportId}
                </Link>
              ) : (
                <span className="text-muted-foreground">{t('common.none')}</span>
              )}
            </TableCell>
            <TableCell className="hidden text-sm sm:table-cell">
              <span className="grid">
                <span className="whitespace-nowrap">{formatDate(hold.createdAt, locale)}</span>
                <span className="text-xs text-muted-foreground">{hold.createdBy?.displayName ?? t('common.automatic')}</span>
              </span>
            </TableCell>
            <TableCell className="hidden lg:table-cell">
              {hold.authorityRef ? (
                <CaseNumber value={hold.authorityRef} />
              ) : (
                <span className="text-muted-foreground">{t('common.none')}</span>
              )}
            </TableCell>
            <TableCell className="hidden text-sm lg:table-cell">
              {hold.filing ? (
                <span className="grid">
                  <span>{t(`authority.${hold.filing.authority}` as MessageKey)}</span>
                  {hold.filing.externalRef && (
                    <span className="text-xs text-muted-foreground">
                      <CaseNumber value={hold.filing.externalRef} />
                    </span>
                  )}
                </span>
              ) : (
                <span className="text-muted-foreground">{t('common.none')}</span>
              )}
            </TableCell>
            {released ? (
              <TableCell className="hidden max-w-64 text-sm sm:table-cell">
                <span className="grid gap-0.5">
                  <span className="flex flex-wrap gap-x-2 whitespace-nowrap">
                    <span>{hold.releasedAt ? formatDate(hold.releasedAt, locale) : t('common.none')}</span>
                    {hold.releasedBy && <bdi className="text-muted-foreground">{hold.releasedBy.displayName}</bdi>}
                  </span>
                  {hold.releasedReason && <span className="text-xs text-muted-foreground bidi-plain">{hold.releasedReason}</span>}
                </span>
              </TableCell>
            ) : (
              <TableCell className="text-end">
                <DropdownMenu dir={dir}>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label={t('holds.actionsFor', { what: holdName(hold, t) })}>
                      <MoreHorizontal aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => onRelease(hold)}>
                      <Unlock aria-hidden="true" />
                      {t('holds.release')}
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

/** A case number as an authority wrote it: any script, in its own direction, in the text's font. */
export function CaseNumber({ value }: { value: string }) {
  return <bdi dir="auto">{value}</bdi>;
}

/** A hold named for a menu or a title: its kind and what it keeps. */
function holdName(hold: AdminHold, t: ReturnType<typeof useI18n>['t']): string {
  const what = hold.user ? (hold.user.name ?? hold.user.id) : t('holds.conversation', { id: hold.conversationId ?? '' });
  return `${t(`holdKind.${hold.kind}` as MessageKey)} · ${what}`;
}

/** What a hold keeps, in brief: its kind, the person or the conversation, the report and the case. */
function HoldSummary({ hold }: { hold: AdminHold }) {
  const { t } = useI18n();
  const caseRef = hold.authorityRef ?? hold.filing?.externalRef ?? null;
  return (
    <div className="grid gap-2 rounded-lg bg-muted/50 px-3 py-2.5 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={holdKindTone[hold.kind]}>{t(`holdKind.${hold.kind}` as MessageKey)}</Badge>
        {hold.filing && <span className="text-muted-foreground">{t(`authority.${hold.filing.authority}` as MessageKey)}</span>}
      </div>
      {hold.user && <UserRef user={hold.user} link={false} wrap />}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
        {hold.conversationId && (
          <>
            <dt className="text-muted-foreground">{t('holds.conversationWord')}</dt>
            <dd>
              <bdi dir="ltr" className="font-mono text-xs break-all">
                {hold.conversationId}
              </bdi>
            </dd>
          </>
        )}
        {hold.reportId && (
          <>
            <dt className="text-muted-foreground">{t('holds.col.report')}</dt>
            <dd>
              <bdi dir="ltr" className="font-mono text-xs">
                {hold.reportId}
              </bdi>
            </dd>
          </>
        )}
        {caseRef !== null && (
          <>
            <dt className="text-muted-foreground">{t('holds.col.case')}</dt>
            <dd>
              <CaseNumber value={caseRef} />
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

function ReleaseDialog({ hold, onClose, onDone }: { hold: AdminHold; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const id = useId();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const title = hold.user
    ? t('holds.release.titleUser', { name: hold.user.name ?? hold.user.id })
    : t('holds.release.titleConversation', { id: hold.conversationId ?? '' });

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!reason.trim()) {
      setError(t('form.required'));
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      await apiRequest(`/v1/admin/holds/${hold.id}/release`, { method: 'POST', body: { reason: reason.trim() } });
      onDone();
    } catch (failure) {
      showToast((t, lang) => problemText(asApiError(failure), t, lang), 'error', 6_000);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form className="grid gap-5" onSubmit={(event) => void submit(event)} noValidate>
          <HoldSummary hold={hold} />
          <Field id={`${id}-reason`} label={t('holds.reason')} error={error}>
            {(control) => <Textarea {...control} dir="auto" rows={3} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />}
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="destructive" disabled={busy}>
              {busy ? t('common.saving') : t('holds.release')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A field the API refused, by its pointer (a value of the wrong form). */
const POINTERS: Readonly<Record<string, 'user' | 'conversationId' | 'reportId'>> = { '/user': 'user', '/conversationId': 'conversationId', '/reportId': 'reportId' };

const ERROR_FIELDS: Readonly<Record<string, 'user' | 'conversationId' | 'reportId'>> = {
  unknown_user: 'user',
  unknown_conversation: 'conversationId',
  unknown_report: 'reportId',
};

export interface NewHoldInitial {
  kind?: LegalHoldKind | undefined;
  user?: string | undefined;
  conversationId?: string | undefined;
  reportId?: string | undefined;
}

/** A hold placed by hand; from a report page it starts with the report, its person and its conversation. */
export function NewHoldDialog({ initial = {}, onClose, onDone }: { initial?: NewHoldInitial; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const id = useId();
  const [kind, setKind] = useState<LegalHoldKind | ''>(initial.kind ?? '');
  const [user, setUser] = useState(initial.user ?? '');
  const [conversationId, setConversationId] = useState(initial.conversationId ?? '');
  const [reportId, setReportId] = useState(initial.reportId ?? '');
  const [authorityRef, setAuthorityRef] = useState('');
  const [errors, setErrors] = useState<Partial<Record<'kind' | 'user' | 'conversationId' | 'reportId', string>>>({});
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const problems: typeof errors = {};
    if (!kind) problems.kind = t('form.required');
    if (!user.trim() && !conversationId.trim()) problems.user = t('holds.error.noTarget');
    setErrors(problems);
    if (Object.keys(problems).length > 0 || busy) return;
    setBusy(true);
    try {
      const body = {
        kind,
        // Ids typed on a Persian keyboard count.
        ...(user.trim() ? { user: asciiDigits(user.trim()) } : {}),
        ...(conversationId.trim() ? { conversationId: asciiDigits(conversationId.trim()) } : {}),
        ...(reportId.trim() ? { reportId: asciiDigits(reportId.trim()) } : {}),
        ...(authorityRef.trim() ? { authorityRef: authorityRef.trim() } : {}),
      };
      await apiRequest('/v1/admin/holds', { method: 'POST', body });
      onDone();
    } catch (failure) {
      const problem = asApiError(failure);
      const issue = problem.errors[0];
      const field = ERROR_FIELDS[issue?.code ?? ''];
      const pointed = POINTERS[issue?.pointer ?? ''];
      if (field) setErrors({ [field]: t(`holds.error.${field}` as MessageKey) });
      else if (issue?.code === 'no_target') setErrors({ user: t('holds.error.noTarget') });
      else if (problem.code === 'validation_failed' && pointed) setErrors({ [pointed]: t('holds.error.format') });
      else showToast((t, lang) => problemText(problem, t, lang), 'error', 6_000);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('holds.new')}</DialogTitle>
        </DialogHeader>
        <form className="grid gap-5" onSubmit={(event) => void submit(event)} noValidate>
          <Field id={`${id}-kind`} label={t('holds.col.kind')} error={errors.kind}>
            {(control) => (
              <NativeSelect {...control} value={kind} onChange={(event) => setKind(event.target.value as LegalHoldKind)}>
                <option value="">{t('form.choose')}</option>
                {holdKinds.map((k) => (
                  <option key={k} value={k}>
                    {t(`holdKind.${k}` as MessageKey)}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field id={`${id}-user`} label={t('holds.field.user')} error={errors.user}>
              {(control) => <Input {...control} dir="ltr" className="font-mono" maxLength={13} value={user} onChange={(event) => setUser(event.target.value)} autoComplete="off" />}
            </Field>
            <Field id={`${id}-conversation`} label={t('holds.field.conversation')} error={errors.conversationId}>
              {(control) => <Input {...control} dir="ltr" inputMode="numeric" className="font-mono" value={conversationId} onChange={(event) => setConversationId(event.target.value)} autoComplete="off" />}
            </Field>
            <Field id={`${id}-report`} label={t('holds.field.report')} optional={t('form.optional')} error={errors.reportId}>
              {(control) => <Input {...control} dir="ltr" inputMode="numeric" className="font-mono" value={reportId} onChange={(event) => setReportId(event.target.value)} autoComplete="off" />}
            </Field>
            <Field id={`${id}-case`} label={t('holds.col.case')} optional={t('form.optional')}>
              {(control) => <Input {...control} dir="auto" maxLength={200} value={authorityRef} onChange={(event) => setAuthorityRef(event.target.value)} autoComplete="off" />}
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? t('common.saving') : t('holds.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
