import type { AdminPurchaseDetail, AdminPurchaseEvent, AdminPurchaseHistory } from '@app/shared';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n/useI18n';
import { auditActionLabel } from '@/lib/audit';
import { formatDate, formatDateTime } from '@/lib/format';
import { historyActionLabel, usePurchaseEvents } from '@/lib/purchases';
import { formatMoney } from '@/lib/stats';
import { cn } from '@/lib/utils';
import { SectionCard } from '../users/SectionCard';

/**
 * A purchase's store events, newest first (the page's first 50, older ones
 * on demand), and the admins' actions on it with their notes and the
 * store's refusals.
 */
export function PurchaseTimeline({ purchase }: { purchase: AdminPurchaseDetail }) {
  const { t } = useI18n();
  const [opened, setOpened] = useState(false);
  const older = usePurchaseEvents(purchase.id, purchase.events.nextCursor, opened);
  const events = [...purchase.events.items, ...(older.data?.pages.flatMap((page) => page.items) ?? [])];
  const more = opened ? older.hasNextPage : purchase.events.nextCursor !== null;
  return (
    <SectionCard title={t('purchase.section.timeline')}>
      {events.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('purchase.timeline.empty')}</p>
      ) : (
        <ol className="-my-2 divide-y">
          {events.map((event) => (
            <EventRow key={event.id} event={event} />
          ))}
        </ol>
      )}
      {(more || older.isFetching) && (
        <div className="text-center">
          <Button variant="outline" size="sm" disabled={older.isFetching} onClick={() => (opened ? void older.fetchNextPage() : setOpened(true))}>
            {t('purchase.timeline.older')}
          </Button>
        </div>
      )}
    </SectionCard>
  );
}

function EventRow({ event }: { event: AdminPurchaseEvent }) {
  const { t, locale, dir } = useI18n();
  const To = dir === 'rtl' ? ArrowLeft : ArrowRight;
  const refund = event.event === 'revoked';
  return (
    <li className="grid gap-1.5 py-2.5 text-sm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={cn('font-medium', refund && 'text-red-700 dark:text-red-300')}>{t(`storeEvent.${event.event}`)}</span>
        <Badge variant={event.source === 'admin' ? 'secondary' : 'outline'}>{t(`storeEventSource.${event.source}`)}</Badge>
        <span className="ms-auto text-xs whitespace-nowrap text-muted-foreground">{formatDateTime(event.at, locale)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          {event.stateFrom && event.stateFrom !== event.stateTo && (
            <>
              <span>{t(`purchaseState.${event.stateFrom}`)}</span>
              <To className="size-3" aria-label={t('purchase.timeline.to')} />
            </>
          )}
          <span className="text-foreground">{t(`purchaseState.${event.stateTo}`)}</span>
        </span>
        {event.amount && (
          <span className={cn('tabular-nums', refund && 'text-red-700 dark:text-red-300')}>
            {event.amount.estimated && (
              <abbr title={t('purchase.amount.estimated')} className="me-0.5 no-underline">
                ≈<span className="sr-only">{t('purchase.amount.estimated')}</span>
              </abbr>
            )}
            <bdi>{formatMoney(event.amount.micros, event.amount.currency, locale)}</bdi>
          </span>
        )}
        {event.expiresAt && <span>{t('purchase.timeline.until', { date: formatDate(event.expiresAt, locale) })}</span>}
        {event.orderId && (
          <span dir="ltr" className="max-w-56 truncate font-mono" title={event.orderId}>
            {event.orderId}
          </span>
        )}
      </div>
    </li>
  );
}

export function PurchaseHistory({ history }: { history: readonly AdminPurchaseHistory[] }) {
  const { t } = useI18n();
  return (
    <SectionCard title={t('purchase.section.history')}>
      {history.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('purchase.history.empty')}</p>
      ) : (
        <ol className="-my-2 divide-y">
          {history.map((row) => (
            <HistoryRow key={row.id} row={row} />
          ))}
        </ol>
      )}
    </SectionCard>
  );
}

/** A note longer than this shows its first lines until opened. */
const NOTE_FOLD = 160;

function HistoryRow({ row }: { row: AdminPurchaseHistory }) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const long = (row.note?.length ?? 0) > NOTE_FOLD;
  const failed = row.failed === 'refund_prorated' ? 'refund' : row.failed;
  return (
    <li className="grid gap-1.5 py-2.5 text-sm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium">{auditActionLabel(row.action, t)}</span>
        {row.error && (
          <Badge variant="destructive">
            {t(row.error === 'refused' ? 'purchase.history.refused' : 'purchase.history.unavailable')}
            {failed && <span className="font-normal">· {t(historyActionLabel[failed])}</span>}
          </Badge>
        )}
        <span className="ms-auto text-xs whitespace-nowrap text-muted-foreground">{formatDateTime(row.at, locale)}</span>
      </div>
      <bdi className="text-xs text-muted-foreground">{row.admin?.displayName ?? t('audit.system')}</bdi>
      {row.note && (
        <div className="grid justify-items-start gap-1">
          <p dir="auto" className={cn('w-full rounded-md bg-muted px-3 py-2 break-words whitespace-pre-wrap', long && !open && 'line-clamp-3')}>
            {row.note}
          </p>
          {long && (
            <Button variant="link" size="sm" className="h-auto p-0 text-xs" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? t('purchase.note.less') : t('purchase.note.more')}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
