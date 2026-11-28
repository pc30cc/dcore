import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { LoadError, TableSkeleton } from '@/components/QueryState';
import type { ShownName } from '@/lib/system';
import { cn } from '@/lib/utils';

/** A card of the jobs page: its title, an action beside it, and its body. */
export function SystemCard({ title, action, children, className }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('grid min-w-0 content-start gap-4 rounded-xl border bg-card p-4 text-card-foreground shadow-xs sm:p-5', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * A card's own read: grey rows while it loads, the error with a retry when
 * it has nothing to show, else its body (a failed poll keeps the last
 * answer, the page's header says so).
 */
export function CardQuery<T>({ query, rows = 3, children }: { query: UseQueryResult<T>; rows?: number; children: (data: T) => ReactNode }) {
  if (query.data !== undefined) return <>{children(query.data)}</>;
  if (query.isError) return <LoadError error={query.error} onRetry={() => void query.refetch()} />;
  return (
    <div className="-m-4">
      <TableSkeleton rows={rows} />
    </div>
  );
}

/** A name as shown: words, or a code in mono read left to right. */
export function Shown({ value, className }: { value: ShownName; className?: string }) {
  if (!value.mono) return <span className={className}>{value.name}</span>;
  return (
    <span dir="ltr" className={cn('font-mono text-xs', className)}>
      {value.name}
    </span>
  );
}

/** A process's or a code's name, read left to right, cut with its whole value on hover. */
export function Code({ children, className }: { children: string; className?: string }) {
  return (
    <span dir="ltr" title={children} className={cn('min-w-0 truncate font-mono text-xs', className)}>
      {children}
    </span>
  );
}

/** A label and its value, in a definition list. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

/** A table row's header cell (a code attribute, kept out of the JSX). */
export const ROW = 'row';
/** A table's column header (a code attribute, kept out of the JSX). */
export const COL = 'col';
