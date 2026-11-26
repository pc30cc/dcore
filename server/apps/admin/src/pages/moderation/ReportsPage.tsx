import type { AdminReportSummary, AdminReportView } from '@app/shared';
import { Flag } from 'lucide-react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { listState } from '@/lib/listState';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadError, TableSkeleton } from '@/components/QueryState';
import { Badge, StatusDot } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { UserRef } from '@/components/UserRef';
import type { MessageKey } from '@/i18n/messages';
import { useI18n } from '@/i18n/useI18n';
import { formatDate, formatNumber } from '@/lib/format';
import { isReportView, priorityTone, reportViews } from '@/lib/moderation';
import { useReports } from '@/lib/queries';
import { EmptyLine, RefreshButton } from './QueueParts';

/** `/moderation/reports`: the queue (most urgent first), the admin's own, the unassigned ones and the closed ones (`?view=`). */
export function ReportsPage() {
  const { t, dir } = useI18n();
  const [params, setParams] = useSearchParams();
  const raw = params.get('view');
  const view: AdminReportView = isReportView(raw) ? raw : 'queue';
  const reports = useReports(view);
  const items = reports.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6">
      <PageHeader icon={Flag} title={t('reports.title')} actions={<RefreshButton onClick={() => void reports.refetch()} busy={reports.isFetching} />} />
      <Tabs value={view} onValueChange={(value) => setParams(value === 'queue' ? {} : { view: value }, { replace: true })} dir={dir} className="gap-4">
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <TabsList aria-label={t('reports.title')}>
            {reportViews.map((v) => (
              <TabsTrigger key={v} value={v}>
                {t(`reports.view.${v}` as MessageKey)}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value={view}>
      <section className="overflow-hidden rounded-xl border bg-card text-card-foreground shadow-xs">
        {reports.isPending ? (
          <TableSkeleton />
        ) : reports.isError && items.length === 0 ? (
          <div className="p-4">
            <LoadError error={reports.error} onRetry={() => void reports.refetch()} />
          </div>
        ) : items.length === 0 ? (
          <EmptyLine text={view === 'resolved' ? t('reports.emptyClosed') : t('queue.empty')} />
        ) : (
          <ReportTable rows={items} closed={view === 'resolved'} />
        )}
        {reports.hasNextPage && (
          <div className="border-t p-3 text-center">
            <Button variant="outline" size="sm" onClick={() => void reports.fetchNextPage()} disabled={reports.isFetchingNextPage}>
              {t('common.loadMore')}
            </Button>
          </div>
        )}
      </section>
        </TabsContent>
      </Tabs>
    </div>
  );
}

export function PriorityCell({ priority }: { priority: number }) {
  const { locale } = useI18n();
  return (
    <StatusDot tone={priorityTone(priority)} className="tabular-nums">
      {formatNumber(priority, locale)}
    </StatusDot>
  );
}

export function ReasonBadge({ reason, className }: { reason: AdminReportSummary['reason']; className?: string }) {
  const { t } = useI18n();
  return <Badge variant={reason === 'child_safety' ? 'destructive' : 'secondary'} className={className}>{t(`reportReason.${reason}` as MessageKey)}</Badge>;
}

function ReportTable({ rows, closed }: { rows: readonly AdminReportSummary[]; closed: boolean }) {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  // The report page's back link and its close return to this view.
  const state = listState(useLocation().search);
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="hidden sm:table-cell">{t('reports.col.priority')}</TableHead>
          <TableHead>{t('reports.col.reason')}</TableHead>
          <TableHead>{t('reports.col.reported')}</TableHead>
          <TableHead className="hidden md:table-cell">{t('reports.col.reporter')}</TableHead>
          <TableHead className="hidden lg:table-cell">{t('reports.col.context')}</TableHead>
          <TableHead className="hidden sm:table-cell">{t('reports.col.filed')}</TableHead>
          {closed ? (
            <>
              <TableHead className="hidden md:table-cell">{t('reports.col.resolution')}</TableHead>
              <TableHead className="hidden sm:table-cell">{t('reports.col.closed')}</TableHead>
            </>
          ) : (
            <>
              <TableHead className="hidden md:table-cell">{t('reports.col.assignee')}</TableHead>
              <TableHead className="hidden lg:table-cell">{t('reports.col.evidence')}</TableHead>
            </>
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((report) => (
          // The reason is the row's link (keyboard, screen reader, a new tab); a click elsewhere on the row opens it too.
          <TableRow key={report.id} className="cursor-pointer" onClick={(event) => !(event.target as HTMLElement).closest('a') && void navigate(`/moderation/reports/${report.id}`, { state })}>
            <TableCell className="hidden sm:table-cell">
              <PriorityCell priority={report.priority} />
            </TableCell>
            <TableCell>
              {/* On a phone the priority sits with the reason (its column is the first to go). */}
              <span className="mb-1 block sm:hidden">
                <PriorityCell priority={report.priority} />
              </span>
              <Link
                to={`/moderation/reports/${report.id}`}
                state={state}
                aria-label={t('reports.openReport', { reason: t(`reportReason.${report.reason}` as MessageKey), name: report.reported.name ?? report.reported.id })}
                className="inline-flex rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <ReasonBadge reason={report.reason} className="whitespace-normal sm:whitespace-nowrap" />
              </Link>
            </TableCell>
            <TableCell className="max-w-56">
              <UserRef user={report.reported} />
            </TableCell>
            <TableCell className="hidden max-w-56 md:table-cell">{report.reporter ? <UserRef user={report.reporter} /> : <span className="text-sm text-muted-foreground">{t('common.automatic')}</span>}</TableCell>
            <TableCell className="hidden text-sm lg:table-cell">{t(`reportContext.${report.context}` as MessageKey)}</TableCell>
            <TableCell className="hidden text-sm whitespace-nowrap text-muted-foreground sm:table-cell">{formatDate(report.filedAt, locale)}</TableCell>
            {closed ? (
              <>
                <TableCell className="hidden text-sm md:table-cell">{report.resolution ? t(`resolution.${report.resolution}` as MessageKey) : t('common.none')}</TableCell>
                <TableCell className="hidden text-sm whitespace-nowrap text-muted-foreground sm:table-cell">{report.resolvedAt ? formatDate(report.resolvedAt, locale) : t('common.none')}</TableCell>
              </>
            ) : (
              <>
                <TableCell className="hidden text-sm md:table-cell">{report.assignee?.displayName ?? t('common.none')}</TableCell>
                <TableCell className="hidden text-sm lg:table-cell">
                  {report.evidence === 'collecting' && <StatusDot tone="amber">{t('report.collecting')}</StatusDot>}
                </TableCell>
              </>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
