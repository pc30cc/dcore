import type { AdminSystemStreams, StreamName } from '@app/shared';
import type { UseQueryResult } from '@tanstack/react-query';
import { Eye, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useI18n } from '@/i18n/useI18n';
import { formatNumber } from '@/lib/format';
import { formatSpan } from '@/lib/stats';
import { lagTone, streamDelayMs } from '@/lib/system';
import { cn } from '@/lib/utils';
import { DeadLettersDialog } from './DeadLettersDialog';
import { CardQuery, SystemCard } from './parts';

type Stream = AdminSystemStreams['streams'][number];

const TONE_TEXT = { green: '', amber: 'font-medium text-amber-700 dark:text-amber-300', red: 'font-medium text-destructive' } as const;

/**
 * The write-behind streams of likes, matches and messages: what waits to be
 * saved (not delivered yet, or being saved), what is being saved, how far
 * behind they are, their readers, the entries a stream still keeps after
 * saving them (until a trim), and their failed entries (viewed and deleted
 * in a dialog; never replayed).
 */
export function StreamsCard({ query, canWrite }: { query: UseQueryResult<AdminSystemStreams>; canWrite: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<StreamName | null>(null);
  return (
    <SystemCard title={t('jobs.streams.title')}>
      <CardQuery query={query}>
        {(data) => (
          <div className="-mx-4 min-w-0 sm:-mx-5">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('jobs.col.stream')}</TableHead>
                  <TableHead className="hidden text-end sm:table-cell">{t('jobs.col.waiting')}</TableHead>
                  <TableHead className="hidden text-end sm:table-cell">{t('jobs.col.pending')}</TableHead>
                  <TableHead className="hidden text-end sm:table-cell">{t('dashboard.health.col.delay')}</TableHead>
                  <TableHead className="hidden text-end md:table-cell">{t('jobs.col.readers')}</TableHead>
                  <TableHead className="hidden text-end xl:table-cell">{t('jobs.col.kept')}</TableHead>
                  <TableHead className="text-end">{t('jobs.col.dead')}</TableHead>
                  <TableHead className="w-12">
                    <span className="sr-only">{t('common.actions')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.streams.map((stream) => (
                  <StreamRow key={stream.name} stream={stream} onView={() => setOpen(stream.name)} />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardQuery>
      {open && <DeadLettersDialog stream={open} dead={query.data?.streams.find((stream) => stream.name === open)?.dead ?? 0} canWrite={canWrite} onClose={() => setOpen(null)} />}
    </SystemCard>
  );
}

function StreamRow({ stream, onView }: { stream: Stream; onView: () => void }) {
  const { t, locale } = useI18n();
  const name = t(`dashboard.stream.${stream.name}`);
  const delay = streamDelayMs(stream);
  const tone = lagTone(delay);
  // Under a second reads in seconds ("0 sec"), not as a figure of milliseconds.
  const delayText = delay === null ? t('common.none') : formatSpan(delay < 1_000 ? 0 : delay / 1000, locale);
  // Not delivered yet plus being saved; unknown without a reader group.
  const waiting = stream.waiting === null ? t('common.none') : formatNumber(stream.waiting, locale);
  return (
    <TableRow>
      <TableCell className="max-w-56">
        <span className="grid gap-1">
          <span className="font-medium">{name}</span>
          {!stream.group && (
            <span className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300">
              <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
              {t('jobs.stream.noGroup')}
            </span>
          )}
          {/* On a phone the figures sit here (their columns are hidden). */}
          <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground sm:hidden">
            <span>
              {t('jobs.col.waiting')} <span className="tabular-nums">{waiting}</span>
            </span>
            <span>
              {t('jobs.col.pending')} <span className="tabular-nums">{formatNumber(stream.pending, locale)}</span>
            </span>
            <span>
              {t('dashboard.health.col.delay')} <span className={cn('tabular-nums', TONE_TEXT[tone])}>{delayText}</span>
            </span>
          </span>
        </span>
      </TableCell>
      <TableCell className="hidden text-end tabular-nums sm:table-cell">{waiting}</TableCell>
      <TableCell className="hidden text-end tabular-nums sm:table-cell">{formatNumber(stream.pending, locale)}</TableCell>
      <TableCell className={cn('hidden text-end tabular-nums sm:table-cell', TONE_TEXT[tone])}>{delayText}</TableCell>
      <TableCell className="hidden text-end tabular-nums md:table-cell">{formatNumber(stream.consumers, locale)}</TableCell>
      <TableCell className="hidden text-end tabular-nums text-muted-foreground xl:table-cell">{formatNumber(stream.length, locale)}</TableCell>
      <TableCell className={cn('text-end tabular-nums', stream.dead > 0 && 'font-medium text-destructive')}>{formatNumber(stream.dead, locale)}</TableCell>
      <TableCell className="text-end">
        <Button variant="ghost" size="sm" disabled={stream.dead === 0} onClick={onView} aria-label={t('jobs.dead.viewOf', { stream: name })} title={t('jobs.dead.viewOf', { stream: name })}>
          <Eye aria-hidden="true" />
          <span className="hidden lg:inline">{t('jobs.dead.view')}</span>
        </Button>
      </TableCell>
    </TableRow>
  );
}
