import { useId, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useI18n } from '@/i18n/useI18n';
import { axisTicks, bucketDays, formatDayCount, formatStatsDay, formatStatsSpan } from '@/lib/stats';
import { cn } from '@/lib/utils';
import { slotColor, type ChartSlot } from './slots';
import { useWidth } from './useWidth';

export interface ChartSeries {
  key: string;
  label: string;
  slot: ChartSlot;
  /** One value per day; null: not known (a gap). */
  values: readonly (number | null)[];
}

type Mark = 'line' | 'bar';

const TOP = 10;
/** SVG text and line settings (kept out of JSX attributes, which hold only words or codes). */
const TICK = { dy: '0.32em', textAnchor: 'end' } as const;
const CRISP = { shapeRendering: 'crispEdges' } as const;
const ROUND = { strokeLinejoin: 'round', strokeLinecap: 'round' } as const;

function anchorOf(index: number, count: number, mark: Mark): 'start' | 'middle' | 'end' {
  if (mark === 'bar' || count < 2) return 'middle';
  return index === 0 ? 'start' : index === count - 1 ? 'end' : 'middle';
}

/** An axis day: day and month, or month and year when the chart spans more than about four months. */
const axisDay = (day: string, locale: Parameters<typeof formatStatsDay>[1], long: boolean) => formatStatsDay(day, locale, long ? 'month' : 'short');
const LONG_SPAN_MS = 120 * 86_400_000;
const AXIS = 24;
const GAP = 2;
const MAX_BAR = 24;
/** A column narrower than this reads as a hairline: the days are summed into weeks instead. */
const MIN_BAR = 4;
const WEEK = 7;
/** A range longer than this has its summable columns in weeks at any width. */
const LONG_RANGE_DAYS = 92;
/** A short (oldest) group's columns: lighter, so it never reads as a drop. */
const PARTIAL_OPACITY = 0.4;

/** Columns of `count` series in a band of `band` px: each column's width. */
const barWidth = (band: number, count: number) => Math.min(MAX_BAR, (band - GAP * 2 - GAP * (count - 1)) / Math.max(1, count));

/**
 * How many days each column of summable values holds: 1 while a day's
 * column is at least MIN_BAR wide on a range of up to LONG_RANGE_DAYS, else
 * the fewest whole weeks that keep every column at MIN_BAR or wider.
 */
function groupDays(dayCount: number, width: number, seriesCount: number): number {
  if (dayCount <= WEEK) return 1;
  const plot = Math.max(40, width - 60);
  const fits = (size: number) => barWidth(plot / Math.ceil(dayCount / size), seriesCount) >= MIN_BAR;
  if (dayCount <= LONG_RANGE_DAYS && fits(1)) return 1;
  let size = WEEK;
  while (size < dayCount && !fits(size)) size += WEEK;
  // Past the whole range: one column of every day (whole, not a short group).
  return Math.min(size, dayCount);
}

/** SVG text in the page's direction inside the left-to-right chart («۶ آبان» stays «۶ آبان»). */
const isolated = (text: string, dir: 'ltr' | 'rtl') => (dir === 'rtl' ? `\u2067${text}\u2069` : text);

function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/**
 * Values by day on one axis from 0: lines (2 px, an end dot) or columns
 * (24 px at most, 4 px rounded tops, 2 px apart). Time runs left to right
 * in every language; the labels read in the page's direction. A pointer or
 * the arrow keys pick a day: a hairline, and a readout of every series that
 * day, also spoken (a polite live region). The same figures are in the
 * card's table, so nothing here is the only way to read a value. Columns of
 * summable values (`weeks`) are summed into whole weeks counted back from
 * the last day on a long range or where a day would be too thin: the newest
 * column always holds a full group; a shorter oldest one is drawn lighter
 * and its readout names its days.
 */
export function TimeChart({
  days: dayList,
  series: seriesList,
  label,
  bars = false,
  formatValue,
  formatTick = formatValue,
  weeks = false,
  whole = false,
  height = 200,
  className,
}: {
  days: readonly string[];
  series: readonly ChartSeries[];
  /** The accessible name (the card's title and range). */
  label: string;
  /** Columns instead of lines. */
  bars?: boolean;
  formatValue: (value: number) => string;
  /** An axis label (default: as a value). */
  formatTick?: (value: number) => string;
  /** Columns of values that add up (counts, money): their days may be summed into weeks. */
  weeks?: boolean;
  /** Counts: the axis steps by whole numbers. */
  whole?: boolean;
  height?: number;
  className?: string | undefined;
}) {
  const { locale, dir } = useI18n();
  const mark: Mark = bars ? 'bar' : 'line';
  const [ref, width] = useWidth<HTMLDivElement>(320);
  const [active, setActive] = useState<number | null>(null);
  const tipId = useId();

  // A long range, or a narrow chart of many days: whole weeks back from the last day, so no column falls under MIN_BAR.
  const size = bars && weeks ? groupDays(dayList.length, width, seriesList.length) : 1;
  const grouped = size > 1 ? bucketDays(dayList, seriesList.map((s) => s.values), size) : null;
  const days = grouped?.days ?? dayList;
  const series = grouped ? seriesList.map((s, i) => ({ ...s, values: grouped.series[i]! })) : seriesList;
  const partial = (i: number) => grouped !== null && grouped.spans[i]!.days < size;
  const dayText = (i: number) => {
    const span = grouped?.spans[i];
    if (!span) return formatStatsDay(days[i]!, locale);
    const text = formatStatsSpan(span.from, span.to, locale);
    return span.days < size ? `${text} (${formatDayCount(span.days, locale)})` : text;
  };

  const known = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const { ticks, texts: tickTexts } = axisTicks(Math.max(0, ...known), formatTick, whole);
  const top = Math.max(1e-9, ticks.at(-1) ?? 1);
  const start = Math.max(28, Math.max(...tickTexts.map((text) => text.length)) * 6.5 + 10);
  const end = mark === 'line' ? 8 : 2;
  const plotW = Math.max(40, width - start - end);
  const plotH = Math.max(40, height - TOP - AXIS);
  const n = days.length;
  const band = n > 0 ? plotW / n : plotW;
  const xAt = (i: number) => (mark === 'bar' ? start + band * (i + 0.5) : n <= 1 ? start + plotW / 2 : start + (i * plotW) / (n - 1));
  const yAt = (value: number) => TOP + plotH - (value / top) * plotH;
  const indexAt = (x: number) => {
    if (n === 0) return null;
    const i = mark === 'bar' ? Math.floor((x - start) / band) : Math.round(((x - start) / plotW) * (n - 1));
    return Math.min(n - 1, Math.max(0, i));
  };

  function onPointerMove(event: PointerEvent<SVGRectElement>) {
    const box = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (!box) return;
    setActive(indexAt(event.clientX - box.left));
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (n === 0) return;
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (event.key === 'Home') setActive(0);
    else if (event.key === 'End') setActive(n - 1);
    else if (step !== 0) setActive((current) => Math.min(n - 1, Math.max(0, (current ?? (step > 0 ? -1 : n)) + step)));
    else if (event.key === 'Escape') setActive(null);
    else return;
    event.preventDefault();
  }

  const labelIndexes = n === 0 ? [] : [...new Set([0, Math.floor((n - 1) / 2), n - 1])];
  const long = n > 1 && Date.parse(days[n - 1]!) - Date.parse(days[0]!) > LONG_SPAN_MS;
  const barCount = series.length;
  const barW = Math.max(1, barWidth(band, barCount));

  const tipX = active === null ? 0 : Math.min(width - 90, Math.max(90, xAt(active)));
  const activeDay = active === null ? null : dayText(active);
  const spoken =
    active === null
      ? ''
      : [
          activeDay,
          ...series.map((s) => {
            const value = s.values[active];
            return `${s.label} ${value === null || value === undefined ? '—' : formatValue(value)}`;
          }),
        ].join(
          locale === 'fa' ? '، ' : ', ',
        );

  return (
    <>
    <div
      ref={ref}
      dir="ltr"
      className={cn('relative w-full min-w-0 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50', className)}
      role="img"
      aria-label={label}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onBlur={() => setActive(null)}
      aria-describedby={active === null ? undefined : tipId}
    >
      <svg width={width} height={height} className="block overflow-visible" aria-hidden="true">
        {ticks.map((tick, i) => (
          <g key={tick}>
            <line x1={start} x2={start + plotW} y1={yAt(tick)} y2={yAt(tick)} style={{ stroke: 'var(--border)', ...CRISP }} strokeWidth={1} />
            <text x={start - 8} y={yAt(tick)} {...TICK} className="fill-muted-foreground text-[11px] tabular-nums">
              {isolated(tickTexts[i]!, dir)}
            </text>
          </g>
        ))}
        {labelIndexes.map((i, k) => (
          <text
            key={i}
            x={xAt(i)}
            y={TOP + plotH + 16}
            textAnchor={anchorOf(k, labelIndexes.length, mark)}
            className="fill-muted-foreground text-[11px]"
          >
            {isolated(axisDay(days[i]!, locale, long), dir)}
          </text>
        ))}
        {active !== null && mark === 'bar' && <rect x={start + band * active} y={TOP} width={band} height={plotH} className="fill-muted" opacity={0.6} />}
        {mark === 'bar'
          ? series.map((s, k) =>
              s.values.map((value, i) => {
                if (value === null || value <= 0) return null;
                const x = xAt(i) - (barCount * barW + GAP * (barCount - 1)) / 2 + k * (barW + GAP);
                const y = yAt(value);
                return (
                  <path
                    key={`${s.key}-${i}`}
                    d={barPath(x, y, barW, TOP + plotH - y)}
                    fillOpacity={partial(i) ? PARTIAL_OPACITY : undefined}
                    style={{ fill: slotColor(s.slot) }}
                  />
                );
              }),
            )
          : series.map((s) => {
              const runs: [number, number][][] = [];
              let run: [number, number][] = [];
              s.values.forEach((value, i) => {
                if (value === null) {
                  if (run.length) runs.push(run);
                  run = [];
                } else run.push([xAt(i), yAt(value)]);
              });
              if (run.length) runs.push(run);
              const lastIndex = s.values.findLastIndex((v) => v !== null);
              return (
                <g key={s.key} style={{ stroke: slotColor(s.slot), fill: slotColor(s.slot) }}>
                  {runs.map((points, r) =>
                    points.length === 1 ? (
                      <circle key={r} cx={points[0]![0]} cy={points[0]![1]} r={3} strokeWidth={0} />
                    ) : (
                      <path key={r} d={`M${points.map(([x, y]) => `${x},${y}`).join('L')}`} fill="none" strokeWidth={2} style={ROUND} />
                    ),
                  )}
                  {lastIndex >= 0 && active === null && <circle cx={xAt(lastIndex)} cy={yAt(s.values[lastIndex]!)} r={4} strokeWidth={2} style={{ stroke: 'var(--card)' }} />}
                </g>
              );
            })}
        {active !== null && mark === 'line' && (
          <g>
            <line x1={xAt(active)} x2={xAt(active)} y1={TOP} y2={TOP + plotH} style={{ stroke: 'var(--muted-foreground)' }} strokeOpacity={0.6} strokeWidth={1} />
            {series.map((s) => {
              const value = s.values[active];
              return value === null || value === undefined ? null : (
                <circle key={s.key} cx={xAt(active)} cy={yAt(value)} r={4} strokeWidth={2} style={{ fill: slotColor(s.slot), stroke: 'var(--card)' }} />
              );
            })}
          </g>
        )}
        <rect
          x={start}
          y={TOP}
          width={plotW}
          height={plotH + AXIS}
          fill="transparent"
          onPointerMove={onPointerMove}
          onPointerDown={onPointerMove}
          onPointerLeave={() => setActive(null)}
        />
      </svg>
      {active !== null && (
        <div
          id={tipId}
          dir={dir}
          className="pointer-events-none absolute top-0 z-10 min-w-36 -translate-x-1/2 rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
          style={{ left: tipX }}
        >
          <div className="mb-1 text-muted-foreground">{activeDay}</div>
          {series.map((s) => {
            const value = s.values[active];
            return (
              <div key={s.key} className="flex items-center gap-2">
                <span className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: slotColor(s.slot) }} aria-hidden="true" />
                <span className="font-semibold tabular-nums">{value === null || value === undefined ? '—' : formatValue(value)}</span>
                <span className="text-muted-foreground">{s.label}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
    <div className="sr-only" aria-live="polite" aria-atomic="true">
      {spoken}
    </div>
    </>
  );
}

/** Which colour is which series: a line key for lines, a square for columns. */
export function ChartLegend({ series, bars = false }: { series: readonly Pick<ChartSeries, 'key' | 'label' | 'slot'>[]; bars?: boolean }) {
  if (series.length < 2) return null;
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span className={cn('shrink-0', bars ? 'size-2.5 rounded-sm' : 'h-0.5 w-3.5 rounded-full')} style={{ background: slotColor(s.slot) }} aria-hidden="true" />
          {s.label}
        </li>
      ))}
    </ul>
  );
}
