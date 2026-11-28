import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/**
 * A table in its own box, which scrolls it sideways when it is wider.
 * `containerClassName` styles that box: a capped height there (with
 * `overflow-auto`) makes it the one box that scrolls both ways, so a
 * `sticky` header stays at its top.
 */
export function Table({ className, containerClassName, ...props }: ComponentProps<'table'> & { containerClassName?: string | undefined }) {
  return (
    <div data-slot="table-container" className={cn('relative w-full overflow-x-auto', containerClassName)}>
      <table data-slot="table" className={cn('w-full caption-bottom text-sm', className)} {...props} />
    </div>
  );
}

export function TableHeader({ className, ...props }: ComponentProps<'thead'>) {
  return <thead data-slot="table-header" className={cn('bg-muted/50 [&_tr]:border-b', className)} {...props} />;
}

export function TableBody({ className, ...props }: ComponentProps<'tbody'>) {
  return <tbody data-slot="table-body" className={cn('[&_tr:last-child]:border-0', className)} {...props} />;
}

export function TableRow({ className, ...props }: ComponentProps<'tr'>) {
  return <tr data-slot="table-row" className={cn('border-b transition-colors hover:bg-muted/40 data-[state=selected]:bg-muted', className)} {...props} />;
}

export function TableHead({ className, ...props }: ComponentProps<'th'>) {
  return (
    <th
      data-slot="table-head"
      className={cn('h-10 px-3 text-start align-middle text-xs font-medium tracking-wide whitespace-nowrap text-muted-foreground uppercase first:ps-4 last:pe-4', className)}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: ComponentProps<'td'>) {
  return <td data-slot="table-cell" className={cn('px-3 py-3 align-middle first:ps-4 last:pe-4', className)} {...props} />;
}
