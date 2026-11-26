import * as TabsPrimitive from '@radix-ui/react-tabs';
import { useRef, type ComponentProps, type ReactNode } from 'react';
import { useI18n } from '@/i18n/useI18n';
import { useSelectedInView } from '@/lib/useSelectedInView';
import { cn } from '@/lib/utils';

export function Tabs({ className, ...props }: ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn('flex flex-col gap-4', className)} {...props} />;
}

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn('inline-flex h-10 w-fit items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground', className)}
      {...props}
    />
  );
}

/**
 * A tab list that may be wider than its column: scrolls sideways (edge to
 * edge below the breakpoint the page undoes in className) and keeps the
 * selected tab in view.
 */
export function TabsScroller({ value, className, children }: { value: string; className?: string; children: ReactNode }) {
  const { locale } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  useSelectedInView(ref, value, locale);
  return (
    <div ref={ref} data-slot="tabs-scroller" className={cn('-mx-4 overflow-x-auto px-4', className)}>
      {children}
    </div>
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        'inline-flex h-full flex-1 items-center justify-center gap-2 rounded-md border border-transparent px-3 text-sm font-medium whitespace-nowrap transition-[color,box-shadow] outline-none',
        'hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50',
        'data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm dark:data-[state=active]:border-input dark:data-[state=active]:bg-input/30',
        '[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*="size-"])]:size-4',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn('flex-1 outline-none', className)} {...props} />;
}
