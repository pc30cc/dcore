import { Download, Table2 } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { LoadError } from '@/components/QueryState';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useI18n } from '@/i18n/useI18n';
import { csvBlob } from '@/lib/csv';
import { saveBlob } from '@/lib/download';
import { statsCellText, statsCsvRows, type CardState, type StatsColumn, type StatsTable } from '@/lib/stats';
import { cn } from '@/lib/utils';

/**
 * A card of the statistics: its title and facts, its own controls, then
 * the chart. While nothing has answered: a grey block; a read that failed
 * with nothing to show: why, and a retry; nothing recorded: one line. With
 * a table, "Show table" puts the chart's figures in an accessible table
 * and "Download CSV" saves them (built here, from what is shown). A card
 * that is a table already can still give its chart a table of its own
 * (`chartTable`, with its own CSV once shown).
 */
export function StatsCard({
  title,
  meta,
  actions,
  state,
  empty,
  table,
  file,
  tableOnly = false,
  chartTable,
  className,
  children,
}: {
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
  state: CardState;
  /** Nothing to show (no day rolled up, or nothing happened). */
  empty: boolean;
  table?: StatsTable | undefined;
  /** The CSV file's name. */
  file?: string | undefined;
  /** The content is already a table: only the CSV is offered. */
  tableOnly?: boolean;
  /** The chart's own figures for "Show table" (a card whose `table` is already on screen). */
  chartTable?: { table: StatsTable; file?: string | undefined } | undefined;
  className?: string | undefined;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const [showTable, setShowTable] = useState(false);
  const tableId = useId();
  const ready = !state.pending && !state.error && !empty;
  const shown = chartTable?.table ?? (tableOnly ? undefined : table);
  const download = (what: StatsTable, name: string) => saveBlob(csvBlob(what.columns.map((c) => c.label), statsCsvRows(what)), name);

  return (
    <section className={cn('grid min-w-0 grid-cols-1 content-start gap-4 rounded-xl border bg-card p-4 text-card-foreground shadow-xs sm:p-5', className)} aria-busy={state.pending || state.refreshing}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="grid min-w-0 gap-1">
          <h2 className="text-base font-semibold">{title}</h2>
          {meta && <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">{meta}</div>}
        </div>
        {(actions ?? (ready && (table ?? shown))) && (
          <div className="flex flex-wrap items-center gap-2">
            {actions}
            {ready && shown && (
              <Button variant="ghost" size="sm" aria-expanded={showTable} aria-controls={tableId} onClick={() => setShowTable(!showTable)}>
                <Table2 aria-hidden="true" />
                {showTable ? t('stats.table.hide') : t('stats.table.show')}
              </Button>
            )}
            {ready && table && file && (
              <Button variant="ghost" size="sm" onClick={() => download(table, file)}>
                <Download aria-hidden="true" />
                {t('stats.csv')}
              </Button>
            )}
          </div>
        )}
      </div>
      {state.pending ? (
        <div aria-hidden="true" className="grid gap-3">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : state.error ? (
        <LoadError error={state.error} onRetry={state.retry} />
      ) : empty ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{t('stats.empty')}</p>
      ) : (
        <div className={cn('grid min-w-0 grid-cols-1 gap-4 transition-opacity', state.refreshing && 'opacity-60')}>
          {children}
          {showTable && shown && (
            <div id={tableId} className="grid gap-2">
              {chartTable?.file && (
                <div className="flex justify-end">
                  <Button variant="ghost" size="sm" onClick={() => download(chartTable.table, chartTable.file!)}>
                    <Download aria-hidden="true" />
                    {t('stats.csv')}
                  </Button>
                </div>
              )}
              <StatsTableView table={shown} caption={title} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** A figure that may wrap between an amount and its currency (Intl joins them with a no-break space). */
const breakable = (text: string) => text.replace(/\u00a0/g, ' ');

const NARROW_HIDDEN = { sm: 'hidden sm:table-cell', md: 'hidden md:table-cell' } as const;
const NARROW_SHOWN = { sm: 'sm:hidden', md: 'md:hidden' } as const;

/**
 * A card's figures as a table: numbers at the end of their cells, in the
 * panel's digits. A column marked `narrow` leaves the table below that width
 * and is shown instead as a muted line under the first cell (each fact kept
 * whole), so a phone sees the key figures without scrolling.
 */
export function StatsTableView({ table, caption, className }: { table: StatsTable; caption: string; className?: string | undefined }) {
  const { locale } = useI18n();
  const numeric = (column: StatsColumn) => column.kind !== 'day' && column.kind !== 'text';
  const tucked = table.columns.map((column, i) => ({ column, i })).filter(({ column, i }) => i > 0 && column.narrow);
  return (
    <div className={cn('max-h-96 overflow-auto rounded-lg border', className)}>
      <Table>
        <caption className="sr-only">{caption}</caption>
        <TableHeader className="sticky top-0 z-[1] bg-card">
          <TableRow className="hover:bg-transparent">
            {table.columns.map((column, i) => (
              <TableHead key={i} className={cn('bg-muted/50 normal-case', numeric(column) && 'text-end', i > 0 && column.narrow && NARROW_HIDDEN[column.narrow])}>
                {column.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {table.rows.map((row, r) => (
            <TableRow key={r}>
              {row.map((value, i) => {
                const column = table.columns[i]!;
                const text = statsCellText(value, column, locale);
                if (i === 0 && tucked.length > 0) {
                  return (
                    <TableCell key={i} className="py-2 whitespace-normal">
                      <span className="block break-words">{text}</span>
                      {tucked.map(({ column: extra, i: j }) => (
                        <span key={j} className={cn('block text-xs break-words text-muted-foreground', NARROW_SHOWN[extra.narrow!])}>
                          {extra.label} {breakable(statsCellText(row[j] ?? null, extra, locale))}
                        </span>
                      ))}
                    </TableCell>
                  );
                }
                // An amount may wrap between its currency and its digits, never inside the digits.
                const money = column.kind === 'money';
                return (
                  <TableCell
                    key={i}
                    className={cn('py-2', money ? 'whitespace-normal' : 'whitespace-nowrap', numeric(column) && 'text-end tabular-nums', i > 0 && column.narrow && NARROW_HIDDEN[column.narrow])}
                  >
                    {money ? breakable(text) : text}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** A figure with its name above and an optional line below; a dash when it is not known. */
export function StatTile({ label, value, sub, tone, className }: { label: string; value: string | null; sub?: ReactNode; tone?: 'muted'; className?: string | undefined }) {
  return (
    <div className={cn('grid min-w-0 content-start gap-1 rounded-xl border bg-card p-4 text-card-foreground shadow-xs', className)}>
      <div className="truncate text-sm text-muted-foreground">{label}</div>
      <div className={cn('truncate text-2xl font-semibold tracking-tight sm:text-3xl', (value === null || tone === 'muted') && 'text-muted-foreground')}>{value ?? '—'}</div>
      {sub && <div className="min-w-0 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

/**
 * A row of figures inside a card (label above, value below, each at its own
 * height). A value is never cut: a long amount wraps at its spaces (and,
 * only if it must, inside), so its most significant digits always show.
 * `fit`: as many columns of at least 9rem as the card holds (a half-width
 * card).
 */
export function Figures({ items, fit = false }: { items: readonly { key: string; label: string; value: string | null; sub?: ReactNode }[]; fit?: boolean }) {
  return (
    <dl className={cn('grid gap-x-4 gap-y-3', fit ? 'grid-cols-[repeat(auto-fit,minmax(9rem,1fr))]' : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4')}>
      {items.map((item) => (
        <div key={item.key} className="grid min-w-0 content-start gap-0.5">
          <dt className="text-xs break-words text-muted-foreground">{item.label}</dt>
          <dd className={cn('min-w-0 text-base font-semibold [overflow-wrap:anywhere] sm:text-lg', item.value === null && 'text-muted-foreground')}>
            {item.value === null ? '—' : breakable(item.value)}
          </dd>
          {item.sub && <dd className="text-xs text-muted-foreground">{item.sub}</dd>}
        </div>
      ))}
    </dl>
  );
}

/** Facts on one line that wraps only between them (each fact kept whole). */
export function FactLine({ facts }: { facts: readonly string[] }) {
  const { locale } = useI18n();
  return (
    <span className="inline-flex flex-wrap gap-x-1">
      {facts.map((fact, i) => (
        <span key={i} className="whitespace-nowrap">
          <bdi>{fact}</bdi>
          {i < facts.length - 1 && (locale === 'fa' ? '،' : ',')}
        </span>
      ))}
    </span>
  );
}
