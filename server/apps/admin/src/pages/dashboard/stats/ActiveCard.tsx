import { ChartLegend, TimeChart, type ChartSeries } from '@/components/charts/TimeChart';
import { Figures, StatsCard } from '@/components/charts/StatsCard';
import { useI18n } from '@/i18n/useI18n';
import { ACTIVE_METRICS, cardState, csvName, daysOf, formatCount, formatStatsDay, lastOf, seriesValues, useStatsSeries, type StatsRange } from '@/lib/stats';

/** The card's name in its CSV file's name. */
const CSV = 'active';

/** Daily, weekly (7 days) and monthly (30 days) active people, test accounts out. */
export function ActiveCard({ range, className }: { range: StatsRange; className?: string | undefined }) {
  const { t, locale } = useI18n();
  const query = useStatsSeries(ACTIVE_METRICS, range);
  const days = daysOf(range);
  const series: ChartSeries[] = ACTIVE_METRICS.map((metric, i) => ({
    key: metric,
    label: t(`stats.metric.${metric}`),
    slot: (i + 1) as 1 | 2 | 3,
    values: seriesValues(query.data, metric, days),
  }));
  const empty = series.every((s) => s.values.every((v) => v === null));
  const title = t('stats.active.title');
  const count = (value: number | null) => (value === null ? null : formatCount(value, locale));
  return (
    <StatsCard
      title={title}
      className={className}
      state={cardState(query)}
      empty={empty}
      file={csvName(CSV, range)}
      table={{
        columns: [{ label: t('stats.col.day'), kind: 'day' }, ...series.map((s) => ({ label: s.label, kind: 'count' as const }))],
        rows: days.map((day, i) => [day, ...series.map((s) => s.values[i] ?? null)]),
      }}
    >
      <Figures items={series.map((s) => ({ key: s.key, label: s.label, value: count(lastOf(s.values)) }))} />
      <ChartLegend series={series} />
      <TimeChart
        days={days}
        series={series}
        label={t('stats.chart.label', { title, from: formatStatsDay(range.from, locale), to: formatStatsDay(range.to, locale) })}
        formatValue={(value) => formatCount(value, locale)}
        whole
      />
    </StatsCard>
  );
}
