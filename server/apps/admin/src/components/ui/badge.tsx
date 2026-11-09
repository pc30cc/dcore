import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

// eslint-disable-next-line react-refresh/only-export-components
export const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap [&>svg]:pointer-events-none [&>svg]:size-3',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        outline: 'text-foreground',
        success: 'border-transparent bg-emerald-100 text-emerald-900 dark:bg-emerald-500/15 dark:text-emerald-200',
        warning: 'border-transparent bg-amber-100 text-amber-950 dark:bg-amber-500/15 dark:text-amber-200',
        destructive: 'border-transparent bg-red-100 text-red-900 dark:bg-red-500/15 dark:text-red-200',
        muted: 'border-transparent bg-muted text-muted-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export function Badge({ className, variant, asChild = false, ...props }: ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'span';
  return <Comp data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

/** A coloured dot and a word: the state of a row. */
export function StatusDot({ tone, children, className }: { tone: 'green' | 'amber' | 'red' | 'gray' | 'blue'; children: ReactNode; className?: string }) {
  const dot = {
    green: 'bg-emerald-500',
    amber: 'bg-amber-500',
    red: 'bg-red-500',
    gray: 'bg-muted-foreground/50',
    blue: 'bg-sky-500',
  }[tone];
  return (
    <span className={cn('inline-flex items-center gap-2 text-sm whitespace-nowrap', className)}>
      <span className={cn('size-2 shrink-0 rounded-full', dot)} aria-hidden="true" />
      {children}
    </span>
  );
}
