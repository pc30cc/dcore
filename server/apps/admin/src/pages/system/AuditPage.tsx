import type { AuditAction, AuditEntry, AuditTarget } from '@app/shared';
import { ChevronDown, ChevronUp, Download, ScrollText } from 'lucide-react';
import { Fragment, useId, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { DetailJson } from '@/components/DetailJson';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadError, TableSkeleton } from '@/components/QueryState';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { MessageKey } from '@/i18n/messages';
import { useI18n } from '@/i18n/useI18n';
import { auditActionGroups, auditActionLabel, auditFiltered, auditFiltersOf, auditParamsOf, auditQueryOf, auditRequestOf, auditTargetChoices, auditTargetValid, emptyAuditFilters, exportName, type AuditFilterState } from '@/lib/audit';
import { apiDownload, saveBlob } from '@/lib/download';
import { dayInPanelCalendar, formatDateTime } from '@/lib/format';
import { asApiError } from '@/lib/http';
import { problemText } from '@/lib/problemText';
import { useAudit, useAuditAdmins } from '@/lib/queries';
import { showToast } from '@/lib/toast';
import { EmptyLine } from '../moderation/QueueParts';

/**
 * `/system/audit`: the audit log, newest first, filtered by admin, target,
 * action and days (the filters in the address; nothing personal: a person
 * is a public id), and its export as a CSV file (itself audited).
 */
export function AuditPage() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const filters = auditFiltersOf(params);
  const query = auditQueryOf(filters);
  const audit = useAudit(query);
  const items = audit.data?.pages.flatMap((page) => page.items) ?? [];
  const [exporting, setExporting] = useState(false);

  async function exportCsv() {
    if (exporting) return;
    setExporting(true);
    try {
      const blob = await apiDownload('/v1/admin/audit/export', auditRequestOf(filters));
      saveBlob(blob, exportName(filters));
    } catch (failure) {
      const problem = asApiError(failure);
      showToast(problem.errors[0]?.code === 'too_many_rows' ? t('audit.export.tooMany') : problemText(problem, t), 'error', 6_000);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6">
      <PageHeader
        icon={ScrollText}
        title={t('audit.title')}
        actions={
          <Button variant="outline" onClick={() => void exportCsv()} disabled={exporting}>
            <Download aria-hidden="true" />
            {exporting ? t('audit.export.busy') : t('audit.export')}
          </Button>
        }
      />
      <Card className="gap-0 overflow-hidden py-0">
        <FilterBar key={params.toString()} initial={filters} onApply={(next) => setParams(auditParamsOf(next), { replace: true })} />
        {audit.isPending ? (
          <TableSkeleton />
        ) : audit.isError && items.length === 0 ? (
          <div className="p-4">
            <LoadError error={audit.error} onRetry={() => void audit.refetch()} />
          </div>
        ) : items.length === 0 ? (
          <EmptyLine text={auditFiltered(filters) ? t('audit.noMatch') : t('audit.empty')} />
        ) : (
          <AuditTable rows={items} />
        )}
        {audit.hasNextPage && (
          <div className="border-t p-3 text-center">
            <Button variant="outline" size="sm" onClick={() => void audit.fetchNextPage()} disabled={audit.isFetchingNextPage}>
              {t('common.loadMore')}
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}

function FilterBar({ initial, onApply }: { initial: AuditFilterState; onApply: (filters: AuditFilterState) => void }) {
  const { t, locale } = useI18n();
  const id = useId();
  const admins = useAuditAdmins();
  const [draft, setDraft] = useState<AuditFilterState>(initial);
  const [targetError, setTargetError] = useState<string | undefined>();
  const set = (patch: Partial<AuditFilterState>) => setDraft((current) => ({ ...current, ...patch }));
  const fromDay = dayInPanelCalendar(draft.from, locale);
  const toDay = dayInPanelCalendar(draft.to, locale);

  function apply(event: FormEvent) {
    event.preventDefault();
    const raw = draft.targetType ? draft.target.trim() : '';
    const target = draft.targetType === 'user' ? raw.toLowerCase() : raw;
    // A target that cannot name a row stays in the field: never in the address or a request.
    if (target && !auditTargetValid(draft.targetType, target)) {
      setTargetError(draft.targetType === 'user' ? t('deviceBans.error.user') : t('audit.error.target'));
      return;
    }
    onApply({ ...draft, target });
  }

  return (
    <form className="grid gap-3 border-b p-3 sm:grid-cols-2 lg:grid-cols-[repeat(3,minmax(0,1fr))_auto]" onSubmit={apply} aria-label={t('audit.filters')}>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-admin`} className="text-xs text-muted-foreground">
          {t('audit.col.admin')}
        </Label>
        <NativeSelect id={`${id}-admin`} value={draft.admin} onChange={(event) => set({ admin: event.target.value })}>
          <option value="">{t('audit.allAdmins')}</option>
          {admins.data?.items.map((a) => (
            <option key={a.id} value={a.id}>
              {a.disabled ? t('audit.adminDisabled', { name: a.displayName }) : a.displayName}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-action`} className="text-xs text-muted-foreground">
          {t('audit.col.action')}
        </Label>
        <NativeSelect id={`${id}-action`} value={draft.action} onChange={(event) => set({ action: event.target.value as AuditAction | '' })}>
          <option value="">{t('audit.allActions')}</option>
          {auditActionGroups.map((group) => (
            <optgroup key={group.area} label={t(group.label)}>
              {group.actions.map((action) => (
                <option key={action} value={action}>
                  {auditActionLabel(action, t)}
                </option>
              ))}
            </optgroup>
          ))}
        </NativeSelect>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-type`} className="text-xs text-muted-foreground">
            {t('audit.targetType')}
          </Label>
          <NativeSelect
            id={`${id}-type`}
            value={draft.targetType}
            onChange={(event) => {
              set({ targetType: event.target.value as AuditTarget | '', target: event.target.value ? draft.target : '' });
              setTargetError(undefined);
            }}
          >
            <option value="">{t('audit.anyTarget')}</option>
            {auditTargetChoices.map((type) => (
              <option key={type} value={type}>
                {t(`auditTarget.${type}` as MessageKey)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-target`} className="text-xs text-muted-foreground">
            {t('audit.target')}
          </Label>
          <Input
            id={`${id}-target`}
            dir="ltr"
            className="font-mono text-start"
            value={draft.target}
            disabled={!draft.targetType}
            maxLength={20}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={Boolean(targetError)}
            aria-describedby={targetError ? `${id}-target-error` : undefined}
            onChange={(event) => {
              set({ target: event.target.value });
              setTargetError(undefined);
            }}
          />
          {targetError && (
            <p id={`${id}-target-error`} className="text-xs text-destructive">
              {targetError}
            </p>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:col-span-2 lg:col-span-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-from`} className="text-xs text-muted-foreground">
            {t('audit.from')}
          </Label>
          <Input
            id={`${id}-from`}
            type="date"
            dir="ltr"
            value={draft.from}
            max={draft.to || undefined}
            aria-describedby={fromDay ? `${id}-from-day` : undefined}
            onChange={(event) => set({ from: event.target.value })}
          />
          {/* The day in the panel's calendar under the browser's (Gregorian) picker. */}
          {fromDay && (
            <p id={`${id}-from-day`} className="text-xs text-muted-foreground">
              {fromDay}
            </p>
          )}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-to`} className="text-xs text-muted-foreground">
            {t('audit.to')}
          </Label>
          <Input
            id={`${id}-to`}
            type="date"
            dir="ltr"
            value={draft.to}
            min={draft.from || undefined}
            aria-describedby={toDay ? `${id}-to-day` : undefined}
            onChange={(event) => set({ to: event.target.value })}
          />
          {toDay && (
            <p id={`${id}-to-day`} className="text-xs text-muted-foreground">
              {toDay}
            </p>
          )}
        </div>
      </div>
      <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-2 lg:justify-end">
        <Button type="button" variant="ghost" onClick={() => onApply(emptyAuditFilters)}>
          {t('audit.clear')}
        </Button>
        <Button type="submit" variant="secondary">
          {t('audit.apply')}
        </Button>
      </div>
    </form>
  );
}

function TargetCell({ entry }: { entry: AuditEntry }) {
  const { t } = useI18n();
  const admins = useAuditAdmins(entry.targetType === 'admin');
  const type = t(`auditTarget.${entry.targetType}` as MessageKey);
  if (entry.targetType === 'none') return <span className="text-muted-foreground">{t('common.none')}</span>;
  // An admin is named (the filter's list is loaded already); the id stays on hover.
  const adminName = entry.targetType === 'admin' ? admins.data?.items.find((a) => a.id === entry.targetRef)?.displayName : undefined;
  if (adminName) {
    return (
      <span className="grid min-w-0">
        <span className="text-sm">{type}</span>
        <span dir="auto" className="truncate text-xs text-muted-foreground" title={`${adminName} · ${entry.targetRef ?? ''}`}>
          {adminName}
        </span>
      </span>
    );
  }
  const id = entry.user ?? entry.targetRef;
  const href = entry.user ? `/users/${entry.user}` : entry.targetType === 'report' && entry.targetRef ? `/moderation/reports/${entry.targetRef}` : entry.targetType === 'legal_hold' ? '/moderation/holds' : null;
  return (
    <span className="grid min-w-0">
      <span className="text-sm">{type}</span>
      {id &&
        (href ? (
          <Link to={href} dir="ltr" className="w-fit font-mono text-xs break-all text-primary hover:underline">
            {id}
          </Link>
        ) : (
          <span dir="ltr" className="w-fit font-mono text-xs break-all text-muted-foreground">
            {id}
          </span>
        ))}
    </span>
  );
}

function AuditTable({ rows }: { rows: readonly AuditEntry[] }) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>{t('audit.col.time')}</TableHead>
          <TableHead className="hidden sm:table-cell">{t('audit.col.admin')}</TableHead>
          <TableHead>{t('audit.col.action')}</TableHead>
          <TableHead className="hidden md:table-cell">{t('audit.col.target')}</TableHead>
          <TableHead className="hidden lg:table-cell">{t('audit.col.ip')}</TableHead>
          <TableHead className="w-12">
            <span className="sr-only">{t('audit.col.detail')}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((entry) => {
          const expanded = open === entry.id;
          const hasDetail = entry.detail !== null && Object.keys(entry.detail).length > 0;
          return (
            <Fragment key={entry.id}>
              <TableRow className={expanded ? 'border-b-0' : undefined}>
                <TableCell className="text-sm sm:whitespace-nowrap">{formatDateTime(entry.at, locale)}</TableCell>
                <TableCell className="hidden max-w-48 truncate text-sm sm:table-cell lg:max-w-72" title={entry.admin?.displayName}>
                  {entry.admin?.displayName ?? <span className="text-muted-foreground">{t('audit.system')}</span>}
                </TableCell>
                <TableCell>
                  <span className="grid">
                    <span className="text-sm">{auditActionLabel(entry.action, t)}</span>
                    <span dir="ltr" className="font-mono text-xs text-muted-foreground">
                      {entry.action}
                    </span>
                  </span>
                </TableCell>
                <TableCell className="hidden max-w-56 md:table-cell">
                  <TargetCell entry={entry} />
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  {entry.ip ? (
                    <span dir="ltr" className="font-mono text-xs text-muted-foreground">
                      {entry.ip}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">{t('common.none')}</span>
                  )}
                </TableCell>
                <TableCell className="text-end">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-expanded={expanded}
                    aria-label={expanded ? t('audit.hideDetail') : t('audit.showDetail')}
                    onClick={() => setOpen(expanded ? null : entry.id)}
                  >
                    {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
                  </Button>
                </TableCell>
              </TableRow>
              {expanded && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={6} className="pt-0">
                    <dl className="mb-3 grid gap-x-6 gap-y-1 text-sm sm:hidden">
                      <div className="flex gap-2">
                        <dt className="text-muted-foreground">{t('audit.col.admin')}</dt>
                        <dd>{entry.admin?.displayName ?? t('audit.system')}</dd>
                      </div>
                    </dl>
                    <div className="mb-3 md:hidden">
                      <TargetCell entry={entry} />
                    </div>
                    {hasDetail ? <DetailJson value={entry.detail} /> : <p className="text-sm text-muted-foreground">{t('audit.noDetail')}</p>}
                  </TableCell>
                </TableRow>
              )}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}
