import { providerHealth, providerHealthNames, type StatsSeriesMetric } from '@app/shared';
import { Figures, StatsCard } from '@/components/charts/StatsCard';
import { ChartLegend, TimeChart, type ChartSeries } from '@/components/charts/TimeChart';
import { useI18n } from '@/i18n/useI18n';
import { formatNumber } from '@/lib/format';
import { cardState, csvName, daysOf, formatPercent, formatShareTick, formatStatsDay, ratio, seriesValues, sumOf, useStatsSeries, type StatsRange } from '@/lib/stats';

/** The card's name in its CSV file's name. */
const CSV = 'providers';

const METRICS = providerHealthNames.flatMap((name) => [providerHealth[name].ok, providerHealth[name].failed]) satisfies StatsSeriesMetric[];

/** The calls to SMS, push and store providers by day: how many failed (no answer, or a server or access error). */
export function ProvidersCard({ range, className }: { range: StatsRange; className?: string | undefined }) {
  const { t, locale } = useI18n();
  const query = useStatsSeries(METRICS, range);
  const days = daysOf(range);
  const providers = providerHealthNames.map((name, i) => {
    const ok = seriesValues(query.data, providerHealth[name].ok, days);
    const failed = seriesValues(query.data, providerHealth[name].failed, days);
    return { name, slot: (i + 1) as 1 | 2 | 3, ok, failed, label: t(`stats.provider.${name}`) };
  });
  const empty = providers.every((p) => p.ok.every((v) => v === null) && p.failed.every((v) => v === null));
  const series: ChartSeries[] = providers.map((p) => ({
    key: p.name,
    label: p.label,
    slot: p.slot,
    values: days.map((_, i) => ratio(p.failed[i] ?? null, (p.ok[i] ?? 0) + (p.failed[i] ?? 0) || null)),
  }));
  const title = t('stats.providers.title');
  return (
    <StatsCard
      title={title}
      className={className}
      state={cardState(query)}
      empty={empty}
      file={csvName(CSV, range)}
      table={{
        columns: [
          { label: t('stats.col.day'), kind: 'day' },
          ...providers.flatMap((p) => [
            { label: t('stats.providers.col', { provider: p.label, what: t('stats.provider.col.ok') }), kind: 'count' as const },
            { label: t('stats.providers.col', { provider: p.label, what: t('stats.provider.col.failed') }), kind: 'count' as const },
          ]),
        ],
        rows: days.map((day, i) => [day, ...providers.flatMap((p) => [p.ok[i] ?? null, p.failed[i] ?? null])]),
      }}
    >
      <Figures
        fit
        items={providers.map((p) => {
          const failed = sumOf(p.failed) ?? 0;
          const all = (sumOf(p.ok) ?? 0) + failed;
          const rate = ratio(failed, all);
          return {
            key: p.name,
            label: p.label,
            value: rate === null ? null : formatPercent(rate, locale),
            sub: <span className="whitespace-nowrap">{t('stats.providers.failedOf', { failed: formatNumber(failed, locale), all: formatNumber(all, locale) })}</span>,
          };
        })}
      />
      <ChartLegend series={series} />
      <TimeChart
        days={days}
        series={series}
        label={t('stats.chart.label', { title, from: formatStatsDay(range.from, locale), to: formatStatsDay(range.to, locale) })}
        formatValue={(value) => formatPercent(value, locale)}
        formatTick={(value) => formatShareTick(value, locale)}
        height={160}
      />
    </StatsCard>
  );
}
