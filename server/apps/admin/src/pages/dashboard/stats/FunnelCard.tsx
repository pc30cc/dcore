import { HBars } from '@/components/charts/HBars';
import { Figures, StatsCard } from '@/components/charts/StatsCard';
import { useI18n } from '@/i18n/useI18n';
import { formatNumber } from '@/lib/format';
import { cardState, csvName, formatPercent, ratio, useStatsFunnel, type StatsRange } from '@/lib/stats';

/** The card's name in its CSV file's name. */
const CSV = 'signup-steps';

/** How far the sign-ups of the range got through the app's sign-up steps (each step counts everyone who reached it). */
export function FunnelCard({ range, className }: { range: StatsRange; className?: string | undefined }) {
  const { t, locale } = useI18n();
  const query = useStatsFunnel(range);
  const data = query.data;
  const started = data?.stages[0]?.reached ?? 0;
  const done = data?.stages.find((stage) => stage.stage === 'done')?.reached ?? 0;
  const empty = !data || data.signups === 0;
  const share = (n: number) => formatPercent(ratio(n, started) ?? 0, locale);
  return (
    <StatsCard
      title={t('stats.funnel.title')}
      className={className}
      state={cardState(query)}
      empty={empty}
      file={csvName(CSV, range)}
      table={
        data && {
          columns: [
            { label: t('stats.funnel.col.stage'), kind: 'text' },
            { label: t('stats.funnel.col.reached'), kind: 'count' },
            { label: t('stats.funnel.col.share'), kind: 'percent' },
          ],
          rows: data.stages.map((stage) => [t(`stats.stage.${stage.stage}`), stage.reached, ratio(stage.reached, started)]),
        }
      }
    >
      {data && (
        <>
          <Figures
            items={[
              { key: 'signups', label: t('stats.funnel.signups'), value: formatNumber(data.signups, locale) },
              { key: 'done', label: t('stats.stage.done'), value: share(done) },
              { key: 'minor', label: t('stats.funnel.minor'), value: formatNumber(data.refusedUnderAge, locale) },
            ]}
          />
          <HBars
            max={started}
            rows={data.stages.map((stage) => ({
              key: stage.stage,
              label: t(`stats.stage.${stage.stage}`),
              value: stage.reached,
              text: t('stats.funnel.row', { count: formatNumber(stage.reached, locale), share: share(stage.reached) }),
            }))}
          />
        </>
      )}
    </StatsCard>
  );
}
