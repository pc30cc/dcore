import { SYSTEM_JOB_ACTION_MAX, type AdminQueue, type AdminSystemQueues } from '@app/shared';
import type { UseQueryResult } from '@tanstack/react-query';
import { ChevronDown, RotateCcw, Trash2 } from 'lucide-react';
import { Fragment, useState } from 'react';
import { ConfirmDialog } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useI18n } from '@/i18n/useI18n';
import { formatDateTime, formatNumber } from '@/lib/format';
import { asApiError } from '@/lib/http';
import { problemText } from '@/lib/problemText';
import { queryClient } from '@/lib/queries';
import { actOnFailedJobs, failedJobLabel, groupAction, queueLabel, systemKeys } from '@/lib/system';
import { showToast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { CardQuery, Shown, SystemCard } from './parts';

type Group = AdminQueue['failed']['groups'][number];

/**
 * Every job queue: its waiting, running, scheduled and failed jobs. A queue
 * with failed jobs opens to them, grouped by job name (counts and times
 * only: no job, its data or its error is ever shown); with `system.write` a
 * group is retried (where a late run is harmless) or removed.
 */
export function QueuesCard({ query, canWrite }: { query: UseQueryResult<AdminSystemQueues>; canWrite: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (name: string) =>
    setOpen((held) => {
      const next = new Set(held);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  return (
    <SystemCard title={t('jobs.queues.title')}>
      <CardQuery query={query} rows={6}>
        {(data) => (
          <>
            <div className="-mx-4 min-w-0 sm:-mx-5">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>{t('jobs.col.queue')}</TableHead>
                    <TableHead className="hidden text-end sm:table-cell">{t('dashboard.health.col.waiting')}</TableHead>
                    <TableHead className="hidden text-end sm:table-cell">{t('dashboard.health.col.running')}</TableHead>
                    <TableHead className="hidden text-end sm:table-cell">{t('dashboard.health.col.scheduled')}</TableHead>
                    <TableHead className="text-end">{t('dashboard.health.col.failed')}</TableHead>
                    <TableHead className="w-12">
                      <span className="sr-only">{t('common.actions')}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.queues.map((queue) => (
                    <QueueRows key={queue.name} queue={queue} open={open.has(queue.name)} onToggle={() => toggle(queue.name)} canWrite={canWrite} />
                  ))}
                </TableBody>
              </Table>
            </div>
            {data.queues.every((queue) => queue.counts.failed === 0) && <p className="text-sm text-muted-foreground">{t('jobs.failed.empty')}</p>}
          </>
        )}
      </CardQuery>
    </SystemCard>
  );
}

function QueueRows({ queue, open, onToggle, canWrite }: { queue: AdminQueue; open: boolean; onToggle: () => void; canWrite: boolean }) {
  const { t, locale } = useI18n();
  const label = queueLabel(queue.name, t);
  const n = (value: number) => formatNumber(value, locale);
  const groupsId = `failed-${queue.name}`;
  return (
    <Fragment>
      <TableRow>
        <TableCell>
          <span className="grid gap-0.5">
            <span className="flex flex-wrap items-center gap-2">
              <Shown value={label} className="font-medium" />
              {queue.paused && <Badge variant="warning">{t('jobs.queue.paused')}</Badge>}
            </span>
            {/* On a phone the other counts sit here (their columns are hidden). */}
            <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground sm:hidden">
              <span>
                {t('dashboard.health.col.waiting')} <span className="tabular-nums">{n(queue.counts.waiting)}</span>
              </span>
              <span>
                {t('dashboard.health.col.running')} <span className="tabular-nums">{n(queue.counts.active)}</span>
              </span>
              <span>
                {t('dashboard.health.col.scheduled')} <span className="tabular-nums">{n(queue.counts.delayed)}</span>
              </span>
            </span>
          </span>
        </TableCell>
        <TableCell className="hidden text-end tabular-nums sm:table-cell">{n(queue.counts.waiting)}</TableCell>
        <TableCell className="hidden text-end tabular-nums sm:table-cell">{n(queue.counts.active)}</TableCell>
        <TableCell className="hidden text-end tabular-nums sm:table-cell">{n(queue.counts.delayed)}</TableCell>
        <TableCell className={cn('text-end tabular-nums', queue.counts.failed > 0 && 'font-medium text-destructive')}>{n(queue.counts.failed)}</TableCell>
        <TableCell className="text-end">
          {queue.failed.groups.length > 0 && (
            <Button variant="ghost" size="icon" className="-my-2 size-8" aria-expanded={open} aria-controls={groupsId} aria-label={t('jobs.queue.expand', { queue: label.name })} onClick={onToggle}>
              <ChevronDown className={cn('transition-transform', open && 'rotate-180')} aria-hidden="true" />
            </Button>
          )}
        </TableCell>
      </TableRow>
      {open && queue.failed.groups.length > 0 && (
        <TableRow id={groupsId} className="bg-muted/30 hover:bg-muted/30">
          <TableCell colSpan={6} className="py-3">
            <FailedGroups queue={queue} canWrite={canWrite} />
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  );
}

function FailedGroups({ queue, canWrite }: { queue: AdminQueue; canWrite: boolean }) {
  const { t, locale } = useI18n();
  const [acting, setActing] = useState<{ group: Group; action: 'retry' | 'remove' } | null>(null);
  const [busy, setBusy] = useState(false);
  const jobName = (group: Group) => failedJobLabel(queue.name, group.name, t);
  // The exact count only when the page counted every failed job of the queue; else what one action takes at most.
  const confirmTitle = (group: Group, action: 'retry' | 'remove') =>
    groupAction(queue, group.count).exact
      ? t(action === 'retry' ? 'jobs.failed.retry.title' : 'jobs.failed.remove.title', { count: group.count, job: jobName(group).name })
      : t(action === 'retry' ? 'jobs.failed.retry.titleMore' : 'jobs.failed.remove.titleMore', { max: SYSTEM_JOB_ACTION_MAX, job: jobName(group).name });

  async function act() {
    if (!acting) return;
    setBusy(true);
    try {
      // Bounded to the count the confirm named (when the page counted every failed job of the queue).
      const result = await actOnFailedJobs(acting.action, queue.name, acting.group.name, groupAction(queue, acting.group.count).max);
      const tone = result.sideEffects === 'failed' ? 'error' : 'success';
      if (result.matched === 0) showToast((t) => t('jobs.failed.nothing'), 'info');
      else if (result.more) showToast((t) => t('jobs.failed.doneMore', { done: result.done }), tone, 6_000);
      else showToast((t) => t('jobs.failed.done', { done: result.done, matched: result.matched }), tone);
      setActing(null);
      await queryClient.invalidateQueries({ queryKey: systemKeys.queues });
    } catch (error) {
      const failure = asApiError(error);
      setActing(null);
      showToast((t, lang) => problemText(failure, t, lang), 'error', 6_000);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2">
      {/* Fixed columns: every opened queue lines its counts and times up with the others. */}
      <table className="w-full table-fixed text-sm">
        <thead>
          <tr className="text-xs text-muted-foreground">
            <th className="py-1 pe-3 text-start font-normal">{t('jobs.failed.col.job')}</th>
            <th className="w-16 py-1 pe-3 text-end font-normal sm:w-20">{t('jobs.failed.col.count')}</th>
            <th className="hidden w-48 py-1 ps-6 pe-3 text-start font-normal sm:table-cell">{t('jobs.failed.col.newest')}</th>
            <th className="w-32 py-1 md:w-56">
              <span className="sr-only">{t('common.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {queue.failed.groups.map((group) => {
            const name = jobName(group);
            return (
              <tr key={group.name}>
                <td className="py-2 pe-3 align-middle">
                  <span className="grid justify-items-start gap-0.5">
                    <Shown value={name} />
                    <span className="text-xs text-muted-foreground sm:hidden">{formatDateTime(group.newestAt, locale)}</span>
                  </span>
                </td>
                <td className="py-2 pe-3 text-end align-middle font-medium tabular-nums">{formatNumber(group.count, locale)}</td>
                <td className="hidden py-2 ps-6 pe-3 align-middle whitespace-nowrap text-muted-foreground sm:table-cell">{formatDateTime(group.newestAt, locale)}</td>
                <td className="py-2 align-middle">
                  <span className="flex flex-wrap items-center justify-end gap-1">
                    {!group.retryable && <span className="text-xs text-muted-foreground">{t('jobs.failed.noRetry')}</span>}
                    {canWrite && group.retryable && (
                      <Button variant="ghost" size="sm" onClick={() => setActing({ group, action: 'retry' })} aria-label={t('jobs.failed.retryOf', { job: name.name })} title={t('jobs.failed.retryOf', { job: name.name })}>
                        <RotateCcw aria-hidden="true" />
                        <span className="hidden md:inline">{t('jobs.failed.retry')}</span>
                      </Button>
                    )}
                    {canWrite && (
                      <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setActing({ group, action: 'remove' })} aria-label={t('jobs.failed.removeOf', { job: name.name })} title={t('jobs.failed.removeOf', { job: name.name })}>
                        <Trash2 aria-hidden="true" />
                        <span className="hidden md:inline">{t('jobs.failed.remove')}</span>
                      </Button>
                    )}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {queue.failed.more && <p className="text-xs text-muted-foreground">{t('jobs.failed.more', { count: queue.failed.scanned })}</p>}
      <ConfirmDialog
        open={acting !== null}
        onOpenChange={(open) => !open && !busy && setActing(null)}
        title={acting ? confirmTitle(acting.group, acting.action) : ''}
        description={acting ? t(acting.action === 'retry' ? 'jobs.failed.retry.body' : 'jobs.failed.remove.body') : ''}
        confirmLabel={acting?.action === 'retry' ? t('jobs.failed.retry') : t('jobs.failed.remove')}
        destructive={acting?.action === 'remove'}
        busy={busy}
        onConfirm={() => void act()}
      />
    </div>
  );
}
