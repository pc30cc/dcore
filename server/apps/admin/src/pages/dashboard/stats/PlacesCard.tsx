import type { AdminStatsPlaces } from '@app/shared';
import { useState } from 'react';
import { StackBar } from '@/components/charts/HBars';
import { StatsCard } from '@/components/charts/StatsCard';
import { ChartLegend } from '@/components/charts/TimeChart';
import { Segmented } from '@/components/ui/segmented';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useI18n } from '@/i18n/useI18n';
import { factsOf, formatNumber, regionName } from '@/lib/format';
import { cardState, formatRatio, formatStatsDay, placeKinds, placesCsvName, useStatsPlaces, type PlaceKind } from '@/lib/stats';
import { cn } from '@/lib/utils';

const SHOWN = 20;
const GENDERS = ['women', 'men', 'nonBinary'] as const;
const SLOT = { women: 1, men: 2, nonBinary: 3 } as const;

type Counts = Pick<AdminStatsPlaces['other'], 'women' | 'men' | 'nonBinary' | 'total'>;

/** Women per man of a row, only from two published cells (never from a withheld one). */
function womenToMen(counts: Counts): number | null {
  return counts.women !== null && counts.men !== null && counts.men > 0 ? counts.women / counts.men : null;
}

/** Places past those shown added to Other, cell by cell; a withheld Other cell stays withheld. */
function restOf(other: Counts, places: readonly Counts[]): Counts {
  const sum: Counts = { ...other };
  for (const place of places) {
    for (const g of GENDERS) {
      const value = place[g];
      const current = sum[g];
      if (value === null || current === null) continue;
      sum[g] = current + value;
      sum.total += value;
    }
  }
  return sum;
}

/**
 * Profiles in the deck active in the last 7 days, by city or country and
 * gender (the newest rolled-up day). Small groups are never shown: a place
 * under 10 is in Other, and a withheld cell (under 5, or one that would
 * let a smaller group be worked out) reads "Hidden"; so does an Other cell
 * the server withheld. The women to men ratio comes from published cells
 * only.
 */
export function PlacesCard({ className }: { className?: string | undefined }) {
  const { t, locale } = useI18n();
  const [kind, setKind] = useState<PlaceKind>('city');
  const query = useStatsPlaces(kind);
  const data = query.data;
  // While another kind loads, the shown rows keep their own kind's words.
  const shownKind = data?.kind ?? kind;
  const empty = !data?.day || (data.places.length === 0 && data.other.total === 0);
  const places = (data?.places ?? []).slice(0, SHOWN);
  const name = (place: AdminStatsPlaces['places'][number]) =>
    shownKind === 'country' ? regionName(place.code, locale) : (place.names?.[locale] ?? t('stats.places.city', { code: place.code }));
  const genderLabel = { women: t('stats.places.women'), men: t('stats.places.men'), nonBinary: t('stats.places.nonBinary') };
  const small = t('stats.places.small');
  const cell = (value: number | null) => (value === null ? small : formatNumber(value, locale));
  const ratioText = (counts: Counts) => {
    const value = womenToMen(counts);
    return value === null ? '—' : formatRatio(value, locale);
  };
  const rest = data ? restOf(data.other, data.places.slice(SHOWN)) : null;
  const title = t('stats.places.title');
  return (
    <StatsCard
      title={title}
      className={className}
      meta={data?.day ? <span>{t('stats.places.meta', { day: formatStatsDay(data.day, locale) })}</span> : undefined}
      actions={
        <Segmented
          label={t('stats.places.by')}
          value={kind}
          options={placeKinds}
          text={(option) => (option === 'city' ? t('stats.places.cities') : t('stats.places.countries'))}
          onChange={setKind}
        />
      }
      state={cardState(query)}
      empty={empty}
      file={data?.day ? placesCsvName(shownKind, data.day) : undefined}
      tableOnly
      table={
        data
          ? {
              columns: [
                { label: t('stats.places.col.place'), kind: 'text' },
                { label: t('stats.places.col.code'), kind: 'text' },
                ...GENDERS.map((g) => ({ label: genderLabel[g], kind: 'count' as const })),
                { label: t('stats.places.ratio'), kind: 'ratio' },
                { label: t('stats.places.total'), kind: 'count' },
              ],
              rows: [
                ...data.places.map((p) => [name(p), p.code, ...GENDERS.map((g) => p[g] ?? small), womenToMen(p), p.total]),
                [t('stats.places.other'), '', ...GENDERS.map((g) => data.other[g] ?? small), womenToMen(data.other), data.other.total],
              ],
            }
          : undefined
      }
    >
      {data && rest && (
        <>
          <ChartLegend series={GENDERS.map((g) => ({ key: g, label: genderLabel[g], slot: SLOT[g] }))} bars />
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <caption className="sr-only">{title}</caption>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="normal-case">{shownKind === 'city' ? t('stats.places.city.col') : t('stats.places.country.col')}</TableHead>
                  {GENDERS.map((g) => (
                    <TableHead key={g} className="hidden text-end normal-case sm:table-cell">
                      {genderLabel[g]}
                    </TableHead>
                  ))}
                  <TableHead className="hidden text-end normal-case sm:table-cell">{t('stats.places.ratio')}</TableHead>
                  <TableHead className="text-end normal-case">{t('stats.places.total')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...places.map((p) => ({ key: p.code, label: name(p), sub: shownKind === 'city' ? regionName(p.country, locale) : null, counts: p })), { key: 'other', label: t('stats.places.other'), sub: null, counts: rest }].map(
                  (row) => (
                    <TableRow key={row.key} className={cn(row.key === 'other' && 'text-muted-foreground')}>
                      <TableCell className="py-2">
                        <div className="grid min-w-0 gap-1.5">
                          <span className="flex min-w-0 items-baseline gap-2">
                            <span className="truncate font-medium text-foreground">{row.label}</span>
                            {row.sub && <span className="truncate text-xs text-muted-foreground">{row.sub}</span>}
                          </span>
                          <StackBar className="max-w-64" parts={GENDERS.map((g) => ({ key: g, value: row.counts[g], slot: SLOT[g] }))} />
                          <span className="text-xs text-muted-foreground sm:hidden">
                            {factsOf(
                              [...GENDERS.map((g) => t('stats.places.cell', { gender: genderLabel[g], count: cell(row.counts[g]) })), t('stats.places.cell', { gender: t('stats.places.ratio'), count: ratioText(row.counts) })],
                              locale,
                            )}
                          </span>
                        </div>
                      </TableCell>
                      {GENDERS.map((g) => (
                        <TableCell key={g} className="hidden py-2 text-end tabular-nums sm:table-cell">
                          {cell(row.counts[g])}
                        </TableCell>
                      ))}
                      <TableCell className="hidden py-2 text-end tabular-nums sm:table-cell">{ratioText(row.counts)}</TableCell>
                      <TableCell className="py-2 text-end font-medium tabular-nums">{formatNumber(row.counts.total, locale)}</TableCell>
                    </TableRow>
                  ),
                )}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </StatsCard>
  );
}
