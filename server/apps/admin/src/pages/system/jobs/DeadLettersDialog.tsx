import { SYSTEM_DEAD_LETTER_DELETE_MAX, type AdminDeadLetter, type AdminDeadLetterDelete, type StreamName } from '@app/shared';
import { Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { LoadError, TableSkeleton } from '@/components/QueryState';
import { ConfirmDialog } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useI18n } from '@/i18n/useI18n';
import { formatDateTime, formatNumber, joinFacts } from '@/lib/format';
import { asApiError } from '@/lib/http';
import { problemText } from '@/lib/problemText';
import { queryClient } from '@/lib/queries';
import { deadLetterKindText, deleteDeadLetters, systemKeys, useDeadLetters } from '@/lib/system';
import { showToast } from '@/lib/toast';

/** Entries one delete takes at most (the server's bound): ticking stops there. */
const SELECT_MAX = SYSTEM_DEAD_LETTER_DELETE_MAX;

/**
 * A saving queue's failed entries, newest first: when each failed and was
 * sent, why, how often it was tried and its kind (never who, to whom or
 * where). With `system.write`: delete the ticked ones (500 at most), or all
 * of them (every entry up to the newest loaded; entries failing since stay).
 * The title and the actions stay in view while the list scrolls.
 */
export function DeadLettersDialog({ stream, dead, canWrite, onClose }: { stream: StreamName; dead: number; canWrite: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const pages = useDeadLetters(stream, true);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirm, setConfirm] = useState<AdminDeadLetterDelete | null>(null);
  const [busy, setBusy] = useState(false);
  const items = pages.data?.pages.flatMap((page) => page.items) ?? [];
  const name = t(`dashboard.stream.${stream}`);
  const selectable = items.slice(0, SELECT_MAX);
  const allShown = selectable.length > 0 && selected.size >= selectable.length && selectable.every((item) => selected.has(item.id));
  const full = selected.size >= SELECT_MAX;
  // "Delete all" names the count: read it again with the list.
  useEffect(() => void queryClient.invalidateQueries({ queryKey: systemKeys.streams }), []);

  function toggle(id: string, on: boolean) {
    setSelected((held) => {
      const next = new Set(held);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function remove(body: AdminDeadLetterDelete) {
    setBusy(true);
    try {
      const result = await deleteDeadLetters(body);
      if (result.sideEffects === 'failed') showToast((t) => t('jobs.dead.deleteFailed'), 'error', 6_000);
      else showToast((t) => t('jobs.dead.deleted', { count: result.deleted }), 'success');
      setSelected(new Set());
      setConfirm(null);
      await Promise.all([queryClient.resetQueries({ queryKey: systemKeys.deadLetters(stream) }), queryClient.invalidateQueries({ queryKey: systemKeys.streams })]);
    } catch (error) {
      const failure = asApiError(error);
      setConfirm(null);
      showToast((t, lang) => problemText(failure, t, lang), 'error', 6_000);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent wide className="flex flex-col overflow-hidden pb-0 sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('jobs.dead.title', { stream: name })}</DialogTitle>
        </DialogHeader>
        <div className="-mx-6 min-h-0 flex-1 overflow-y-auto border-t px-6">
        {pages.isPending ? (
          <TableSkeleton rows={4} />
        ) : pages.isError && items.length === 0 ? (
          <LoadError error={pages.error} onRetry={() => void pages.refetch()} />
        ) : items.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('jobs.dead.empty')}</p>
        ) : (
          <div className="-mx-6 grid gap-3">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  {canWrite && (
                    <TableHead className="w-10">
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        checked={allShown}
                        aria-label={t('jobs.dead.selectAll')}
                        onChange={(event) => setSelected(event.target.checked ? new Set(selectable.map((item) => item.id)) : new Set())}
                      />
                    </TableHead>
                  )}
                  <TableHead>{t('jobs.dead.col.at')}</TableHead>
                  <TableHead className="hidden sm:table-cell">{t('jobs.dead.col.entryAt')}</TableHead>
                  <TableHead className="hidden sm:table-cell">{t('jobs.dead.col.reason')}</TableHead>
                  <TableHead className="hidden text-end sm:table-cell">{t('jobs.dead.col.tries')}</TableHead>
                  <TableHead className="hidden sm:table-cell">{t('jobs.dead.col.kind')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => {
                  const checked = selected.has(item.id);
                  return <EntryRow key={item.id} item={item} canWrite={canWrite} checked={checked} disabled={full && !checked} onToggle={(on) => toggle(item.id, on)} />;
                })}
              </TableBody>
            </Table>
            {pages.isFetchNextPageError && (
              <div className="px-6">
                <LoadError error={pages.error} onRetry={() => void pages.fetchNextPage()} />
              </div>
            )}
            {pages.hasNextPage && !pages.isFetchNextPageError && (
              <div className="flex justify-center px-6 pb-3">
                <Button variant="outline" size="sm" disabled={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
                  {t('common.loadMore')}
                </Button>
              </div>
            )}
          </div>
        )}
        </div>
        {canWrite && items.length > 0 ? (
          <div className="-mx-6 flex flex-col-reverse gap-2 border-t bg-background px-6 py-4 sm:flex-row sm:justify-end">
            <Button variant="destructive" disabled={busy} onClick={() => setConfirm({ stream, upTo: items[0]!.id })}>
              <Trash2 aria-hidden="true" />
              {t('jobs.dead.deleteAll')}
            </Button>
            <Button variant="destructive" disabled={busy || selected.size === 0} onClick={() => setConfirm({ stream, ids: [...selected] })}>
              <Trash2 aria-hidden="true" />
              {t('jobs.dead.delete', { count: selected.size })}
            </Button>
          </div>
        ) : (
          <div className="pb-1" />
        )}
        <ConfirmDialog
          open={confirm !== null}
          onOpenChange={(open) => !open && !busy && setConfirm(null)}
          title={
            confirm && 'ids' in confirm ? t('jobs.dead.confirm.title', { count: confirm.ids.length }) : t('jobs.dead.confirm.all', { count: Math.max(dead, items.length), stream: name })
          }
          description={t('jobs.dead.confirm.body')}
          confirmLabel={t('jobs.dead.confirm.action')}
          destructive
          busy={busy}
          onConfirm={() => confirm && void remove(confirm)}
        />
      </DialogContent>
    </Dialog>
  );
}

function EntryRow({ item, canWrite, checked, disabled, onToggle }: { item: AdminDeadLetter; canWrite: boolean; checked: boolean; disabled: boolean; onToggle: (on: boolean) => void }) {
  const { t, locale } = useI18n();
  const at = formatDateTime(item.at, locale);
  const reason = t(`jobs.dead.reason.${item.reason}`);
  const kind = deadLetterKindText(item, t);
  return (
    <TableRow data-state={checked ? 'selected' : undefined}>
      {canWrite && (
        <TableCell>
          <input
            type="checkbox"
            className="size-4 accent-primary disabled:opacity-50"
            checked={checked}
            disabled={disabled}
            aria-label={t('jobs.dead.select', { time: at })}
            onChange={(event) => onToggle(event.target.checked)}
          />
        </TableCell>
      )}
      <TableCell>
        <span className="grid gap-0.5">
          <span className="text-sm whitespace-nowrap">{at}</span>
          {/* On a phone the other facts sit here (their columns are hidden). */}
          <span className="text-xs text-muted-foreground sm:hidden">
            {joinFacts([reason, kind, `${t('jobs.dead.col.tries')} ${formatNumber(item.deliveries, locale)}`], locale)}
          </span>
        </span>
      </TableCell>
      <TableCell className="hidden text-sm whitespace-nowrap text-muted-foreground sm:table-cell">{item.entryAt ? formatDateTime(item.entryAt, locale) : t('common.none')}</TableCell>
      <TableCell className="hidden text-sm sm:table-cell">{reason}</TableCell>
      <TableCell className="hidden text-end text-sm tabular-nums sm:table-cell">{formatNumber(item.deliveries, locale)}</TableCell>
      <TableCell className="hidden text-sm sm:table-cell">{kind}</TableCell>
    </TableRow>
  );
}
