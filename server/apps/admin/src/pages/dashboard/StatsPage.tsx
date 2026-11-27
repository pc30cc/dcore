import { ChartLine } from 'lucide-react';
import { useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadError } from '@/components/QueryState';
import { Segmented } from '@/components/ui/segmented';
import { useI18n } from '@/i18n/useI18n';
import { formatNumber } from '@/lib/format';
import { can } from '@/lib/session';
import { ACTIVE_METRICS, DEFAULT_RANGE, formatStatsDay, rangeDaysOf, statsRange, statsRanges, useStatsPageFailure, useStatsSeries } from '@/lib/stats';
import { cn } from '@/lib/utils';
import { useSession } from '@/lib/useSession';
import { ActiveCard } from './stats/ActiveCard';
import { ConversionCard } from './stats/ConversionCard';
import { EngagementCard } from './stats/EngagementCard';
import { FunnelCard } from './stats/FunnelCard';
import { ModerationCard } from './stats/ModerationCard';
import { PlacesCard } from './stats/PlacesCard';
import { ProvidersCard } from './stats/ProvidersCard';
import { RetentionCard } from './stats/RetentionCard';
import { RevenueCard } from './stats/RevenueCard';

/**
 * `/stats`: closed UTC days, from the nightly roll-up. The range (7, 30, 90
 * or 365 days to yesterday) is in the address (`?days=`) and scopes every
 * card but the places (the newest day's last 7 days). Money cards only with
 * `dashboard.revenue`; without it their reads are never sent. When every
 * read fails, one notice with one retry replaces the cards.
 */
export function StatsPage() {
  const { t, locale } = useI18n();
  const { me } = useSession();
  const [params, setParams] = useSearchParams();
  const days = rangeDaysOf(params.get('days'));
  const range = useMemo(() => statsRange(days), [days]);
  const money = can(me, 'dashboard.revenue');
  // The same read as the active card's (one request): its newest rolled-up day heads the page.
  const lastDay = useStatsSeries(ACTIVE_METRICS, range).data?.lastDay ?? null;
  // Every read failed: one notice and one retry; the cards stay mounted (hidden) so their reads stay on screen.
  const failure = useStatsPageFailure();

  return (
    <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6">
      <PageHeader
        icon={ChartLine}
        title={t('nav.stats')}
        meta={<span className="text-muted-foreground">{lastDay ? t('stats.utc', { day: formatStatsDay(lastDay, locale) }) : t('stats.utcNone')}</span>}
        actions={
          <Segmented
            label={t('stats.range')}
            value={String(days)}
            options={statsRanges.map(String)}
            text={(option) => t('stats.range.days', { n: formatNumber(Number(option), locale) })}
            onChange={(option) => setParams(Number(option) === DEFAULT_RANGE ? {} : { days: option }, { replace: true })}
            className="w-full sm:w-auto"
          />
        }
      />
      {failure && <LoadError error={failure.error} onRetry={failure.retry} />}
      <div className={cn('grid grid-cols-1 gap-4 lg:grid-cols-2', failure && 'hidden')}>
        <ActiveCard range={range} className="lg:col-span-2" />
        <EngagementCard range={range} className="lg:col-span-2" />
        <FunnelCard range={range} />
        <RetentionCard range={range} />
        <PlacesCard className="lg:col-span-2" />
        {money && <RevenueCard range={range} className="lg:col-span-2" />}
        {money && <ConversionCard range={range} />}
        <ProvidersCard range={range} className={money ? undefined : 'lg:col-span-2'} />
        <ModerationCard range={range} className="lg:col-span-2" />
      </div>
    </div>
  );
}
