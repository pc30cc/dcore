import { SCROLL_BOX, STICKY_HEADER } from '@/components/charts/StatsCard';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useI18n } from '@/i18n/useI18n';
import { formatNumber } from '@/lib/format';
import { cellRate, formatPercent, formatStatsDay, type CohortLine } from '@/lib/stats';
import { cn } from '@/lib/utils';

/** Cohort lines spanning more than this many days name their year (in figures, to fit a phone). */
const YEARLESS_SPAN_DAYS = 92;

/**
 * Sign-up cohorts (a day, or a week in a long range) with a rate per
 * measure; the first line is the average over the cohorts each measure
 * reached, each rate's base (the sign-ups it was measured on) in its title
 * and spoken. A rate's cell is tinted by its size; a dash (spoken "Not
 * yet") where the measure's day has not come. A measure no cohort of the
 * range has reached is left out of the table (the CSV keeps it).
 */
export function CohortTable({ caption, measures, lines, average, weekly }: { caption: string; measures: readonly string[]; lines: readonly CohortLine[]; average: CohortLine; weekly: boolean }) {
  const { t, locale } = useI18n();
  const shown = measures.map((_, i) => i).filter((i) => average.cells[i] !== null);
  const days = lines.map((line) => Date.parse(line.day));
  const long = days.length > 1 && (Math.max(...days) - Math.min(...days)) / 86_400_000 > YEARLESS_SPAN_DAYS;
  const pad = 'px-2 first:ps-3 last:pe-3 sm:px-3 sm:first:ps-4 sm:last:pe-4';
  const row = (line: CohortLine, head: string, strong = false) => (
    <TableRow key={head} className={cn(strong && 'bg-muted/40 font-medium hover:bg-muted/40')}>
      <TableCell className={cn('py-2 whitespace-nowrap', pad)}>{head}</TableCell>
      <TableCell className={cn('py-2 text-end tabular-nums', pad)}>{formatNumber(line.signups, locale)}</TableCell>
      {shown.map((i) => {
        const cell = line.cells[i] ?? null;
        const rate = cellRate(cell);
        const base = strong && cell ? t('stats.cohort.base', { count: formatNumber(cell.base, locale) }) : undefined;
        return (
          <TableCell
            key={i}
            className={cn('py-2 text-end tabular-nums whitespace-nowrap', pad)}
            title={base}
            style={rate === null ? undefined : { background: `color-mix(in oklab, var(--chart-1) ${Math.round(Math.min(1, rate) * 55)}%, transparent)` }}
          >
            {rate === null ? (
              <>
                <span className="text-muted-foreground" aria-hidden="true">
                  —
                </span>
                <span className="sr-only">{t('stats.cohort.pending')}</span>
              </>
            ) : (
              <>
                {formatPercent(rate, locale)}
                {base && <span className="sr-only">{` ${base}`}</span>}
              </>
            )}
          </TableCell>
        );
      })}
    </TableRow>
  );
  return (
    <Table containerClassName={cn(SCROLL_BOX, 'max-h-[26rem]')}>
      <caption className="sr-only">{caption}</caption>
      <TableHeader className={STICKY_HEADER}>
        <TableRow className="hover:bg-transparent">
          <TableHead className={cn('bg-muted/50 normal-case', pad)}>{weekly ? t('stats.col.week') : t('stats.col.day')}</TableHead>
          <TableHead className={cn('bg-muted/50 text-end normal-case', pad)}>{t('stats.cohort.signups')}</TableHead>
          {shown.map((i) => (
            <TableHead key={measures[i]} className={cn('bg-muted/50 text-end whitespace-normal normal-case', pad)}>
              {measures[i]}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {row(average, t('stats.cohort.average'), true)}
        {lines.map((line) => row(line, formatStatsDay(line.day, locale, long ? 'numeric' : 'short')))}
      </TableBody>
    </Table>
  );
}
