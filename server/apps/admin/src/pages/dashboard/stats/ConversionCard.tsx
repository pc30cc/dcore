import { FactLine, Figures, StatsCard } from '@/components/charts/StatsCard';
import { useI18n } from '@/i18n/useI18n';
import { formatNumber } from '@/lib/format';
import { cardState, cellRate, cohortLines, cohortTable, csvName, formatPercent, mergeLines, useStatsConversion, type StatsRange } from '@/lib/stats';
import { CohortTable } from './CohortTable';

/** The card's name in its CSV file's name. */
const CSV = 'conversion';

/** Of each day's sign-ups, the share whose first payment came within 7 and 30 days (`dashboard.revenue`). */
export function ConversionCard({ range, className }: { range: StatsRange; className?: string | undefined }) {
  const { t, locale } = useI18n();
  const query = useStatsConversion(range, true);
  const cohorts = (query.data?.cohorts ?? []).filter((c) => c.signups > 0);
  const lines = cohortLines(cohorts, (c) => [c.d7?.total ?? null, c.d30?.total ?? null]);
  const average = mergeLines('', lines);
  const measures = [t('stats.conversion.d7'), t('stats.conversion.d30')];
  const byStore = (pick: 'd7' | 'd30', store: 'play' | 'bazaar') => cohorts.reduce((sum, c) => sum + (c[pick]?.[store] ?? 0), 0);
  const rate = (i: number) => {
    const value = cellRate(average.cells[i]);
    return value === null ? null : formatPercent(value, locale);
  };
  // Each rate with its base: the 7- and 30-day rates are measured on different cohorts.
  const storeLine = (pick: 'd7' | 'd30', i: number) => (
    <FactLine
      facts={[
        t('stats.cohort.base', { count: formatNumber(average.cells[i]?.base ?? 0, locale) }),
        ...(['play', 'bazaar'] as const).map((store) => t('stats.conversion.store', { store: t(`store.${store}`), count: formatNumber(byStore(pick, store), locale) })),
      ]}
    />
  );
  const title = t('stats.conversion.title');
  return (
    <StatsCard
      title={title}
      className={className}
      state={cardState(query)}
      empty={lines.length === 0}
      file={csvName(CSV, range)}
      tableOnly
      table={{
        columns: [
          { label: t('stats.col.day'), kind: 'day' },
          { label: t('stats.cohort.signups'), kind: 'count' },
          ...measures.map((label) => ({ label, kind: 'percent' as const })),
        ],
        rows: lines.map((line) => [line.day, line.signups, ...line.cells.map(cellRate)]),
      }}
    >
      <Figures
        fit
        items={[
          { key: 'd7', label: measures[0]!, value: rate(0), sub: average.cells[0] ? storeLine('d7', 0) : undefined },
          { key: 'd30', label: measures[1]!, value: rate(1), sub: average.cells[1] ? storeLine('d30', 1) : undefined },
        ]}
      />
      <CohortTable caption={title} measures={measures} lines={cohortTable(lines)} average={average} weekly={lines.length > 31} />
    </StatsCard>
  );
}
