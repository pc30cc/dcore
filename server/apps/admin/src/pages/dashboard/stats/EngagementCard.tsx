import type { StatsSeriesMetric } from '@app/shared';
import { Figures, StatsCard } from '@/components/charts/StatsCard';
import { ChartLegend, TimeChart, type ChartSeries } from '@/components/charts/TimeChart';
import { useI18n } from '@/i18n/useI18n';
import { cardState, csvName, daysOf, formatCount, formatPercent, formatStatsDay, ratio, seriesValues, sumOf, useStatsSeries, type StatsRange } from '@/lib/stats';

/** The card's name in its CSV file's name. */
const CSV = 'engagement';

const SOCIAL = ['likes', 'superlikes', 'passes', 'matches', 'conversations', 'replied', 'messages'] as const satisfies readonly StatsSeriesMetric[];
const CALLS = ['calls', 'calls_answered', 'call_minutes'] as const satisfies readonly StatsSeriesMetric[];

/**
 * Likes, matches, conversations, messages and calls of the range. A day's
 * conversations are those of that day's matches (a message within a week),
 * so "matches with a conversation" compares like with like.
 */
export function EngagementCard({ range, className }: { range: StatsRange; className?: string | undefined }) {
  const { t, locale } = useI18n();
  const social = useStatsSeries(SOCIAL, range);
  const calls = useStatsSeries(CALLS, range);
  const days = daysOf(range);
  const values = {
    likes: seriesValues(social.data, 'likes', days),
    superlikes: seriesValues(social.data, 'superlikes', days),
    passes: seriesValues(social.data, 'passes', days),
    matches: seriesValues(social.data, 'matches', days),
    conversations: seriesValues(social.data, 'conversations', days),
    replied: seriesValues(social.data, 'replied', days),
    messages: seriesValues(social.data, 'messages', days),
    calls: seriesValues(calls.data, 'calls', days),
    callsAnswered: seriesValues(calls.data, 'calls_answered', days),
    callMinutes: seriesValues(calls.data, 'call_minutes', days),
  };
  const total = Object.fromEntries(Object.entries(values).map(([key, v]) => [key, sumOf(v)])) as Record<keyof typeof values, number | null>;
  const empty = Object.values(total).every((v) => v === null);
  const count = (value: number | null) => (value === null ? null : formatCount(value, locale));
  const percent = (value: number | null) => (value === null ? null : formatPercent(value, locale));
  const likesAll = total.likes === null && total.superlikes === null ? null : (total.likes ?? 0) + (total.superlikes ?? 0);
  const chart: ChartSeries[] = [
    { key: 'matches', label: t('stats.metric.matches'), slot: 1, values: values.matches },
    { key: 'conversations', label: t('stats.metric.conversations'), slot: 2, values: values.conversations },
  ];
  const title = t('stats.engagement.title');
  const keys = Object.keys(values) as (keyof typeof values)[];
  return (
    <StatsCard
      title={title}
      className={className}
      state={cardState(social, calls)}
      empty={empty}
      file={csvName(CSV, range)}
      table={{
        columns: [{ label: t('stats.col.day'), kind: 'day' }, ...keys.map((key) => ({ label: t(`stats.metric.${key}`), kind: 'count' as const }))],
        rows: days.map((day, i) => [day, ...keys.map((key) => values[key][i] ?? null)]),
      }}
    >
      <Figures
        items={[
          { key: 'likes', label: t('stats.metric.likes'), value: count(total.likes), sub: t('stats.engagement.likesSub', { superlikes: count(total.superlikes) ?? '—', passes: count(total.passes) ?? '—' }) },
          { key: 'matches', label: t('stats.metric.matches'), value: count(total.matches), sub: t('stats.engagement.matchRate', { rate: percent(ratio(total.matches, likesAll)) ?? '—' }) },
          {
            key: 'conversations',
            label: t('stats.metric.conversations'),
            value: count(total.conversations),
            sub: t('stats.engagement.conversationRate', { rate: percent(ratio(total.conversations, total.matches)) ?? '—' }),
          },
          { key: 'replied', label: t('stats.metric.replied'), value: count(total.replied), sub: t('stats.engagement.repliedRate', { rate: percent(ratio(total.replied, total.conversations)) ?? '—' }) },
          { key: 'messages', label: t('stats.metric.messages'), value: count(total.messages) },
          { key: 'calls', label: t('stats.metric.calls'), value: count(total.calls), sub: t('stats.engagement.answeredRate', { rate: percent(ratio(total.callsAnswered, total.calls)) ?? '—' }) },
          { key: 'callMinutes', label: t('stats.metric.callMinutes'), value: count(total.callMinutes) },
        ]}
      />
      <ChartLegend series={chart} />
      <TimeChart
        days={days}
        series={chart}
        label={t('stats.chart.label', { title, from: formatStatsDay(range.from, locale), to: formatStatsDay(range.to, locale) })}
        formatValue={(value) => formatCount(value, locale)}
        whole
      />
    </StatsCard>
  );
}
