import type { AdminAppeal, AdminAppealDecision } from '@app/shared';
import { Lock, Scale, Undo2 } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { Field } from '@/components/form/Field';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadError, TableSkeleton } from '@/components/QueryState';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { UserRef } from '@/components/UserRef';
import type { MessageKey } from '@/i18n/messages';
import { useI18n } from '@/i18n/useI18n';
import { apiRequest } from '@/lib/api';
import { formatDate, formatDateTime, languageName } from '@/lib/format';
import { asApiError } from '@/lib/http';
import { conflictText, problemText } from '@/lib/problemText';
import { dropFromPages, queryClient, queryKeys, useAppeals } from '@/lib/queries';
import { can } from '@/lib/session';
import { showToast } from '@/lib/toast';
import { useSession } from '@/lib/useSession';
import { actionTone, personLocale, reasonLabel, reasonlessKinds, savedToast } from '@/lib/users';
import { ActionRow } from '../users/tabs/ModerationTab';
import { EmptyQueue, RefreshButton } from './QueueParts';

type AppealStatusView = 'open' | 'decided';
type Decision = 'uphold' | 'overturn';

const appealTone = { open: 'warning', upheld: 'muted', overturned: 'success' } as const;

/** `/moderation/appeals`: open appeals oldest first and decided ones (`?status=`), each with the action, the person's words and their record. */
export function AppealsPage() {
  const { t, dir } = useI18n();
  const { me } = useSession();
  const [params, setParams] = useSearchParams();
  const status: AppealStatusView = params.get('status') === 'decided' ? 'decided' : 'open';
  const appeals = useAppeals(status);
  const items = appeals.data?.pages.flatMap((page) => page.items) ?? [];
  const [deciding, setDeciding] = useState<{ appeal: AdminAppeal; decision: Decision } | null>(null);
  const canDecide = can(me, 'appeals.decide');

  return (
    <div className="mx-auto grid max-w-4xl grid-cols-1 gap-6">
      <PageHeader icon={Scale} title={t('appeals.title')} actions={<RefreshButton onClick={() => void appeals.refetch()} busy={appeals.isFetching} />} />
      <Tabs value={status} onValueChange={(value) => setParams(value === 'open' ? {} : { status: value }, { replace: true })} dir={dir} className="gap-4">
        <TabsList aria-label={t('appeals.title')}>
          <TabsTrigger value="open">{t('appeals.open')}</TabsTrigger>
          <TabsTrigger value="decided">{t('appeals.decided')}</TabsTrigger>
        </TabsList>
        <TabsContent value={status}>
          {appeals.isPending ? (
            <TableSkeleton rows={3} />
          ) : appeals.isError && items.length === 0 ? (
            <LoadError error={appeals.error} onRetry={() => void appeals.refetch()} />
          ) : items.length === 0 ? (
            <EmptyQueue text={status === 'open' ? t('queue.empty') : t('appeals.emptyDecided')} />
          ) : (
            <ul className="grid gap-4">
              {items.map((appeal) => (
                <li key={appeal.id}>
                  <AppealCard appeal={appeal} canDecide={canDecide && appeal.status === 'open'} onDecide={(decision) => setDeciding({ appeal, decision })} />
                </li>
              ))}
            </ul>
          )}
          {appeals.hasNextPage && (
            <div className="mt-4 text-center">
              <Button variant="outline" size="sm" onClick={() => void appeals.fetchNextPage()} disabled={appeals.isFetchingNextPage}>
                {t('common.loadMore')}
              </Button>
            </div>
          )}
        </TabsContent>
      </Tabs>
      {deciding && (
        <DecisionDialog
          appeal={deciding.appeal}
          decision={deciding.decision}
          onClose={() => setDeciding(null)}
          onDone={(result) => {
            dropFromPages<AdminAppeal>(queryKeys.appeals('open'), (a) => a.id !== result.appeal.id);
            void queryClient.invalidateQueries({ queryKey: queryKeys.appeals('decided') });
            void queryClient.invalidateQueries({ queryKey: ['user', result.appeal.user.id] });
            savedToast(t, result.sideEffects, deciding.decision === 'overturn' ? 'appeals.overturned' : 'appeals.upheld');
            setDeciding(null);
          }}
        />
      )}
    </div>
  );
}

function AppealCard({ appeal, canDecide, onDecide }: { appeal: AdminAppeal; canDecide: boolean; onDecide: (decision: Decision) => void }) {
  const { t, locale } = useI18n();
  const action = appeal.action;
  return (
    <article className="grid gap-4 rounded-xl border bg-card p-4 text-card-foreground shadow-xs sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <UserRef user={appeal.user} />
        <span className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant={appealTone[appeal.status]}>{t(`appealStatus.${appeal.status}` as MessageKey)}</Badge>
          <span className="text-xs text-muted-foreground">{formatDateTime(appeal.filedAt, locale)}</span>
        </span>
      </div>
      <div className="grid gap-2 rounded-lg border p-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={actionTone[action.kind] ?? 'secondary'}>{t(`kind.action.${action.kind}` as MessageKey)}</Badge>
          {!reasonlessKinds.has(action.kind) && <span className="font-medium">{t(reasonLabel(action))}</span>}
          {action.standing && <Badge variant="outline">{t('moderation.standing')}</Badge>}
          <span className="ms-auto text-xs text-muted-foreground">
            {action.kind === 'warning' ? formatDate(action.startsAt, locale) : action.endsAt ? t('moderation.until', { date: formatDate(action.endsAt, locale) }) : t('common.permanent')}
          </span>
        </div>
        <p className="rounded-md bg-muted/50 px-3 py-2 whitespace-pre-wrap bidi-plain">{action.reasonText}</p>
        {action.note && (
          <p className="whitespace-pre-wrap text-muted-foreground">
            <span className="font-medium">{t('moderation.note')}: </span>
            <bdi>{action.note}</bdi>
          </p>
        )}
        <span className="text-xs text-muted-foreground">{action.admin ? t('moderation.by', { name: action.admin.displayName }) : t('common.automatic')}</span>
      </div>
      <blockquote className="grid gap-1 border-s-2 border-primary/50 ps-3">
        <span className="text-xs font-medium text-muted-foreground">{t('appeals.body')}</span>
        <p className="text-sm whitespace-pre-wrap bidi-plain">{appeal.body}</p>
      </blockquote>
      {appeal.decisionText && (
        <p className="text-sm whitespace-pre-wrap">
          <span className="font-medium">{t('moderation.decision')}: </span>
          <bdi>{appeal.decisionText}</bdi>
          {appeal.decidedBy && <span className="text-muted-foreground"> · {appeal.decidedBy.displayName}</span>}
          {appeal.decidedAt && <span className="text-muted-foreground"> · {formatDateTime(appeal.decidedAt, locale)}</span>}
        </p>
      )}
      {appeal.history.length > 0 && (
        <details className="group text-sm">
          <summary className="cursor-pointer text-muted-foreground select-none hover:text-foreground">{t('appeals.history', { count: appeal.history.length })}</summary>
          <ul className="mt-2 grid divide-y rounded-lg border">
            {appeal.history.map((record) => (
              <ActionRow key={record.id} action={record} />
            ))}
          </ul>
        </details>
      )}
      {canDecide && (
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => onDecide('uphold')}>
            <Lock aria-hidden="true" />
            {t('appeals.uphold')}
          </Button>
          {/* Both outline: the decision is the case's, not a default to nudge toward. */}
          <Button variant="outline" onClick={() => onDecide('overturn')}>
            <Undo2 aria-hidden="true" />
            {t('appeals.overturn')}
          </Button>
        </div>
      )}
    </article>
  );
}

function DecisionDialog({ appeal, decision, onClose, onDone }: { appeal: AdminAppeal; decision: Decision; onClose: () => void; onDone: (result: AdminAppealDecision) => void }) {
  const { t, locale } = useI18n();
  const id = useId();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const name = appeal.user.name ?? appeal.user.id;
  // The person reads the decision in their own language: the field says which, and is written in its direction.
  const language = personLocale(appeal.locale);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) {
      setError(t('form.required'));
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      onDone(await apiRequest<AdminAppealDecision>(`/v1/admin/appeals/${appeal.id}/${decision}`, { method: 'POST', body: { text: text.trim() } }));
    } catch (failure) {
      const problem = asApiError(failure);
      const conflict = conflictText(problem, t);
      showToast(conflict ?? problemText(problem, t), 'error', 6_000);
      if (conflict) {
        dropFromPages<AdminAppeal>(queryKeys.appeals('open'), (a) => a.id !== appeal.id);
        onClose();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{decision === 'overturn' ? t('appeals.overturn.title', { name }) : t('appeals.uphold.title', { name })}</DialogTitle>
        </DialogHeader>
        <form className="grid gap-5" onSubmit={(event) => void submit(event)} noValidate>
          <Field
            id={`${id}-text`}
            label={
              <span className="flex w-full items-center gap-2">
                {t('appeals.decisionText', { name })}
                <Badge variant="muted">{languageName(language, locale)}</Badge>
              </span>
            }
            error={error}
          >
            {(control) => (
              <Textarea {...control} dir={language === 'fa' ? 'rtl' : 'ltr'} lang={language} rows={4} maxLength={2_000} value={text} onChange={(event) => setText(event.target.value)} />
            )}
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? t('common.saving') : decision === 'overturn' ? t('appeals.overturn') : t('appeals.uphold')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
