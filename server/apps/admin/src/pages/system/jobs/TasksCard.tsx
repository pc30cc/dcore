import type { AdminSystemHealth, AdminSystemQueues, AdminTask } from '@app/shared';
import type { UseQueryResult } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/ui/alert-dialog';
import { Badge, StatusDot } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useI18n } from '@/i18n/useI18n';
import { formatDateTime, formatNumber, joinFacts, unbreakable } from '@/lib/format';
import { asApiError } from '@/lib/http';
import { problemText } from '@/lib/problemText';
import { queryClient } from '@/lib/queries';
import { formatShortSpan, runFigures, runState, runTask, runTone, runWords, scheduleOf, scheduleText, scheduleUtc, systemKeys, taskLabel } from '@/lib/system';
import { showToast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { CardQuery, Shown, SystemCard } from './parts';

/** After "Run now", the page reads the queues again this much later (the run takes a moment to start). */
const RUN_REFRESH_MS = 5_000;

/**
 * Every scheduled task (and every task started by hand only): when it runs,
 * its next run, how its last run ended and its last success. With
 * `system.write`, "Run now" for the few maintenance tasks that allow it
 * (off while no worker runs maintenance).
 */
export function TasksCard({ query, health, canWrite }: { query: UseQueryResult<AdminSystemQueues>; health: AdminSystemHealth | undefined; canWrite: boolean }) {
  const { t } = useI18n();
  const [running, setRunning] = useState<AdminTask | null>(null);
  const [busy, setBusy] = useState(false);
  // Unknown until the health answers: the button stays on (the server's lease decides).
  const maintRunning = health === undefined || health.workers.some((worker) => worker.maint);

  async function run() {
    if (!running) return;
    setBusy(true);
    try {
      const result = await runTask(running.queue, running.name);
      if (result.already) showToast((t) => t('jobs.task.run.already'), 'info');
      else showToast((t) => t(result.sideEffects === 'failed' ? 'common.error.unavailable' : 'jobs.task.run.done'), result.sideEffects === 'failed' ? 'error' : 'success');
      setRunning(null);
      window.setTimeout(() => void queryClient.invalidateQueries({ queryKey: systemKeys.queues }), RUN_REFRESH_MS);
    } catch (error) {
      const failure = asApiError(error);
      setRunning(null);
      showToast((t, lang) => problemText(failure, t, lang), 'error', 6_000);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SystemCard title={t('jobs.tasks.title')}>
      <CardQuery query={query} rows={6}>
        {(data) => {
          const actions = canWrite && data.tasks.some((task) => task.runnable);
          return (
            <div className="-mx-4 min-w-0 sm:-mx-5">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>{t('jobs.col.task')}</TableHead>
                    <TableHead className="hidden md:table-cell">{t('jobs.col.schedule')}</TableHead>
                    <TableHead className="hidden lg:table-cell">{t('jobs.col.next')}</TableHead>
                    <TableHead className="hidden sm:table-cell">{t('jobs.col.last')}</TableHead>
                    <TableHead className="hidden xl:table-cell">{t('jobs.col.lastOk')}</TableHead>
                    {actions && (
                      <TableHead className="w-12">
                        <span className="sr-only">{t('common.actions')}</span>
                      </TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.tasks.map((task) => (
                    <TaskRow key={`${task.queue}/${task.name}`} task={task} actions={actions} blocked={task.queue === 'maint' && !maintRunning} onRun={() => setRunning(task)} />
                  ))}
                </TableBody>
              </Table>
            </div>
          );
        }}
      </CardQuery>
      <ConfirmDialog
        open={running !== null}
        onOpenChange={(open) => !open && !busy && setRunning(null)}
        title={running ? t('jobs.task.run.title', { task: taskLabel(running.queue, running.name, t).name }) : ''}
        description={t('jobs.task.run.body')}
        confirmLabel={t('jobs.task.run')}
        busy={busy}
        onConfirm={() => void run()}
      />
    </SystemCard>
  );
}

function Schedule({ task }: { task: AdminTask }) {
  const { t, locale } = useI18n();
  const schedule = scheduleOf(task);
  if (schedule.kind === 'cron') {
    return (
      <span dir="ltr" className="font-mono text-xs">
        {schedule.pattern}
        {task.tz ? ` ${task.tz}` : ''}
      </span>
    );
  }
  return <span title={scheduleUtc(schedule, t, locale) ?? undefined}>{scheduleText(schedule, t, locale)}</span>;
}

/** A task's last run; `compact` under the task's name on a phone, where "never" takes the size of the facts beside it. */
function LastRun({ task, compact = false }: { task: AdminTask; compact?: boolean }) {
  const { t, locale } = useI18n();
  const run = task.last;
  if (!run) return <span className={cn('text-muted-foreground', compact ? 'text-xs' : 'text-sm')}>{t('jobs.task.never')}</span>;
  const state = runState(run);
  const facts = [
    formatDateTime(run.at, locale),
    ...(run.durationMs !== null ? [t('jobs.task.took', { duration: unbreakable(formatShortSpan(run.durationMs, locale)) })] : []),
    ...(state === 'failed' || state === 'retrying' ? [t('jobs.task.attempt', { attempt: run.attempt, attempts: run.attempts })] : []),
  ];
  return (
    <span className="grid justify-items-start gap-0.5">
      <span className="flex flex-wrap items-center gap-2">
        <StatusDot tone={runTone[state]} className={cn(state === 'failed' && 'font-medium text-destructive')}>
          {t(runWords[state])}
        </StatusDot>
        {run.manual && <Badge variant="muted">{t('jobs.task.manual')}</Badge>}
      </span>
      <span className="text-xs text-muted-foreground">{joinFacts(facts, locale)}</span>
      {run.error && (
        <span dir="ltr" className="font-mono text-xs break-all text-destructive">
          {run.error}
        </span>
      )}
      <RunFigures run={run} />
    </span>
  );
}

/** What the run reports it did (its numeric summary: made, dropped, held...), each key as the job names it. */
function RunFigures({ run }: { run: NonNullable<AdminTask['last']> }) {
  const { t, locale } = useI18n();
  const figures = runFigures(run);
  if (figures.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
      {figures.map(([key, value]) => (
        <span key={key} className="inline-flex items-baseline gap-1">
          <span dir="ltr" className="font-mono">
            {key}
          </span>
          <span className="tabular-nums text-foreground">{typeof value === 'number' ? formatNumber(value, locale) : t(value ? 'common.yes' : 'common.no')}</span>
        </span>
      ))}
    </span>
  );
}

function TaskRow({ task, actions, blocked, onRun }: { task: AdminTask; actions: boolean; blocked: boolean; onRun: () => void }) {
  const { t, locale } = useI18n();
  const label = taskLabel(task.queue, task.name, t);
  const ran = task.last !== null || task.lastOkAt !== null;
  return (
    <TableRow>
      <TableCell className="max-w-72">
        <span className="grid justify-items-start gap-1">
          <Shown value={label} className="font-medium" />
          {/* Below md the schedule sits here, below sm the last run, below lg the next run, below xl the last success (their columns are hidden). */}
          <span className="text-xs text-muted-foreground md:hidden">
            <Schedule task={task} />
          </span>
          <span className="sm:hidden">
            <LastRun task={task} compact />
          </span>
          {(ran || task.nextAt) && (
            <span className={cn('flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground', ran ? 'xl:hidden' : 'lg:hidden')}>
              {/* A task that never ran says so once (its last run above, or in its column). */}
              {ran && (
                <span>
                  {t('jobs.col.lastOk')} <span className="text-foreground">{task.lastOkAt ? formatDateTime(task.lastOkAt, locale) : t('jobs.task.never')}</span>
                </span>
              )}
              {task.nextAt && (
                <span className="lg:hidden">
                  {t('jobs.col.next')} <span className="text-foreground">{formatDateTime(task.nextAt, locale)}</span>
                </span>
              )}
            </span>
          )}
          {task.runnable && blocked && <span className="text-xs text-muted-foreground sm:hidden">{t('jobs.task.noMaint')}</span>}
        </span>
      </TableCell>
      {/* May wrap between words; its time never breaks (scheduleText). */}
      <TableCell className="hidden text-sm md:table-cell">
        <Schedule task={task} />
      </TableCell>
      <TableCell className="hidden text-sm whitespace-nowrap text-muted-foreground lg:table-cell">{task.nextAt ? formatDateTime(task.nextAt, locale) : t('common.none')}</TableCell>
      <TableCell className="hidden sm:table-cell">
        <LastRun task={task} />
      </TableCell>
      <TableCell className="hidden text-sm whitespace-nowrap text-muted-foreground xl:table-cell">{task.lastOkAt ? formatDateTime(task.lastOkAt, locale) : t('jobs.task.never')}</TableCell>
      {actions && (
        <TableCell className="text-end">
          {task.runnable && (
            <span className="grid justify-items-end gap-1">
              <Button variant="outline" size="sm" disabled={blocked} onClick={onRun} aria-label={t('jobs.task.runOf', { task: label.name })} title={t('jobs.task.runOf', { task: label.name })}>
                <Play aria-hidden="true" />
                <span className="hidden xl:inline">{t('jobs.task.run')}</span>
              </Button>
              {blocked && <span className="hidden max-w-32 text-end text-xs text-muted-foreground sm:block">{t('jobs.task.noMaint')}</span>}
            </span>
          )}
        </TableCell>
      )}
    </TableRow>
  );
}
