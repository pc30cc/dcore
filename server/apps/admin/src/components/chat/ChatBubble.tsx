import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import type { MessageKey } from '@/i18n/messages';
import { useI18n } from '@/i18n/useI18n';
import { formatDateTime, formatTime } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * One message of a chat as the panel draws it (a report's evidence, a
 * person's conversations): a list item on its sender's side, a header line
 * (who, badges, kind, flags), an optional quote, the body and its time.
 * The body takes its own direction (`dir="auto"`); the item never wraps
 * past 85% of the column. Facts on one line (a time, a note) are apart by
 * spacing, not by a middle dot, which reads as a Persian zero next to digits.
 */

const toneClass = {
  end: 'rounded-ee-sm bg-primary/10 text-foreground dark:bg-primary/25',
  start: 'rounded-es-sm bg-muted',
  dashed: 'rounded-es-sm border border-dashed',
} as const;

export function ChatBubble({
  side,
  tone,
  label,
  kind,
  flags = [],
  badges,
  ring = false,
  quote,
  at,
  timeOnly = false,
  note,
  children,
}: {
  side: 'start' | 'end';
  tone: keyof typeof toneClass;
  /** Who sent it: a role word or a name. */
  label: ReactNode;
  /** A messageKind name (or 'request'); none or 'text' shows no kind badge. */
  kind?: string | undefined;
  /** messageFlag names. */
  flags?: readonly string[] | undefined;
  /** Badges after the label, before the kind. */
  badges?: ReactNode | undefined;
  /** An outline that marks the message (a report's named message). */
  ring?: boolean | undefined;
  /** Shown above the body (the message a reply answers). */
  quote?: ReactNode | undefined;
  at: string;
  /** The time alone (the list shows the day elsewhere). */
  timeOnly?: boolean | undefined;
  /** After the time, e.g. "copied late". */
  note?: string | undefined;
  /** The body; nothing when null or undefined. */
  children?: ReactNode | undefined;
}) {
  const { t, locale } = useI18n();
  return (
    <li className={cn('flex', side === 'end' ? 'justify-end' : 'justify-start')}>
      <div className={cn('grid max-w-[85%] min-w-0 gap-1 rounded-2xl px-3 py-2 text-sm', toneClass[tone], ring && 'ring-2 ring-amber-500/70 dark:ring-amber-400/60')}>
        <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-medium">{label}</span>
          {badges}
          {kind !== undefined && kind !== 'text' && <Badge variant="outline">{t(`messageKind.${kind}` as MessageKey)}</Badge>}
          {flags.map((flag) => (
            <Badge key={flag} variant={flag === 'risky' ? 'warning' : 'outline'}>
              {t(`messageFlag.${flag}` as MessageKey)}
            </Badge>
          ))}
        </span>
        {quote}
        {children !== null && children !== undefined && (
          <p dir="auto" className="break-words whitespace-pre-wrap">
            {children}
          </p>
        )}
        <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          <time dateTime={at}>{timeOnly ? formatTime(at, locale) : formatDateTime(at, locale)}</time>
          {note && <span>{note}</span>}
        </span>
      </div>
    </li>
  );
}

/** A chat event without a bubble (a call, a reaction, an unsend): one muted line in the middle of the column. */
export function ChatLine({ icon: Icon, at, timeOnly = false, note, children }: { icon: LucideIcon; at: string; timeOnly?: boolean | undefined; note?: string | undefined; children: ReactNode }) {
  const { locale } = useI18n();
  return (
    <li className="flex justify-center">
      <span className="inline-flex max-w-[85%] min-w-0 flex-wrap items-center justify-center gap-x-2 gap-y-0.5 rounded-2xl bg-muted/60 px-3 py-1 text-center text-xs text-muted-foreground">
        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
        {children}
        <time dateTime={at} className="whitespace-nowrap">
          {timeOnly ? formatTime(at, locale) : formatDateTime(at, locale)}
        </time>
        {note && <span>{note}</span>}
      </span>
    </li>
  );
}
