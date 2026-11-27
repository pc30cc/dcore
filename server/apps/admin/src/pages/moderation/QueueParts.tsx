import { RotateCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n/useI18n';
import { cn } from '@/lib/utils';

/** The pieces the moderation pages share: a key's cap, the refresh button, the empty line, the position read aloud. */

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  const { t } = useI18n();
  // Keys by position: on a Persian layout A and R type ش and ق; the tooltip says so.
  return (
    <kbd dir="ltr" aria-hidden="true" title={t('queue.keys.hint')} className={cn('rounded border border-current/30 px-1 font-sans text-xs leading-4 font-normal opacity-80', className)}>
      {children}
    </kbd>
  );
}

export function RefreshButton({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  const { t } = useI18n();
  return (
    <Button variant="ghost" size="icon" onClick={onClick} disabled={busy} aria-label={t('queue.refresh')} title={t('queue.refresh')}>
      <RotateCw className={cn(busy && 'animate-spin')} aria-hidden="true" />
    </Button>
  );
}

/** Nothing to list: one muted line, the same on every moderation page (inside a card where the page has none of its own). */
export function EmptyLine({ text }: { text: string }) {
  return <p className="px-4 py-8 text-center text-sm text-muted-foreground">{text}</p>;
}

export function EmptyQueue({ text }: { text?: string }) {
  const { t } = useI18n();
  return (
    <section className="rounded-xl border bg-card text-card-foreground shadow-xs">
      <EmptyLine text={text ?? t('queue.empty')} />
    </section>
  );
}

/** The position for the eye, in the page header (the live region below says it to a screen reader). */
export function QueueProgress({ text }: { text: string }) {
  return (
    <span className="text-sm text-muted-foreground tabular-nums" aria-hidden="true">
      {text}
    </span>
  );
}

/** The position, read when the focus moves (a polite live region); after a decision, what was done comes first. */
export function QueuePosition({ text, done }: { text: string; done?: string | null | undefined }) {
  return (
    <p className="sr-only" aria-live="polite" aria-atomic="true">
      {done ? `${done} ${text}` : text}
    </p>
  );
}
