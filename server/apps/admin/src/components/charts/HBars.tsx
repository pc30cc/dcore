import { cn } from '@/lib/utils';
import { slotColor, type ChartSlot } from './slots';

/**
 * Ranked or ordered rows as horizontal bars from the reading start (right
 * in Persian): the name, the bar (its share of `max`), and the figure. On a
 * phone the name and the figure share a line above the bar.
 */
export function HBars({ rows, max, slot = 1 }: { rows: readonly { key: string; label: string; value: number; text: string }[]; max: number; slot?: ChartSlot }) {
  return (
    <ul className="grid gap-2.5">
      {rows.map((row) => (
        <li key={row.key} className="grid gap-1 text-sm sm:grid-cols-[minmax(7rem,11rem)_1fr_minmax(7rem,auto)] sm:items-center sm:gap-3">
          <div className="flex min-w-0 items-baseline justify-between gap-2">
            <span className="truncate">{row.label}</span>
            <span className="text-xs text-muted-foreground tabular-nums sm:hidden">{row.text}</span>
          </div>
          <div className="h-2.5 rounded-full bg-muted" aria-hidden="true">
            <div className="h-full rounded-full" style={{ width: `${max > 0 ? Math.max(row.value > 0 ? 1 : 0, (row.value / max) * 100) : 0}%`, background: slotColor(slot) }} />
          </div>
          <span className="hidden text-end text-xs text-muted-foreground tabular-nums sm:block">{row.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** One whole in parts (a thin bar, 2 px between parts); a part without a value draws nothing. */
export function StackBar({ parts, className }: { parts: readonly { key: string; value: number | null; slot: ChartSlot }[]; className?: string | undefined }) {
  const total = parts.reduce((sum, part) => sum + (part.value ?? 0), 0);
  return (
    <div className={cn('flex h-2 w-full gap-[2px] overflow-hidden rounded-full', total === 0 && 'bg-muted', className)} aria-hidden="true">
      {total > 0 &&
        parts.map((part) =>
          part.value ? <div key={part.key} className="h-full first:rounded-s-full last:rounded-e-full" style={{ flex: `${part.value} 1 0`, background: slotColor(part.slot) }} /> : null,
        )}
    </div>
  );
}
