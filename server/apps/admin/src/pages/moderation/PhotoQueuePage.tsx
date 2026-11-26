import type { AdminPhotoDecision, AdminQueuePhoto, PhotoRejectReason } from '@app/shared';
import { Check, Eye, ImageIcon, ImageOff, ShieldCheck, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import { ReasonPicker } from '@/components/moderation/ReasonPicker';
import { LoadError } from '@/components/QueryState';
import { ConfirmDialog } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { UserRef } from '@/components/UserRef';
import type { MessageKey } from '@/i18n/messages';
import { useI18n } from '@/i18n/useI18n';
import { apiRequest } from '@/lib/api';
import { formatNumber, regionName } from '@/lib/format';
import { asApiError } from '@/lib/http';
import { isSensitive, photoReasons, positionText } from '@/lib/moderation';
import { conflictText, problemText } from '@/lib/problemText';
import { dropFromPages, queryClient, queryKeys, usePhotoQueue } from '@/lib/queries';
import { useQueueKeys } from '@/lib/queueKeys';
import { can } from '@/lib/session';
import { showToast } from '@/lib/toast';
import { useSession } from '@/lib/useSession';
import { cn } from '@/lib/utils';
import { EmptyQueue, Kbd, QueuePosition, QueueProgress, RefreshButton } from './QueueParts';

const flagTone = (flag: string) => (flag === 'nudity' || flag === 'possible_minor' ? 'destructive' : 'outline');

/** Below lg the decision pane sits above the grid: a tap on a thumbnail brings it into view. */
const WIDE = '(min-width: 64rem)';

/**
 * `/moderation/photos`: photos waiting for a human, oldest first. The
 * focused one is shown large with the person; A approves it, R rejects it
 * with a reason (1-9 choose, Enter sends), J and K move. The grid is one
 * tab stop: the arrow keys move the focus and the selection together, so
 * the photo with the keyboard focus is the one A and R decide. A decided
 * photo leaves the list (said in the live region, no toast over the pane)
 * and the next one is focused; the next page is read when few are left. A
 * photo the checks labelled nudity or a possible minor is veiled until the
 * admin chooses to look.
 */
export function PhotoQueuePage() {
  const { t, locale, dir } = useI18n();
  const { me } = useSession();
  const canDecide = can(me, 'moderation.decide');
  const queue = usePhotoQueue();
  const items = useMemo(() => queue.data?.pages.flatMap((page) => page.items) ?? [], [queue.data]);
  const [focus, setFocus] = useState(0);
  const [rejecting, setRejecting] = useState<AdminQueuePhoto | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set());
  const index = Math.min(focus, Math.max(0, items.length - 1));
  const current = items[index];
  const thumbs = useRef<(HTMLButtonElement | null)[]>([]);
  const grid = useRef<HTMLUListElement>(null);
  const pane = useRef<HTMLElement>(null);
  /** The keyboard focus was on a thumbnail that left: it goes to the one now selected. */
  const refocus = useRef(false);
  const hidden = (photo: AdminQueuePhoto) => isSensitive(photo.modFlags) && !revealed.has(photo.id);

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = queue;
  const position = (n: number) => positionText(t, t('queue.kind.photo'), n, items.length, hasNextPage);
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && items.length - index <= 5) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, items.length, index]);

  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    thumbs.current[index]?.focus();
  }, [items, index]);

  /** Selects the photo at `to`; the keyboard focus follows when it is in the grid. */
  function select(to: number) {
    const next = Math.max(0, Math.min(to, items.length - 1));
    setFocus(next);
    setDone(null);
    if (grid.current?.contains(document.activeElement)) thumbs.current[next]?.focus();
  }

  function onGridKey(event: KeyboardEvent<HTMLUListElement>) {
    const columns = Math.max(1, getComputedStyle(event.currentTarget).gridTemplateColumns.split(' ').filter(Boolean).length);
    const forward = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
    const back = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
    const moves: Record<string, number> = { [forward]: index + 1, [back]: index - 1, ArrowDown: index + columns, ArrowUp: index - columns, Home: 0, End: items.length - 1 };
    const to = moves[event.key];
    if (to === undefined) return;
    event.preventDefault();
    select(to);
  }

  function tap(i: number) {
    select(i);
    if (!window.matchMedia?.(WIDE).matches) pane.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }

  function leave(photo: AdminQueuePhoto) {
    refocus.current = grid.current?.contains(document.activeElement) === true;
    dropFromPages<AdminQueuePhoto>(queryKeys.photoQueue, (item) => item.id !== photo.id);
    // The person's page shows the photo as decided on its next read.
    void queryClient.invalidateQueries({ queryKey: ['user', photo.user.id] });
  }

  async function decide(photo: AdminQueuePhoto, rejectWith: PhotoRejectReason | null) {
    if (busy) return;
    setBusy(true);
    try {
      const path = `/v1/admin/moderation/photos/${photo.id}/${rejectWith ? 'reject' : 'approve'}`;
      // `from`: decided by someone else since this queue was read is a 409 that keeps their decision.
      const result = await apiRequest<AdminPhotoDecision>(path, { method: 'POST', body: rejectWith ? { reason: rejectWith, from: 'review' } : { from: 'review' } });
      leave(photo);
      setRejecting(null);
      // The photo leaving the list and the live region are the answer: a toast would cover the pane's buttons.
      setDone(t(rejectWith ? 'photos.rejected' : 'photos.approved'));
      if (result.sideEffects === 'failed') showToast(t('common.sideEffectsLate'), 'info', 6_000);
    } catch (error) {
      const failure = asApiError(error);
      const conflict = conflictText(failure, t);
      if (conflict || failure.code === 'not_found') {
        // Decided elsewhere, still processing or gone: it is not this queue's any more.
        showToast(conflict ?? t('queue.alreadyDecided'), 'error', 6_000);
        leave(photo);
        setRejecting(null);
      } else {
        showToast(problemText(failure, t), 'error', 6_000);
      }
    } finally {
      setBusy(false);
    }
  }

  function openReject(photo: AdminQueuePhoto) {
    setReason('');
    setRejecting(photo);
  }

  /** A veiled photo is never approved unseen: the first approve shows it, the next one decides. */
  function approveOrReveal(photo: AdminQueuePhoto) {
    if (hidden(photo)) setRevealed((set) => new Set(set).add(photo.id));
    else void decide(photo, null);
  }

  useQueueKeys({
    enabled: current !== undefined && !busy,
    onApprove: canDecide && current ? () => approveOrReveal(current) : undefined,
    onReject: canDecide && current ? () => openReject(current) : undefined,
    onNext: () => select(index + 1),
    onPrevious: () => select(index - 1),
  });

  const options = useMemo(() => photoReasons.map((name) => ({ value: name, label: t(`reason.photo.${name}` as MessageKey) })), [t]);

  return (
    <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6">
      <PageHeader
        icon={ImageIcon}
        title={t('photos.title')}
        meta={current ? <QueueProgress text={position(index + 1)} /> : undefined}
        actions={<RefreshButton onClick={() => void queue.refetch()} busy={queue.isFetching} />}
      />
      {current && <QueuePosition text={position(index + 1)} done={done} />}
      {queue.isPending ? (
        <QueueSkeleton />
      ) : queue.isError && items.length === 0 ? (
        <LoadError error={queue.error} onRetry={() => void queue.refetch()} />
      ) : !current ? (
        <>
          {done && <QueuePosition text="" done={done} />}
          <EmptyQueue />
        </>
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
          <div className="grid gap-4">
            <ul ref={grid} className="grid grid-cols-3 gap-3 sm:grid-cols-4" aria-label={t('photos.title')} onKeyDown={onGridKey}>
              {items.map((photo, i) => (
                <li key={photo.id}>
                  <button
                    ref={(node) => {
                      thumbs.current[i] = node;
                    }}
                    type="button"
                    tabIndex={i === index ? 0 : -1}
                    onClick={() => tap(i)}
                    onFocus={() => i !== index && setFocus(i)}
                    aria-current={i === index ? 'true' : undefined}
                    aria-label={[photo.user.name ?? photo.user.id, position(i + 1), ...photo.modFlags.map((flag) => t(`modFlag.${flag}` as MessageKey))].join(' · ')}
                    className={cn(
                      'relative block aspect-[4/5] w-full overflow-hidden rounded-lg border bg-muted outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                      i === index && 'ring-2 ring-primary ring-offset-2 ring-offset-background',
                    )}
                  >
                    {photo.thumbUrl ? (
                      <img src={photo.thumbUrl} alt="" loading="lazy" className={cn('size-full object-cover', hidden(photo) && 'scale-110 blur-xl')} />
                    ) : (
                      <span className="grid size-full place-items-center text-muted-foreground" aria-hidden="true">
                        <ImageOff className="size-6" />
                      </span>
                    )}
                    {isSensitive(photo.modFlags) && <span className="absolute end-1.5 top-1.5 size-2.5 rounded-full bg-red-600 ring-2 ring-background" aria-hidden="true" />}
                  </button>
                </li>
              ))}
            </ul>
            {queue.hasNextPage && (
              <div className="text-center">
                <Button variant="outline" size="sm" onClick={() => void queue.fetchNextPage()} disabled={queue.isFetchingNextPage}>
                  {t('common.loadMore')}
                </Button>
              </div>
            )}
          </div>
          <section
            ref={pane}
            className="order-first grid scroll-mt-20 gap-4 rounded-xl border bg-card p-4 text-card-foreground shadow-xs sm:p-5 lg:sticky lg:top-20 lg:order-none"
            aria-label={t('photos.focused')}
          >
            <div className="relative grid max-h-[70vh] place-items-center overflow-hidden rounded-lg bg-muted">
              {current.url ? (
                <img src={current.url} alt="" className={cn('max-h-[70vh] w-full object-contain', hidden(current) && 'scale-110 blur-2xl')} />
              ) : (
                <span className="grid aspect-[4/5] w-full place-items-center text-muted-foreground" aria-hidden="true">
                  <ImageOff className="size-10" />
                </span>
              )}
              {current.url && hidden(current) && (
                <Button variant="secondary" className="absolute shadow-md" onClick={() => setRevealed((set) => new Set(set).add(current.id))}>
                  <Eye aria-hidden="true" />
                  {t('photos.show')}
                </Button>
              )}
            </div>
            {current.modFlags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {current.modFlags.map((flag) => (
                  <Badge key={flag} variant={flagTone(flag)}>
                    {t(`modFlag.${flag}` as MessageKey)}
                  </Badge>
                ))}
              </div>
            )}
            <div className="grid gap-2">
              <UserRef user={current.user} />
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                {current.user.age !== null && <span>{t('photos.age', { age: formatNumber(current.user.age, locale) })}</span>}
                {current.user.gender && <span>{t(`gender.${current.user.gender}` as MessageKey)}</span>}
                {current.user.country && <span>{regionName(current.user.country, locale)}</span>}
                {current.user.verified && (
                  <Badge variant="success">
                    <ShieldCheck aria-hidden="true" />
                    {t('user.badge.verified')}
                  </Badge>
                )}
              </p>
            </div>
            {current.others.length > 0 && (
              <div className="grid gap-2">
                <h2 className="text-sm font-medium">{t('photos.others')}</h2>
                <ul className="flex flex-wrap gap-2">
                  {current.others.map((other) => (
                    <li key={other.id} className="relative size-14 overflow-hidden rounded-md border bg-muted" title={t(`photoStatus.${other.status}` as MessageKey)}>
                      {other.thumbUrl ? (
                        <img src={other.thumbUrl} alt="" loading="lazy" className="size-full object-cover" />
                      ) : (
                        <span className="grid size-full place-items-center text-muted-foreground" aria-hidden="true">
                          <ImageOff className="size-4" />
                        </span>
                      )}
                      <span className="sr-only">{t(`photoStatus.${other.status}` as MessageKey)}</span>
                      <span
                        aria-hidden="true"
                        className={cn(
                          'absolute inset-x-0 bottom-0 h-1',
                          other.status === 'approved' ? 'bg-emerald-600' : other.status === 'rejected' ? 'bg-red-600' : 'bg-amber-400',
                        )}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {canDecide && (
              <div className="grid grid-cols-2 gap-2">
                <Button onClick={() => void decide(current, null)} disabled={busy || hidden(current)} aria-keyshortcuts="A">
                  <Check aria-hidden="true" />
                  {t('queue.approve')}
                  <Kbd>A</Kbd>
                </Button>
                <Button variant="outline" onClick={() => openReject(current)} disabled={busy} aria-keyshortcuts="R">
                  <X aria-hidden="true" />
                  {t('queue.reject')}
                  <Kbd>R</Kbd>
                </Button>
              </div>
            )}
          </section>
        </div>
      )}
      <ConfirmDialog
        open={rejecting !== null}
        onOpenChange={(open) => !open && !busy && setRejecting(null)}
        title={t('photos.reject.title', { name: rejecting?.user.name ?? rejecting?.user.id ?? '' })}
        description={null}
        confirmLabel={t('queue.reject')}
        destructive
        busy={busy}
        confirmDisabled={!reason}
        onConfirm={() => rejecting && reason && void decide(rejecting, reason as PhotoRejectReason)}
      >
        <ReasonPicker label={t('photos.reason')} options={options} value={reason} onChange={setReason} onConfirm={() => rejecting && reason && void decide(rejecting, reason as PhotoRejectReason)} />
      </ConfirmDialog>
    </div>
  );
}

/** The queue while it loads: tiles of the grid's shape and the pane beside them. */
function QueueSkeleton() {
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]" aria-hidden="true">
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="aspect-[4/5] w-full rounded-lg" />
        ))}
      </div>
      <Skeleton className="order-first aspect-[4/5] w-full rounded-xl lg:order-none" />
    </div>
  );
}
