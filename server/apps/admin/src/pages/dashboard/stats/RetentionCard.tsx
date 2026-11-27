import { StatsCard } from '@/components/charts/StatsCard';
import { useI18n } from '@/i18n/useI18n';
import { cardState, cellRate, cohortLines, cohortTable, csvName, mergeLines, useStatsRetention, type StatsRange } from '@/lib/stats';
import { CohortTable } from './CohortTable';

/** The card's name in its CSV file's name. */
const CSV = 'retention';

/** Of each day's sign-ups, the share that used the app 1, 7 and 30 days later. */
export function RetentionCard({ range, className }: { range: StatsRange; className?: string | undefined }) {
  const { t } = useI18n();
  const query = useStatsRetention(range);
  const lines = cohortLines(query.data?.cohorts ?? [], (c) => [c.d1, c.d7, c.d30]).filter((line) => line.signups > 0);
  const shown = cohortTable(lines);
  const average = mergeLines('', lines);
  const measures = [1, 7, 30].map((n) => t('stats.retention.day', { n }));
  const title = t('stats.retention.title');
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
      <CohortTable caption={title} measures={measures} lines={shown} average={average} weekly={lines.length > 31} />
    </StatsCard>
  );
}
