import { PROFILE_REVIEW_NOTE_MAX, PROFILE_REVIEW_TEXT_MAX, type AdminProfileDecision, type AdminProfileReviewItem, type ProfileReviewState } from '@app/shared';
import { Check, ImageOff, MessageSquareWarning, ShieldCheck, UserCheck, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { Field } from '@/components/form/Field';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadError, TableSkeleton } from '@/components/QueryState';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/segmented';
import { Textarea } from '@/components/ui/textarea';
import { UserRef } from '@/components/UserRef';
import type { MessageKey } from '@/i18n/messages';
import { useI18n } from '@/i18n/useI18n';
import { apiRequest } from '@/lib/api';
import { formatDate, formatDateTime, formatNumber, languageName, localized, regionName } from '@/lib/format';
import { asApiError } from '@/lib/http';
import { positionText } from '@/lib/moderation';
import { conflictText, problemText } from '@/lib/problemText';
import { decisionsFrom, isReviewState, reviewKeys, reviewStates, useProfileReviews, type ReviewDecision } from '@/lib/profileReviews';
import { dropFromPages, queryClient } from '@/lib/queries';
import { useQueueKeys } from '@/lib/queueKeys';
import { can } from '@/lib/session';
import { showToast } from '@/lib/toast';
import { useSession } from '@/lib/useSession';
import { cn } from '@/lib/utils';
import { EmptyQueue, Kbd, QueuePosition, QueueProgress, RefreshButton } from '@/pages/moderation/QueueParts';

const DONE: Readonly<Record<ReviewDecision, MessageKey>> = {
  approve: 'profiles.approved',
  'needs-changes': 'profiles.sentBack',
  reject: 'profiles.refused',
};

/**
 * `/moderation/profiles`: new profiles waiting for a review before others
 * see them (the waitlist), oldest first; the ones sent back for changes and
 * the refused ones are their own views (`?state=`). Approve makes the
 * account active and listable at once; "Needs changes" and "Refuse" send
 * the person a message in their language. A (approve), R (refuse), J and K
 * as on the other queues.
 */
export function ProfileReviewPage() {
  const { t, locale } = useI18n();
  const { me } = useSession();
  const [params, setParams] = useSearchParams();
  const raw = params.get('state');
  const state: ProfileReviewState = isReviewState(raw) ? raw : 'waiting';
  const canDecide = can(me, 'moderation.decide');
  const queue = useProfileReviews(state);
  const items = useMemo(() => queue.data?.pages.flatMap((page) => page.items) ?? [], [queue.data]);
  const [focus, setFocus] = useState(0);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<MessageKey | null>(null);
  const [writing, setWriting] = useState<{
    item: AdminProfileReviewItem;
    decision: 'needs-changes' | 'reject';
  } | null>(null);
  const index = Math.min(focus, Math.max(0, items.length - 1));
  const current = items[index];
  const cards = useRef<(HTMLElement | null)[]>([]);

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

  function leave(item: AdminProfileReviewItem, result: AdminProfileDecision | null, decision: ReviewDecision) {
    dropFromPages<AdminProfileReviewItem>(reviewKeys.queue(state), (x) => x.user.id !== item.user.id);
    // The other views gain it (needs changes, refused): read again when opened.
    for (const other of reviewStates)
      if (other !== state)
        void queryClient.invalidateQueries({
          queryKey: reviewKeys.queue(other),
        });
    void queryClient.invalidateQueries({ queryKey: ['user', item.user.id] });
    setDone(DONE[decision]);
    if (result?.sideEffects === 'failed') showToast((t) => t('common.sideEffectsLate'), 'info', 6_000);
  }

  function refused(item: AdminProfileReviewItem, error: unknown) {
    const failure = asApiError(error);
    showToast((t, lang) => conflictText(failure, t) ?? problemText(failure, t, lang), 'error', 6_000);
    if (failure.code === 'conflict' && failure.reason === 'already_decided') dropFromPages<AdminProfileReviewItem>(reviewKeys.queue(state), (x) => x.user.id !== item.user.id);
    else if (failure.code === 'conflict' || failure.status === 404) void queryClient.invalidateQueries({ queryKey: reviewKeys.queue(state) });
  }

  async function approve(item: AdminProfileReviewItem) {
    if (busy) return;
    setBusy(true);
    try {
      leave(item, await apiRequest<AdminProfileDecision>(`/v1/admin/users/${item.user.id}/approve`, { method: 'POST', body: { from: item.state } }), 'approve');
    } catch (error) {
      refused(item, error);
    } finally {
      setBusy(false);
    }
  }

  const offered = decisionsFrom(state);
  useQueueKeys({
    enabled: current !== undefined && !busy,
    onApprove: canDecide && current ? () => void approve(current) : undefined,
    onReject: canDecide && current && offered.includes('reject') ? () => setWriting({ item: current, decision: 'reject' }) : undefined,
    onNext: () => move(index + 1),
    onPrevious: () => move(index - 1),
  });

  const position = positionText(t, t('queue.kind.person'), index + 1, items.length, hasNextPage);
  return (
    <div className="mx-auto grid max-w-4xl grid-cols-1 gap-6">
      <PageHeader
        icon={UserCheck}
        title={t('profiles.title')}
        meta={current ? <QueueProgress text={position} /> : undefined}
        actions={<RefreshButton onClick={() => void queue.refetch()} busy={queue.isFetching} />}
      />
      <Segmented
        className="w-full sm:w-auto sm:justify-self-start"
        label={t('profiles.view')}
        value={state}
        options={reviewStates}
        text={(option) => t(`review.state.${option}` as MessageKey)}
        onChange={(next) => {
          setFocus(0);
          setDone(null);
          setParams(next === 'waiting' ? {} : { state: next }, {
            replace: true,
          });
        }}
      />
      <QueuePosition text={current ? position : ''} done={done && t(done)} />
      {queue.isPending ? (
        <TableSkeleton rows={4} />
      ) : queue.isError && items.length === 0 ? (
        <LoadError error={queue.error} onRetry={() => void queue.refetch()} />
      ) : items.length === 0 ? (
        <EmptyQueue
          {...(state === 'waiting'
            ? {}
            : {
                text: t(state === 'needs_changes' ? 'profiles.empty.needsChanges' : 'profiles.empty.rejected'),
              })}
        />
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
                className={cn('grid gap-4 rounded-xl border bg-card p-4 text-card-foreground shadow-xs sm:p-5', i === index && 'ring-2 ring-primary ring-offset-2 ring-offset-background')}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="grid min-w-0 gap-1.5">
                    <UserRef user={item.user} />
                    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                      {item.user.age !== null && (
                        <span>
                          {t('photos.age', {
                            age: formatNumber(item.user.age, locale),
                          })}
                        </span>
                      )}
                      {item.user.gender && <span>{t(`gender.${item.user.gender}` as MessageKey)}</span>}
                      {item.user.country && <span>{regionName(item.user.country, locale)}</span>}
                      <span>{languageName(item.locale, locale)}</span>
                      <span>
                        {t('profiles.signedUp', {
                          date: formatDate(item.signedUpAt, locale),
                        })}
                      </span>
                      {item.rounds > 0 && <span>{t('profiles.rounds', { count: item.rounds })}</span>}
                      {item.user.verified && (
                        <Badge variant="success">
                          <ShieldCheck aria-hidden="true" />
                          {t('user.badge.verified')}
                        </Badge>
                      )}
                    </p>
                  </div>
                  {canDecide && (
                    <div className="flex flex-wrap gap-2">
                      {offered.includes('approve') && (
                        <Button size="sm" onClick={() => void approve(item)} disabled={busy} aria-keyshortcuts={i === index ? 'A' : undefined}>
                          <Check aria-hidden="true" />
                          {t('queue.approve')}
                          {i === index && <Kbd>A</Kbd>}
                        </Button>
                      )}
                      {offered.includes('needs-changes') && (
                        <Button size="sm" variant="outline" onClick={() => setWriting({ item, decision: 'needs-changes' })} disabled={busy}>
                          <MessageSquareWarning aria-hidden="true" />
                          {t('profiles.needsChanges')}
                        </Button>
                      )}
                      {offered.includes('reject') && (
                        <Button size="sm" variant="outline" onClick={() => setWriting({ item, decision: 'reject' })} disabled={busy} aria-keyshortcuts={i === index ? 'R' : undefined}>
                          <X aria-hidden="true" />
                          {t('profiles.refuse')}
                          {i === index && <Kbd>R</Kbd>}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
                <Photos item={item} />
                <ProfileText item={item} />
                {item.decision && (
                  <div className="grid gap-1 rounded-md border border-dashed px-3 py-2 text-sm">
                    <span className="text-xs text-muted-foreground">
                      {item.decision.decidedBy
                        ? t(item.decision.kind === 'rejected' ? 'profiles.lastDecision.rejectedBy' : 'profiles.lastDecision.needsChangesBy', {
                            name: item.decision.decidedBy.displayName,
                            time: formatDateTime(item.decision.decidedAt, locale),
                          })
                        : t(item.decision.kind === 'rejected' ? 'profiles.lastDecision.rejected' : 'profiles.lastDecision.needsChanges', {
                            time: formatDateTime(item.decision.decidedAt, locale),
                          })}
                    </span>
                    <p dir="auto" lang={item.locale} className="whitespace-pre-wrap">
                      {item.decision.reasonText}
                    </p>
                  </div>
                )}
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
      {writing && (
        <DecisionDialog
          item={writing.item}
          decision={writing.decision}
          onClose={() => setWriting(null)}
          onDone={(result) => {
            const { item, decision } = writing;
            setWriting(null);
            leave(item, result, decision);
          }}
          onRefused={(error) => {
            const { item } = writing;
            setWriting(null);
            refused(item, error);
          }}
        />
      )}
    </div>
  );
}

function Photos({ item }: { item: AdminProfileReviewItem }) {
  const { t } = useI18n();
  if (item.photos.length === 0) return <p className="text-sm text-muted-foreground">{t('profiles.noPhotos')}</p>;
  return (
    <ul className="flex flex-wrap gap-2">
      {[...item.photos]
        .sort((a, b) => a.position - b.position)
        .map((photo) => (
          <li key={photo.id} className="relative size-24 overflow-hidden rounded-lg border bg-muted sm:size-28" title={t(`photoStatus.${photo.status}` as MessageKey)}>
            {photo.thumbUrl ? (
              <img src={photo.thumbUrl} alt="" loading="lazy" className="size-full object-cover" />
            ) : (
              <span className="grid size-full place-items-center text-muted-foreground" aria-hidden="true">
                <ImageOff className="size-5" />
              </span>
            )}
            <span className="sr-only">{t(`photoStatus.${photo.status}` as MessageKey)}</span>
            {photo.status !== 'approved' && (
              <Badge variant={photo.status === 'rejected' ? 'destructive' : 'warning'} className="absolute start-1 top-1">
                {t(`photoStatus.${photo.status}` as MessageKey)}
              </Badge>
            )}
          </li>
        ))}
    </ul>
  );
}

function ProfileText({ item }: { item: AdminProfileReviewItem }) {
  const { t, locale } = useI18n();
  const parts = [
    ...(item.about
      ? [
          {
            key: 'about',
            label: t('user.field.about'),
            text: item.about as string | null,
          },
        ]
      : []),
    ...(item.job
      ? [
          {
            key: 'job',
            label: t('user.field.job'),
            text: item.job as string | null,
          },
        ]
      : []),
    ...item.prompts.map((prompt) => ({
      key: `prompt-${prompt.position}`,
      label: localized(prompt.question, locale, t('texts.part.prompt', { n: prompt.position + 1 })),
      text: prompt.answer,
    })),
  ];
  if (parts.length === 0) return null;
  return (
    <dl className="grid gap-3">
      {parts.map((part) => (
        <div key={part.key} className="grid gap-1">
          <dt dir="auto" className="text-sm font-medium">
            {part.label}
          </dt>
          <dd dir="auto" className="rounded-md bg-muted/50 px-3 py-2 text-sm whitespace-pre-wrap text-foreground/90">
            {part.text ?? <span className="text-muted-foreground italic">{t('user.voiceAnswer')}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Sends a profile back for changes, or refuses it, with the message the person reads (in their language) and an optional note for the team. */
function DecisionDialog({
  item,
  decision,
  onClose,
  onDone,
  onRefused,
}: {
  item: AdminProfileReviewItem;
  decision: 'needs-changes' | 'reject';
  onClose: () => void;
  onDone: (result: AdminProfileDecision) => void;
  onRefused: (error: unknown) => void;
}) {
  const { t, locale } = useI18n();
  const id = useId();
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const name = item.user.name ?? item.user.id;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!text.trim()) {
      setError(t('form.required'));
      return;
    }
    setBusy(true);
    try {
      const body = {
        from: item.state,
        reasonText: text.trim(),
        ...(note.trim() ? { note: note.trim() } : {}),
      };
      onDone(await apiRequest<AdminProfileDecision>(`/v1/admin/users/${item.user.id}/${decision}`, { method: 'POST', body }));
    } catch (failure) {
      onRefused(failure);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(decision === 'reject' ? 'profiles.refuse.title' : 'profiles.needsChanges.title', { name })}</DialogTitle>
        </DialogHeader>
        <form className="grid gap-5" onSubmit={(event) => void submit(event)} noValidate>
          <DialogDescription>{t(decision === 'reject' ? 'profiles.refuse.effect' : 'profiles.needsChanges.effect')}</DialogDescription>
          <Field
            id={`${id}-text`}
            label={
              <span className="flex w-full items-center gap-2">
                {t('profiles.message', { name })}
                <Badge variant="muted">{languageName(item.locale, locale)}</Badge>
              </span>
            }
            error={error}
          >
            {(control) => (
              <Textarea
                {...control}
                dir={item.locale === 'fa' ? 'rtl' : 'ltr'}
                lang={item.locale}
                rows={4}
                maxLength={PROFILE_REVIEW_TEXT_MAX}
                value={text}
                onChange={(event) => {
                  setText(event.target.value);
                  setError(undefined);
                }}
              />
            )}
          </Field>
          <Field id={`${id}-note`} label={t('profiles.note')} optional={t('form.optional')}>
            {(control) => <Textarea {...control} dir="auto" rows={2} maxLength={PROFILE_REVIEW_NOTE_MAX} value={note} onChange={(event) => setNote(event.target.value)} />}
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant={decision === 'reject' ? 'destructive' : 'default'} disabled={busy}>
              {busy ? t('common.saving') : t(decision === 'reject' ? 'profiles.refuse' : 'profiles.needsChanges.send')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
