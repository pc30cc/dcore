import type { AdminTextItem, SideEffects, TextState } from '@app/shared';
import { Check, Type, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import { TextDecisionDialog, type TextDecision } from '@/components/moderation/TextDecisionDialog';
import { LoadError, TableSkeleton } from '@/components/QueryState';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { UserRef } from '@/components/UserRef';
import type { MessageKey } from '@/i18n/messages';
import { useI18n } from '@/i18n/useI18n';
import { apiRequest } from '@/lib/api';
import { localized } from '@/lib/format';
import { positionText } from '@/lib/moderation';
import { asApiError } from '@/lib/http';
import { conflictText, problemText } from '@/lib/problemText';
import { dropFromPages, queryClient, queryKeys, useTextQueue } from '@/lib/queries';
import { useQueueKeys } from '@/lib/queueKeys';
import { can } from '@/lib/session';
import { showToast } from '@/lib/toast';
import { useSession } from '@/lib/useSession';
import { cn } from '@/lib/utils';
import { EmptyQueue, Kbd, QueuePosition, QueueProgress, RefreshButton } from './QueueParts';

const stateVariant: Readonly<Record<TextState, 'success' | 'warning' | 'destructive'>> = { checking: 'warning', approved: 'success', rejected: 'destructive' };

/**
 * `/moderation/texts`: people whose about, job or prompt answers wait for a
 * human, one card each. A approves every part that waits, R rejects parts
 * with a reason (the parts that wait checked first), J and K move. A
 * decided person leaves the list (said in the live region, without a toast);
 * a profile that changed in the meantime is read again.
 */
export function TextQueuePage() {
  const { t, locale } = useI18n();
  const { me } = useSession();
  const canDecide = can(me, 'moderation.decide');
  const queue = useTextQueue();
  const items = useMemo(() => queue.data?.pages.flatMap((page) => page.items) ?? [], [queue.data]);
  const [focus, setFocus] = useState(0);
  const [rejecting, setRejecting] = useState<AdminTextItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<MessageKey | null>(null);
  const index = Math.min(focus, Math.max(0, items.length - 1));
  const current = items[index];
  const cards = useRef<(HTMLElement | null)[]>([]);
  const approveButtons = useRef<(HTMLButtonElement | null)[]>([]);
  /** A card left with the focus in it (its button, or the dialog it opened): the focus goes to the card now in its place. */
  const refocus = useRef(false);

  useEffect(() => {
    if (!refocus.current || queue.isFetching) return;
    refocus.current = false;
    const next = approveButtons.current[index];
    if (next) {
      next.focus();
      next.scrollIntoView?.({ block: 'nearest' });
    } else if (items.length === 0) {
      const heading = document.querySelector<HTMLElement>('main h1');
      heading?.setAttribute('tabindex', '-1');
      heading?.focus();
    }
  }, [items, index, queue.isFetching]);

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = queue;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && items.length - index <= 5) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, items.length, index]);

  function move(to: number) {
    const next = Math.max(0, Math.min(to, items.length - 1));
    setFocus(next);
    setDone(null);
    cards.current[next]?.scrollIntoView?.({ block: 'nearest' });
  }

  function leave(item: AdminTextItem, sideEffects: SideEffects | null, doneKey: MessageKey) {
    refocus.current = true;
    dropFromPages<AdminTextItem>(queryKeys.textQueue, (x) => x.user.id !== item.user.id);
    void queryClient.invalidateQueries({ queryKey: ['user', item.user.id] });
    // The card leaving and the live region are the answer (no toast over the next card's buttons); a late app side is still said.
    setDone(doneKey);
    if (sideEffects === 'failed') showToast((t) => t('common.sideEffectsLate'), 'info', 6_000);
  }

  function stale() {
    showToast((t) => t('texts.stale'), 'error', 6_000);
    void queryClient.invalidateQueries({ queryKey: queryKeys.textQueue });
  }

  async function approve(item: AdminTextItem) {
    if (busy) return;
    setBusy(true);
    try {
      const result = await apiRequest<TextDecision>(`/v1/admin/moderation/texts/${item.user.id}/approve`, { method: 'POST', body: { version: item.version } });
      leave(item, result.sideEffects, 'texts.approved');
    } catch (error) {
      const failure = asApiError(error);
      if (failure.code === 'conflict') stale();
      else showToast((t, lang) => conflictText(failure, t) ?? problemText(failure, t, lang), 'error', 6_000);
    } finally {
      setBusy(false);
    }
  }

  useQueueKeys({
    enabled: current !== undefined && !busy,
    onApprove: canDecide && current ? () => void approve(current) : undefined,
    onReject: canDecide && current ? () => setRejecting(current) : undefined,
    onNext: () => move(index + 1),
    onPrevious: () => move(index - 1),
  });

  const promptLabel = (prompt: AdminTextItem['prompts'][number]) => localized(prompt.question, locale, t('texts.part.prompt', { n: prompt.position + 1 }));

  return (
    <div className="mx-auto grid max-w-4xl grid-cols-1 gap-6">
      <PageHeader
        icon={Type}
        title={t('texts.title')}
        meta={current ? <QueueProgress text={positionText(t, t('queue.kind.person'), index + 1, items.length, hasNextPage)} /> : undefined}
        actions={<RefreshButton onClick={() => void queue.refetch()} busy={queue.isFetching} />}
      />
      {current ? (
        <QueuePosition text={positionText(t, t('queue.kind.person'), index + 1, items.length, hasNextPage)} done={done && t(done)} />
      ) : (
        done && <QueuePosition text="" done={t(done)} />
      )}
      {queue.isPending ? (
        <TableSkeleton rows={4} />
      ) : queue.isError && items.length === 0 ? (
        <LoadError error={queue.error} onRetry={() => void queue.refetch()} />
      ) : items.length === 0 ? (
        <EmptyQueue />
      ) : (
        <ul className="grid gap-4">
          {items.map((item, i) => (
            <li key={item.user.id}>
              <article
                ref={(node) => {
                  cards.current[i] = node;
                }}
                onClick={() => setFocus(i)}
                aria-current={i === index ? 'true' : undefined}
                className={cn(
                  'grid gap-4 rounded-xl border bg-card p-4 text-card-foreground shadow-xs sm:p-5',
                  i === index && 'ring-2 ring-primary ring-offset-2 ring-offset-background',
                )}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <UserRef user={item.user} />
                  {canDecide && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        ref={(node) => {
                          approveButtons.current[i] = node;
                        }}
                        size="sm"
                        onClick={() => void approve(item)}
                        disabled={busy}
                        aria-keyshortcuts={i === index ? 'A' : undefined}
                      >
                        <Check aria-hidden="true" />
                        {t('queue.approve')}
                        {i === index && <Kbd>A</Kbd>}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setRejecting(item)} disabled={busy} aria-keyshortcuts={i === index ? 'R' : undefined}>
                        <X aria-hidden="true" />
                        {t('queue.reject')}
                        {i === index && <Kbd>R</Kbd>}
                      </Button>
                    </div>
                  )}
                </div>
                <dl className="grid gap-3">
                  {item.about && (
                    <Part label={t('user.field.about')} state={item.about.state} reason={item.textRejectReason}>
                      {item.about.text}
                    </Part>
                  )}
                  {item.job && (
                    <Part label={t('user.field.job')} state={item.job.state} reason={item.textRejectReason}>
                      {item.job.text}
                    </Part>
                  )}
                  {item.prompts.map((prompt) => (
                    <Part key={prompt.position} label={promptLabel(prompt)} state={prompt.status} reason={prompt.rejectReason}>
                      {prompt.answer ?? <span className="text-muted-foreground italic">{t('user.voiceAnswer')}</span>}
                    </Part>
                  ))}
                </dl>
              </article>
            </li>
          ))}
        </ul>
      )}
      {queue.hasNextPage && items.length > 0 && (
        <div className="text-center">
          <Button variant="outline" size="sm" onClick={() => void queue.fetchNextPage()} disabled={queue.isFetchingNextPage}>
            {t('common.loadMore')}
          </Button>
        </div>
      )}
      {rejecting && (
        <TextDecisionDialog
          parts={{
            publicUid: rejecting.user.id,
            name: rejecting.user.name ?? rejecting.user.id,
            version: rejecting.version,
            profile: {
              present: rejecting.about !== null || rejecting.job !== null,
              waiting: rejecting.about?.state === 'checking' || rejecting.job?.state === 'checking',
              state: rejecting.about?.state ?? rejecting.job?.state ?? 'checking',
            },
            prompts: rejecting.prompts.map((p) => ({
              position: p.position,
              label: promptLabel(p),
              hasText: p.answer !== null,
              waiting: p.status === 'checking',
              state: p.status,
            })),
          }}
          onClose={() => setRejecting(null)}
          onStale={() => {
            setRejecting(null);
            void queryClient.invalidateQueries({ queryKey: queryKeys.textQueue });
          }}
          onDone={(result) => {
            const item = rejecting;
            setRejecting(null);
            leave(item, result.sideEffects, 'texts.rejected');
          }}
        />
      )}
    </div>
  );
}

function Part({ label, state, reason, children }: { label: string; state: TextState; reason?: string | undefined; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="grid gap-1.5">
      <dt className="flex flex-wrap items-center gap-2 text-sm font-medium">
        <span dir="auto">{label}</span>
        <Badge variant={stateVariant[state]}>{t(`textState.${state}` as MessageKey)}</Badge>
        {state === 'rejected' && reason && <span className="text-xs text-destructive">{t(`reason.text.${reason}` as MessageKey)}</span>}
      </dt>
      <dd dir="auto" className="rounded-md bg-muted/50 px-3 py-2 text-sm whitespace-pre-wrap text-foreground/90">
        {children}
      </dd>
    </div>
  );
}
