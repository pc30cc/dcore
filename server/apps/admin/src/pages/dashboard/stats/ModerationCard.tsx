import { StatsCard } from '@/components/charts/StatsCard';
import { TimeChart } from '@/components/charts/TimeChart';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useI18n } from '@/i18n/useI18n';
import { formatNumber } from '@/lib/format';
import { cardState, csvName, daysOf, formatCount, formatPercent, formatSpan, formatStatsDay, useStatsModeration, type StatsRange } from '@/lib/stats';

/** The card's name in its CSV file's name (and the decisions by day's). */
const CSV = 'moderators';
const CSV_DAYS = 'moderators-days';

/**
 * Queue decisions per admin in the range (photos, texts, reports,
 * appeals): how many, the median wait of what they decided, and the
 * share later overturned on appeal. Names are the admins' display names
 * (nothing about their accounts). The decisions by day have their own
 * table and CSV.
 */
export function ModerationCard({ range, className }: { range: StatsRange; className?: string | undefined }) {
  const { t, locale } = useI18n();
  const query = useStatsModeration(range);
  const data = query.data;
  const rows = data?.moderators ?? [];
  const days = daysOf(range);
  const byDay = new Map(data?.days.map((d) => [d.day, d.decisions]));
  const title = t('stats.moderation.title');
  const kinds = ['photos', 'texts', 'reports', 'appeals'] as const;
  const kindLabel = { photos: t('nav.photos'), texts: t('nav.texts'), reports: t('nav.reports'), appeals: t('nav.appeals') };
  const wait = (seconds: number | null) => (seconds === null ? '—' : formatSpan(seconds, locale));
  const overturned = (m: (typeof rows)[number]) =>
    `${m.overturnRate === null ? '—' : formatPercent(m.overturnRate, locale)}${m.overturned > 0 ? ` (${formatNumber(m.overturned, locale)})` : ''}`;
  return (
    <StatsCard
      title={title}
      className={className}
      state={cardState(query)}
      empty={rows.length === 0}
      file={csvName(CSV, range)}
      tableOnly
      chartTable={{
        file: csvName(CSV_DAYS, range),
        table: {
          columns: [
            { label: t('stats.col.day'), kind: 'day' },
            { label: t('stats.moderation.col.decisions'), kind: 'count' },
          ],
          rows: days.map((day) => [day, byDay.get(day) ?? null]),
        },
      }}
      table={{
        columns: [
          { label: t('stats.moderation.col.admin'), kind: 'text' },
          { label: t('stats.moderation.col.decisions'), kind: 'count' },
          ...kinds.map((k) => ({ label: kindLabel[k], kind: 'count' as const })),
          { label: t('stats.moderation.col.wait'), kind: 'span' },
          { label: t('stats.moderation.col.overturned'), kind: 'count' },
          { label: t('stats.moderation.col.overturnRate'), kind: 'percent' },
        ],
        rows: rows.map((m) => [m.admin.displayName, m.decisions, ...kinds.map((k) => m[k]), m.responseMedianS, m.overturned, m.overturnRate]),
      }}
    >
      <TimeChart
        bars
        weeks
        days={days}
        series={[{ key: 'decisions', label: t('stats.moderation.col.decisions'), slot: 1, values: days.map((day) => byDay.get(day) ?? null) }]}
        label={t('stats.chart.label', { title, from: formatStatsDay(range.from, locale), to: formatStatsDay(range.to, locale) })}
        formatValue={(value) => formatCount(value, locale)}
        height={140}
      />
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <caption className="sr-only">{title}</caption>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="normal-case">{t('stats.moderation.col.admin')}</TableHead>
              <TableHead className="text-end normal-case">{t('stats.moderation.col.decisions')}</TableHead>
              {kinds.map((k) => (
                <TableHead key={k} className="hidden text-end normal-case md:table-cell">
                  {kindLabel[k]}
                </TableHead>
              ))}
              <TableHead className="hidden text-end normal-case sm:table-cell">{t('stats.moderation.col.wait')}</TableHead>
              <TableHead className="hidden text-end normal-case sm:table-cell">{t('stats.moderation.col.overturnRate')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((m) => (
              <TableRow key={m.admin.id}>
                <TableCell className="py-2">
                  <span className="block font-medium break-words whitespace-normal">{m.admin.displayName}</span>
                  <span className="text-xs text-muted-foreground sm:hidden">
                    <span className="me-3 inline-block whitespace-nowrap">
                      {t('stats.moderation.col.wait')} {wait(m.responseMedianS)}
                    </span>
                    <span className="inline-block whitespace-nowrap">
                      {t('stats.moderation.col.overturnRate')} {overturned(m)}
                    </span>
                  </span>
                </TableCell>
                <TableCell className="py-2 text-end tabular-nums">{formatNumber(m.decisions, locale)}</TableCell>
                {kinds.map((k) => (
                  <TableCell key={k} className="hidden py-2 text-end tabular-nums md:table-cell">
                    {formatNumber(m[k], locale)}
                  </TableCell>
                ))}
                <TableCell className="hidden py-2 text-end whitespace-nowrap tabular-nums sm:table-cell">{wait(m.responseMedianS)}</TableCell>
                <TableCell className="hidden py-2 text-end whitespace-nowrap tabular-nums sm:table-cell">
                  {m.overturnRate === null ? '—' : formatPercent(m.overturnRate, locale)}
                  {m.overturned > 0 && <span className="ms-1 text-xs text-muted-foreground">({formatNumber(m.overturned, locale)})</span>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </StatsCard>
  );
}
