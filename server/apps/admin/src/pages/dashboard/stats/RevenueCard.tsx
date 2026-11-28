import type { AdminStatsRevenue } from '@app/shared';
import { useState } from 'react';
import { Figures, StatsCard, StatsTableView } from '@/components/charts/StatsCard';
import { ChartLegend, TimeChart, type ChartSeries } from '@/components/charts/TimeChart';
import { Badge } from '@/components/ui/badge';
import { NativeSelect } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { hasMessage, type Translate } from '@/i18n/translate';
import { useI18n } from '@/i18n/useI18n';
import { factsOf, formatNumber, regionName } from '@/lib/format';
import {
  addMicros,
  cardState,
  csvName,
  currencyName,
  daysOf,
  formatCount,
  formatMoney,
  formatPercent,
  formatStatsDay,
  formatUnitsShort,
  formatUnitsTick,
  monthlyChurn,
  subMicros,
  unitsOf,
  useStatsRevenue,
  type StatsRange,
  type StatsTable,
} from '@/lib/stats';

/** The card's name in its CSV file's name. */
const CSV = 'revenue';

/**
 * Store revenue of the range in one currency (never converted; the one
 * with the most payments first): payments, refunds, new subscriptions,
 * monthly recurring revenue, active subscriptions, churn and renewals
 * turned off, by day, store, product and country. Cafe Bazaar reports list
 * prices: such amounts are estimates. Only with `dashboard.revenue`.
 */
export function RevenueCard({ range, className }: { range: StatsRange; className?: string | undefined }) {
  const { t, locale } = useI18n();
  const [picked, setPicked] = useState<string | null>(null);
  const query = useStatsRevenue(range, picked, true);
  const data = query.data;
  const currency = data?.currency ?? null;
  const empty = !data || currency === null;
  const title = t('stats.revenue.title');

  return (
    <StatsCard
      title={title}
      className={className}
      meta={data?.estimated ? <Badge variant="muted">{t('stats.revenue.estimated')}</Badge> : undefined}
      actions={
        data && data.currencies.length > 1 && currency ? (
          <div className="w-48">
            <NativeSelect aria-label={t('stats.revenue.currency')} value={currency} onChange={(event) => setPicked(event.target.value)}>
              {data.currencies.map((c) => (
                <option key={c.currency} value={c.currency}>
                  {currencyName(c.currency, locale)}
                </option>
              ))}
            </NativeSelect>
          </div>
        ) : undefined
      }
      state={cardState(query)}
      empty={empty}
      file={csvName(CSV, range, currency)}
      table={data && currency ? dayTable(data, currency, range, t) : undefined}
    >
      {data && currency && <Revenue data={data} currency={currency} range={range} />}
    </StatsCard>
  );
}

/** Every day of the range: what the charts and figures show (payments, refunds, MRR, subscriptions, ends, renewals turned off). */
function dayTable(data: AdminStatsRevenue, currency: string, range: StatsRange, t: Translate): StatsTable {
  const byDay = new Map(data.days.map((d) => [d.day, d]));
  const mrr = new Map(data.mrr.map((m) => [m.day, m.micros]));
  const subs = new Map(data.subscriptions.map((s) => [s.day, s]));
  const churn = new Map(data.churn.map((c) => [c.day, c]));
  return {
    columns: [
      { label: t('stats.col.day'), kind: 'day' },
      { label: t('stats.revenue.gross'), kind: 'money', currency },
      { label: t('stats.revenue.refunds'), kind: 'money', currency },
      { label: t('stats.revenue.payments'), kind: 'count' },
      { label: t('stats.revenue.refundCount'), kind: 'count' },
      { label: t('stats.revenue.newSubs'), kind: 'count' },
      { label: t('stats.revenue.mrr'), kind: 'money', currency },
      { label: t('stats.revenue.subscriptions'), kind: 'count' },
      { label: t('stats.revenue.renewing'), kind: 'count' },
      { label: t('stats.revenue.ended'), kind: 'count' },
      { label: t('stats.revenue.cancelled'), kind: 'count' },
    ],
    rows: daysOf(range)
      .filter((day) => byDay.has(day) || mrr.has(day) || subs.has(day) || churn.has(day))
      .map((day) => {
        const d = byDay.get(day);
        return [
          day,
          d?.grossMicros ?? null,
          d?.refundMicros ?? null,
          d?.payments ?? null,
          d?.refunds ?? null,
          d?.newSubs ?? null,
          mrr.get(day) ?? null,
          subs.get(day)?.active ?? null,
          subs.get(day)?.renewing ?? null,
          churn.get(day)?.ended ?? null,
          churn.get(day)?.cancelled ?? null,
        ];
      }),
  };
}

function Revenue({ data, currency, range }: { data: AdminStatsRevenue; currency: string; range: StatsRange }) {
  const { t, locale } = useI18n();
  const money = (micros: string) => formatMoney(micros, currency, locale);
  const gross = addMicros(...data.days.map((d) => d.grossMicros));
  const refunds = addMicros(...data.days.map((d) => d.refundMicros));
  const payments = data.days.reduce((sum, d) => sum + d.payments, 0);
  const newSubs = data.days.reduce((sum, d) => sum + d.newSubs, 0);
  const mrr = data.mrr.at(-1);
  const subs = data.subscriptions.at(-1);
  const { ended, rate: churn } = monthlyChurn(data);
  const cancelled = data.churn.reduce((sum, c) => sum + c.cancelled, 0);

  const days = daysOf(range);
  const byDay = new Map(data.days.map((d) => [d.day, d]));
  const barSeries: ChartSeries[] = [
    { key: 'gross', label: t('stats.revenue.gross'), slot: 1, values: days.map((day) => (byDay.has(day) ? unitsOf(byDay.get(day)!.grossMicros) : null)) },
    { key: 'refunds', label: t('stats.revenue.refunds'), slot: 2, values: days.map((day) => (byDay.has(day) ? unitsOf(byDay.get(day)!.refundMicros) : null)) },
  ];
  const mrrByDay = new Map(data.mrr.map((m) => [m.day, unitsOf(m.micros)]));
  const subsByDay = new Map(data.subscriptions.map((s) => [s.day, s]));
  const mrrSeries: ChartSeries[] = [{ key: 'mrr', label: t('stats.revenue.mrr'), slot: 1, values: days.map((day) => mrrByDay.get(day) ?? null) }];
  const subsSeries: ChartSeries[] = [
    { key: 'active', label: t('stats.revenue.subscriptions'), slot: 1, values: days.map((day) => subsByDay.get(day)?.active ?? null) },
    { key: 'renewing', label: t('stats.revenue.renewing'), slot: 2, values: days.map((day) => subsByDay.get(day)?.renewing ?? null) },
  ];
  const chartLabel = (title: string) => t('stats.chart.label', { title, from: formatStatsDay(range.from, locale), to: formatStatsDay(range.to, locale) });
  const units = (value: number) => formatUnitsShort(value, currency, locale);
  const unitsTick = (value: number) => formatUnitsTick(value, currency, locale);
  const period = (code: string | undefined) => {
    if (!code) return null;
    const key = `period.${code}`;
    return hasMessage(key) ? t(key) : code;
  };

  return (
    <>
      <Figures
        items={[
          { key: 'gross', label: t('stats.revenue.gross'), value: money(gross), sub: t('stats.revenue.paymentsCount', { count: formatNumber(payments, locale) }) },
          { key: 'refunds', label: t('stats.revenue.refunds'), value: money(refunds) },
          { key: 'net', label: t('stats.revenue.net'), value: money(subMicros(gross, refunds)) },
          { key: 'newSubs', label: t('stats.revenue.newSubs'), value: formatNumber(newSubs, locale) },
          { key: 'mrr', label: t('stats.revenue.mrr'), value: mrr ? money(mrr.micros) : null },
          { key: 'subs', label: t('stats.revenue.subscriptions'), value: subs ? formatNumber(subs.active, locale) : null, sub: subs ? t('stats.revenue.renewingCount', { count: formatNumber(subs.renewing, locale) }) : undefined },
          { key: 'churn', label: t('stats.revenue.churn'), value: churn === null ? null : formatPercent(churn, locale), sub: t('stats.revenue.endedCount', { count: formatNumber(ended, locale) }) },
          { key: 'cancelled', label: t('stats.revenue.cancelled'), value: formatNumber(cancelled, locale) },
        ]}
      />
      <div className="grid min-w-0 grid-cols-1 gap-2">
        <ChartLegend series={barSeries} bars />
        <TimeChart bars weeks days={days} series={barSeries} label={chartLabel(t('stats.revenue.title'))} formatValue={units} formatTick={unitsTick} />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="grid min-w-0 content-start gap-2">
          <h3 className="text-sm font-medium">{t('stats.revenue.mrr')}</h3>
          <TimeChart days={days} series={mrrSeries} label={chartLabel(t('stats.revenue.mrr'))} formatValue={units} formatTick={unitsTick} height={160} />
        </div>
        <div className="grid min-w-0 content-start gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium">{t('stats.revenue.subscriptions')}</h3>
            <ChartLegend series={subsSeries} />
          </div>
          <TimeChart days={days} series={subsSeries} label={chartLabel(t('stats.revenue.subscriptions'))} formatValue={(v) => formatCount(v, locale)} whole height={160} />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Breakdown
          title={t('stats.revenue.byStore')}
          table={{
            columns: [
              { label: t('stats.revenue.col.store'), kind: 'text' },
              { label: t('stats.revenue.gross'), kind: 'money', currency },
              { label: t('stats.revenue.refunds'), kind: 'money', currency, narrow: 'sm' },
            ],
            rows: data.byStore.map((s) => [t(`store.${s.store}`), s.grossMicros, s.refundMicros]),
          }}
        />
        <Breakdown
          title={t('stats.revenue.byCountry')}
          table={{
            columns: [
              { label: t('stats.revenue.col.country'), kind: 'text' },
              { label: t('stats.revenue.gross'), kind: 'money', currency },
              { label: t('stats.revenue.payments'), kind: 'count', narrow: 'sm' },
            ],
            rows: data.byCountry.map((c) => [c.region === 'ZZ' ? t('stats.revenue.unknownCountry') : regionName(c.region, locale), c.grossMicros, c.payments]),
          }}
        />
        <Breakdown
          title={t('stats.revenue.byProduct')}
          className="lg:col-span-2"
          table={{
            columns: [
              { label: t('stats.revenue.col.product'), kind: 'text' },
              { label: t('stats.revenue.col.plan'), kind: 'text', narrow: 'sm' },
              { label: t('stats.revenue.col.store'), kind: 'text', narrow: 'sm' },
              { label: t('stats.revenue.gross'), kind: 'money', currency },
              { label: t('stats.revenue.payments'), kind: 'count', narrow: 'sm' },
            ],
            rows: data.byProduct.map((p) => [
              p.productId === '?' ? t('stats.revenue.unknownProduct') : p.productId,
              factsOf([p.plan, period(p.period)].filter((x): x is string => Boolean(x)), locale, true) || null,
              t(`store.${p.store}`),
              p.grossMicros,
              p.payments,
            ]),
          }}
        />
      </div>
    </>
  );
}

function Breakdown({ title, table, className }: { title: string; table: Parameters<typeof StatsTableView>[0]['table']; className?: string | undefined }) {
  return (
    <div className={cn('grid min-w-0 content-start gap-2', className)}>
      <h3 className="text-sm font-medium">{title}</h3>
      <StatsTableView table={table} caption={title} className="max-h-72" />
    </div>
  );
}
