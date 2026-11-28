import { PARTITION_XID_AGE_WARN, type AdminSystemPartitions } from '@app/shared';
import type { UseQueryResult } from '@tanstack/react-query';
import { hasMessage } from '@/i18n/translate';
import { useI18n } from '@/i18n/useI18n';
import { formatDate, formatNumber } from '@/lib/format';
import { formatBytes, formatPeriodLength, partitionTone } from '@/lib/system';
import { cn } from '@/lib/utils';
import { CardQuery, Fact, SystemCard } from './parts';

type Parent = AdminSystemPartitions['parents'][number];

/**
 * The partitioned tables (messages, likes, the audit log): how many periods
 * are made ahead, how long partitions are kept and when the oldest goes,
 * the planner's row and size estimates, and the oldest transaction age; the
 * partitions themselves folded.
 */
export function PartitionsCard({ query }: { query: UseQueryResult<AdminSystemPartitions> }) {
  const { t } = useI18n();
  return (
    <SystemCard title={t('jobs.partitions.title')}>
      <CardQuery query={query}>
        {(data) =>
          data.parents.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('jobs.partitions.empty')}</p>
          ) : (
            <div className="grid gap-4 lg:grid-cols-3">
              {data.parents.map((parent) => (
                <ParentBlock key={parent.parent} parent={parent} />
              ))}
            </div>
          )
        }
      </CardQuery>
    </SystemCard>
  );
}

const DOT = { green: 'bg-emerald-500', amber: 'bg-amber-500', red: 'bg-red-500' } as const;
const TONE_TEXT = { green: '', amber: 'font-medium text-amber-700 dark:text-amber-300', red: 'font-medium text-destructive' } as const;

function ParentBlock({ parent }: { parent: Parent }) {
  const { t, locale } = useI18n();
  const key = `jobs.parent.${parent.parent}`;
  const name = hasMessage(key) ? t(key) : parent.parent;
  const tone = partitionTone(parent);
  const aheadTone = !parent.current ? 'red' : parent.ahead < parent.premake ? 'amber' : 'green';
  const xidHigh = parent.maxXidAge >= PARTITION_XID_AGE_WARN;
  const kept =
    parent.retention === null
      ? t('jobs.partitions.forever')
      : parent.retention.months > 0
        ? formatPeriodLength(parent.retention.months, 'month', locale)
        : formatPeriodLength(parent.retention.days, 'day', locale);
  return (
    <section className="grid min-w-0 content-start gap-3 rounded-lg border p-4">
      <h3 className="flex items-center justify-between gap-2 text-sm font-semibold">
        <span className="min-w-0 truncate">{name}</span>
        <span className={cn('size-2 shrink-0 rounded-full', DOT[tone])} aria-hidden="true" />
      </h3>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        <Fact label={t('jobs.partitions.col.period')}>{t(`jobs.partitions.period.${parent.period}`)}</Fact>
        <Fact label={t('jobs.partitions.col.ahead')}>
          <span className={cn('tabular-nums', TONE_TEXT[aheadTone])}>{formatNumber(parent.ahead, locale)}</span>
          {aheadTone !== 'green' && (
            <span className={cn('block text-xs', TONE_TEXT[aheadTone])}>{t(parent.current ? 'jobs.partitions.aheadLow' : 'jobs.partitions.noCurrent', { premake: parent.premake })}</span>
          )}
        </Fact>
        <Fact label={t('jobs.partitions.col.kept')}>{kept}</Fact>
        <Fact label={t('jobs.partitions.col.nextDrop')}>{parent.nextDropAfter ? formatDate(parent.nextDropAfter, locale) : t('common.none')}</Fact>
        <Fact label={t('jobs.partitions.col.rows')}>
          <span className="tabular-nums">{formatNumber(parent.rowsEstimate, locale)}</span>
        </Fact>
        <Fact label={t('jobs.partitions.col.size')}>{formatBytes(parent.bytesEstimate, locale)}</Fact>
        <Fact label={t('jobs.partitions.col.xid')}>
          <span className={cn('tabular-nums', xidHigh && TONE_TEXT.amber)}>{formatNumber(parent.maxXidAge, locale)}</span>
          {xidHigh && <span className={cn('block text-xs', TONE_TEXT.amber)}>{t('jobs.partitions.xidHigh')}</span>}
        </Fact>
      </dl>
      <details className="text-sm">
        <summary className="cursor-pointer text-xs text-muted-foreground select-none">{t('jobs.partitions.list', { count: parent.partitions.length })}</summary>
        {/* A partition is named by its period (its name, the parent's and the period's first day, on hover); its end is shown from sm up. */}
        <table className="mt-2 w-full text-xs">
          <thead>
            <tr className="text-muted-foreground">
              <th className="py-1 pe-2 text-start font-normal">{t('jobs.partitions.col.from')}</th>
              <th className="hidden py-1 pe-2 text-start font-normal sm:table-cell">{t('jobs.partitions.col.to')}</th>
              <th className="py-1 pe-2 text-end font-normal">{t('jobs.partitions.col.rows')}</th>
              <th className="py-1 text-end font-normal">{t('jobs.partitions.col.size')}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {parent.partitions.map((partition) => (
              <tr key={partition.name} title={partition.name}>
                <td className="py-1 pe-2 whitespace-nowrap">{formatDate(partition.from, locale)}</td>
                <td className="hidden py-1 pe-2 whitespace-nowrap sm:table-cell">{formatDate(partition.to, locale)}</td>
                <td className="py-1 pe-2 text-end whitespace-nowrap tabular-nums">{partition.rowsEstimate === null ? t('common.none') : formatNumber(partition.rowsEstimate, locale)}</td>
                <td className="py-1 text-end whitespace-nowrap tabular-nums">{formatBytes(partition.bytesEstimate, locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
