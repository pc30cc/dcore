import type { AdminEvidence, AdminPenaltyKind, AdminReportDetail, AdminReportFiling, AdminReportHistoryEntry, AdminReportSummary, ReportResolution } from '@app/shared';
import { ArrowLeft, ArrowRight, Eye, Gavel, ImageOff, Lock, MessageSquare, Plus, ShieldAlert, ShieldOff, TriangleAlert, UserCheck, UserMinus, UserX, XCircle } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useFromList } from '@/lib/listState';
import { CopyId } from '@/components/CopyId';
import { PageHeader } from '@/components/layout/PageHeader';
import { ActionDialog } from '@/components/moderation/ActionDialog';
import { LoadError, TableSkeleton } from '@/components/QueryState';
import { Badge, StatusDot } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { UserRef } from '@/components/UserRef';
import type { MessageKey } from '@/i18n/messages';
import { useI18n } from '@/i18n/useI18n';
import { apiRequest } from '@/lib/api';
import { formatDate, formatDateTime, formatNumber, localized } from '@/lib/format';
import { asApiError } from '@/lib/http';
import { holdKindTone, openReport, reportStatusTone, resolutionOfPenalty } from '@/lib/moderation';
import { problemText } from '@/lib/problemText';
import { queryClient, queryKeys, storeUser, useReport, useUser } from '@/lib/queries';
import { can } from '@/lib/session';
import { showToast } from '@/lib/toast';
import { useSession } from '@/lib/useSession';
import { savedToast } from '@/lib/users';
import { cn } from '@/lib/utils';
import { SectionCard } from '../users/SectionCard';
import { CaseNumber, NewHoldDialog } from './HoldsPage';
import { CloseDialog, HoldAndFileDialog, type CloseMode } from './ReportDialogs';
import { PriorityCell, ReasonBadge } from './ReportsPage';

type Open = { kind: 'close'; mode: CloseMode; initial?: ReportResolution } | { kind: 'file' } | { kind: 'hold' } | { kind: 'penalty'; penalty: AdminPenaltyKind } | null;

/** `/moderation/reports/:id`: one report, its evidence, the people in it and what was done. */
export function ReportPage() {
  const { t } = useI18n();
  const { id = '' } = useParams();
  const report = useReport(id);
  if (report.isSuccess) return <ReportView report={report.data} />;
  const code = report.isError ? asApiError(report.error).code : null;
  const missing = code === 'not_found' || code === 'validation_failed';
  return (
    <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6">
      <PageHeader eyebrow={<BackToReports />} title={missing ? t('report.notFound') : report.isPending ? <Skeleton className="h-7 w-48" aria-hidden="true" /> : t('report.title')} />
      {report.isPending && <TableSkeleton rows={4} />}
      {report.isError && !missing && <LoadError error={report.error} onRetry={() => void report.refetch()} />}
    </div>
  );
}

function BackToReports() {
  const { t, dir } = useI18n();
  const from = useFromList();
  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;
  return (
    <Link to={`/moderation/reports${from}`} className="inline-flex items-center gap-1 hover:text-foreground">
      <Back className="size-4" aria-hidden="true" />
      {t('reports.title')}
    </Link>
  );
}

/** Puts the report as a write answered it into the cache, reads it again behind it (its history), and drops the lists it moved in. */
function storeReport(report: AdminReportDetail, summary: AdminReportSummary): void {
  queryClient.setQueryData(queryKeys.report(report.id), { ...report, ...summary });
  void queryClient.invalidateQueries({ queryKey: queryKeys.report(report.id) });
  void queryClient.invalidateQueries({ queryKey: ['reports'] });
}

/** The actions of a report's history by name; consecutive chat views by the same admin are one line with a count. */
const HISTORY_ACTIONS = new Set(['report.view_chat', 'report.assign', 'report.resolve', 'report.dismiss', 'report.file']);

function historyLines(history: readonly AdminReportHistoryEntry[]): { entry: AdminReportHistoryEntry; count: number }[] {
  const lines: { entry: AdminReportHistoryEntry; count: number }[] = [];
  for (const entry of history) {
    const last = lines.at(-1);
    if (last && entry.action === 'report.view_chat' && last.entry.action === entry.action && last.entry.admin?.id === entry.admin?.id) last.count += 1;
    else lines.push({ entry, count: 1 });
  }
  return lines;
}

function ReportView({ report }: { report: AdminReportDetail }) {
  const { t, locale } = useI18n();
  const { me } = useSession();
  const [open, setOpen] = useState<Open>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const from = useFromList();
  const isOpen = openReport(report);
  const allow = {
    assign: isOpen && can(me, 'reports.assign'),
    resolve: isOpen && can(me, 'reports.resolve'),
    file: report.filing === null && can(me, 'reports.hold'),
    hold: can(me, 'reports.hold'),
  };
  // The authority filing is for child safety and threats; on any other report it stays a secondary action.
  const urgent = report.reason === 'child_safety' || report.reason === 'threat';
  const mine = me !== null && report.assignee?.id === me.id;

  async function assign(to: string | null) {
    if (busy) return;
    setBusy(true);
    try {
      const summary = await apiRequest<AdminReportSummary>(`/v1/admin/reports/${report.id}/assign`, { method: 'POST', body: { to, from: report.assignee?.id ?? null } });
      storeReport(report, summary);
      showToast(t('common.saved'));
    } catch (error) {
      const failure = asApiError(error);
      showToast(problemText(failure, t), 'error', 6_000);
      if (failure.code === 'conflict') void queryClient.invalidateQueries({ queryKey: queryKeys.report(report.id) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6">
      <PageHeader
        eyebrow={<BackToReports />}
        title={t(`reportReason.${report.reason}` as MessageKey)}
        meta={
          <>
            <StatusDot tone={reportStatusTone[report.status]}>{t(`reportStatus.${report.status}` as MessageKey)}</StatusDot>
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              {t('reports.col.priority')}
              <PriorityCell priority={report.priority} />
            </span>
            <span className="text-muted-foreground">{t(`reportContext.${report.context}` as MessageKey)}</span>
            <span className="text-muted-foreground">{formatDateTime(report.filedAt, locale)}</span>
            {report.assignee && <span className="text-muted-foreground">{t('report.assignedTo', { name: report.assignee.displayName })}</span>}
            {report.resolution && <Badge variant="outline">{t(`resolution.${report.resolution}` as MessageKey)}</Badge>}
            {report.filed && <Badge variant="destructive">{t('report.filed')}</Badge>}
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              {t('holds.col.report')}
              <CopyId value={report.id} />
            </span>
            {report.conversationId && (
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                {t('holds.conversationWord')}
                <CopyId value={report.conversationId} />
              </span>
            )}
          </>
        }
        actions={
          <>
            {allow.assign &&
              (mine ? (
                <Button variant="outline" onClick={() => void assign(null)} disabled={busy}>
                  <UserMinus aria-hidden="true" />
                  {t('report.unassign')}
                </Button>
              ) : (
                <Button variant="outline" onClick={() => me && void assign(me.id)} disabled={busy}>
                  <UserCheck aria-hidden="true" />
                  {t('report.assignToMe')}
                </Button>
              ))}
            {allow.resolve && (
              <>
                <Button onClick={() => setOpen({ kind: 'close', mode: 'resolve' })}>
                  <Gavel aria-hidden="true" />
                  {t('report.resolve')}
                </Button>
                <Button variant="outline" onClick={() => setOpen({ kind: 'close', mode: 'dismiss' })}>
                  <XCircle aria-hidden="true" />
                  {t('report.dismiss')}
                </Button>
              </>
            )}
            {allow.file && (
              <Button variant={urgent ? 'destructive' : 'outline'} className={cn(!urgent && 'text-destructive hover:text-destructive')} onClick={() => setOpen({ kind: 'file' })}>
                <Lock aria-hidden="true" />
                {t('report.holdAndFile')}
              </Button>
            )}
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="grid min-w-0 content-start gap-6">
          {/* The reporter's words once: a filing that carries them shows them already. */}
          {report.details && !report.filings.some((filing) => filing.details === report.details) && (
            <SectionCard title={t('report.details')}>
              <p className="rounded-md bg-muted/50 px-3 py-2 text-sm whitespace-pre-wrap bidi-plain">{report.details}</p>
            </SectionCard>
          )}
          <SectionCard title={t('report.filings')}>
            {report.filings.length === 0 ? <p className="text-sm text-muted-foreground">{t('report.noFilings')}</p> : <FilingList filings={report.filings} veiled={report.reason === 'child_safety'} />}
          </SectionCard>
          {/* Only a report about a conversation has a chat to show. */}
          {(report.context === 'chat' || report.conversationId !== null || report.filings.some((filing) => filing.conversationId !== undefined)) && <ChatCard report={report} />}
        </div>
        <div className="contents lg:grid lg:content-start lg:gap-6">
          <PersonCard report={report} onPenalty={(penalty) => setOpen({ kind: 'penalty', penalty })} />
          <SectionCard title={t('reports.col.reporter')}>
            {report.reporter ? <UserRef user={report.reporter} wrap /> : <p className="text-sm text-muted-foreground">{t('common.automatic')}</p>}
          </SectionCard>
          {(report.holds.length > 0 || report.filing !== null || allow.hold) && (
            <SectionCard
              title={t('report.holdsAndFiling')}
              actions={
                allow.hold && (
                  <Button size="sm" variant="outline" onClick={() => setOpen({ kind: 'hold' })}>
                    <Plus aria-hidden="true" />
                    {t('holds.new')}
                  </Button>
                )
              }
            >
              <div className="grid gap-3 text-sm">
                {report.filing && (
                  <div className="grid gap-1 rounded-lg bg-muted/50 px-3 py-2">
                    <span className="font-medium">{t(`authority.${report.filing.authority}` as MessageKey)}</span>
                    {report.filing.externalRef && (
                      <span className="text-xs">
                        <CaseNumber value={report.filing.externalRef} />
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {formatDate(report.filing.filedAt, locale)}
                      {report.filing.filedBy && ` · ${report.filing.filedBy.displayName}`}
                    </span>
                  </div>
                )}
                {report.holds.length > 0 && (
                  <ul className="grid gap-2">
                    {report.holds.map((hold) => (
                      <li key={hold.id} className="flex flex-wrap items-center gap-2">
                        <Badge variant={holdKindTone[hold.kind]}>{t(`holdKind.${hold.kind}` as MessageKey)}</Badge>
                        <span className="text-muted-foreground">{hold.user ? t('holds.account') : t('holds.conversation', { id: hold.conversationId ?? '' })}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {!report.filing && report.holds.length === 0 && <p className="text-muted-foreground">{t('holds.empty')}</p>}
                {allow.hold && (report.holds.length > 0 || report.filing !== null) && (
                  <Link to="/moderation/holds" className="text-sm text-primary hover:underline">
                    {t('holds.title')}
                  </Link>
                )}
              </div>
            </SectionCard>
          )}
          {report.otherOpen.length > 0 && (
            <SectionCard title={t('report.otherOpen')}>
              <ul className="grid gap-2 text-sm">
                {report.otherOpen.map((other) => (
                  <li key={other.id}>
                    <Link to={`/moderation/reports/${other.id}`} className="flex flex-wrap items-center gap-2 rounded-md px-1 py-0.5 hover:bg-muted/60">
                      <ReasonBadge reason={other.reason} />
                      <span className="text-muted-foreground">{formatDate(other.filedAt, locale)}</span>
                      <span className="ms-auto">
                        <PriorityCell priority={other.priority} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </SectionCard>
          )}
          {report.history.length > 0 && (
            <SectionCard title={t('report.history')}>
              <ul className="grid gap-2 text-sm">
                {historyLines(report.history).map(({ entry, count }) => (
                  <li key={entry.id} className="grid gap-0.5">
                    <span>
                      {HISTORY_ACTIONS.has(entry.action) ? (
                        t(`report.event.${entry.action.slice('report.'.length)}` as MessageKey)
                      ) : (
                        <bdi dir="ltr" className="font-mono text-xs">
                          {entry.action}
                        </bdi>
                      )}
                      {count > 1 && <span className="text-muted-foreground"> ×{formatNumber(count, locale)}</span>}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatDateTime(entry.at, locale)} · {entry.admin?.displayName ?? t('audit.system')}
                    </span>
                  </li>
                ))}
              </ul>
            </SectionCard>
          )}
        </div>
      </div>

      {open?.kind === 'close' && (
        <CloseDialog
          report={report}
          mode={open.mode}
          initial={open.initial}
          penalties={penaltiesFor(me)}
          onPenalty={(penalty) => setOpen({ kind: 'penalty', penalty })}
          onClose={() => setOpen(null)}
          onDone={(items) => {
            const own = items.find((item) => item.id === report.id);
            if (own) storeReport(report, own);
            for (const item of items) if (item.id !== report.id) void queryClient.invalidateQueries({ queryKey: queryKeys.report(item.id) });
            showToast(items.length > 1 ? t('report.closedMany', { count: items.length }) : t('report.closed'));
            setOpen(null);
            // Back to the list view the report was opened from, for the next one.
            void navigate(`/moderation/reports${from}`);
          }}
        />
      )}
      {open?.kind === 'file' && (
        <HoldAndFileDialog
          report={report}
          onClose={() => setOpen(null)}
          onDone={(result) => {
            queryClient.setQueryData(queryKeys.report(report.id), { ...report, filing: result.filing, holds: result.holds, filed: true });
            void queryClient.invalidateQueries({ queryKey: queryKeys.report(report.id) });
            void queryClient.invalidateQueries({ queryKey: ['holds'] });
            showToast(t('report.filedToast'));
            setOpen(null);
          }}
        />
      )}
      {open?.kind === 'hold' && (
        <NewHoldDialog
          initial={{
            kind: report.reason === 'child_safety' ? 'child_safety' : report.reason === 'threat' ? 'threat' : 'authority',
            user: report.reported.id,
            conversationId: report.conversationId ?? undefined,
            reportId: report.id,
          }}
          onClose={() => setOpen(null)}
          onDone={() => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.report(report.id) });
            void queryClient.invalidateQueries({ queryKey: ['holds'] });
            showToast(t('common.saved'));
            setOpen(null);
          }}
        />
      )}
      {open?.kind === 'penalty' && <PenaltyFromReport report={report} penalty={open.penalty} onClose={() => setOpen(null)} onCloseReport={(initial) => setOpen({ kind: 'close', mode: 'resolve', initial })} />}
    </div>
  );
}

/** The penalties this admin may take on the reported person. */
function penaltiesFor(me: ReturnType<typeof useSession>['me']): AdminPenaltyKind[] {
  return (['warn', 'suspend', 'ban', 'shadowban'] as const).filter((kind) => can(me, `users.${kind}`));
}

/** The action dialog of the user pages, about the reported person and naming this report; when done, closing the report follows. */
function PenaltyFromReport({
  report,
  penalty,
  onClose,
  onCloseReport,
}: {
  report: AdminReportDetail;
  penalty: AdminPenaltyKind;
  onClose: () => void;
  onCloseReport: (initial: ReportResolution) => void;
}) {
  const { t } = useI18n();
  const { me } = useSession();
  const user = useUser(report.reported.id);
  if (!user.data) return null;
  return (
    <ActionDialog
      kind={penalty}
      user={user.data}
      reportId={report.id}
      // The report's reason is a moderation reason too: the person's message starts from it ("other" leaves the choice open).
      initialReason={report.reason === 'other' ? undefined : report.reason}
      onClose={onClose}
      onDone={(result) => {
        storeUser(result.user, ['moderation', 'audit']);
        void queryClient.invalidateQueries({ queryKey: queryKeys.report(report.id) });
        savedToast(t, result.sideEffects);
        // The report the penalty was taken on is closed next, with the matching resolution.
        if (openReport(report) && can(me, 'reports.resolve')) onCloseReport(resolutionOfPenalty[penalty]);
        else onClose();
      }}
    />
  );
}

function PersonCard({ report, onPenalty }: { report: AdminReportDetail; onPenalty: (penalty: AdminPenaltyKind) => void }) {
  const { t } = useI18n();
  const { me } = useSession();
  const canRead = can(me, 'users.read');
  const live = report.reported.status !== 'deleted' && report.reported.status !== 'purged';
  const penalties: { kind: AdminPenaltyKind; label: MessageKey; icon: typeof ShieldAlert; shown: boolean }[] = [
    { kind: 'warn', label: 'action.menu.warn', icon: TriangleAlert, shown: can(me, 'users.warn') },
    { kind: 'suspend', label: 'action.menu.suspend', icon: ShieldAlert, shown: can(me, 'users.suspend') },
    { kind: 'ban', label: 'action.menu.ban', icon: ShieldOff, shown: can(me, 'users.ban') },
    { kind: 'shadowban', label: 'action.menu.shadowban', icon: UserX, shown: can(me, 'users.shadowban') },
  ];
  const shown = canRead && live ? penalties.filter((p) => p.shown) : [];
  return (
    <SectionCard title={t('reports.col.reported')}>
      <UserRef user={report.reported} link={canRead} wrap />
      {report.actions.length > 0 && (
        <ul className="grid gap-1.5 text-sm">
          {report.actions.map((action) => (
            <li key={action.id} className="flex flex-wrap items-center gap-2">
              <Badge variant={action.kind === 'ban' ? 'destructive' : action.kind === 'lift' ? 'secondary' : 'warning'}>{t(`kind.action.${action.kind}` as MessageKey)}</Badge>
              <span className="text-xs text-muted-foreground">{action.admin?.displayName ?? t('common.automatic')}</span>
            </li>
          ))}
        </ul>
      )}
      {shown.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {shown.map(({ kind, label, icon: Icon }) => (
            <Button key={kind} variant="outline" size="sm" onClick={() => onPenalty(kind)} className={cn(kind === 'ban' && 'text-destructive')}>
              <Icon aria-hidden="true" />
              {t(label)}
            </Button>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function FilingList({ filings, veiled }: { filings: readonly AdminReportFiling[]; veiled: boolean }) {
  const { t, locale } = useI18n();
  return (
    <ul className="grid gap-4">
      {filings.map((filing) => (
        <li key={filing.id} className="grid gap-3 rounded-lg border p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <ReasonBadge reason={filing.reason} />
            <span className="text-muted-foreground">{t(`reportContext.${filing.context}` as MessageKey)}</span>
            {filing.messages > 0 && <span className="text-muted-foreground">{t('report.messagesNamed', { count: filing.messages })}</span>}
            <span className="ms-auto text-xs text-muted-foreground">{formatDateTime(filing.at, locale)}</span>
          </div>
          {filing.details && <p className="rounded-md bg-muted/50 px-3 py-2 whitespace-pre-wrap bidi-plain">{filing.details}</p>}
          {filing.photo && <Thumb url={filing.photo.url} status={filing.photo.status} large veiled={veiled} />}
          {filing.profile && (
            <div className="grid gap-2">
              <span className="text-xs font-medium text-muted-foreground">{t('report.profileThen')}</span>
              <dl className="grid gap-2">
                {filing.profile.name && <Snapshot label={t('action.rename.name')}>{filing.profile.name}</Snapshot>}
                {filing.profile.about && <Snapshot label={t('user.field.about')}>{filing.profile.about}</Snapshot>}
                {filing.profile.job && <Snapshot label={t('user.field.job')}>{filing.profile.job}</Snapshot>}
                {filing.profile.prompts.map((p, i) => (
                  <Snapshot key={`${p.promptId}-${i}`} label={localized(p.question, locale, t('texts.part.prompt', { n: i + 1 }))}>
                    {p.answer ?? <span className="text-muted-foreground italic">{t('user.voiceAnswer')}</span>}
                  </Snapshot>
                ))}
              </dl>
              {filing.profile.photos.length > 0 && (
                <ul className="flex flex-wrap gap-2">
                  {filing.profile.photos.map((photo) => (
                    <li key={photo.id}>
                      <Thumb url={photo.thumbUrl} status={photo.status} veiled={veiled} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

/** A field of the profile as it was: the person's text in its own script, aligned with its label. */
function Snapshot({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground bidi-plain">{label}</dt>
      <dd className="whitespace-pre-wrap bidi-plain">{children}</dd>
    </div>
  );
}

/** A photo of the evidence; on a child-safety report it is veiled until the admin chooses to look. */
function Thumb({ url, status, large = false, veiled = false }: { url?: string | undefined; status?: string | undefined; large?: boolean; veiled?: boolean }) {
  const { t } = useI18n();
  const [shown, setShown] = useState(false);
  const label = status ? t(`photoStatus.${status}` as MessageKey) : t('report.photoGone');
  const hidden = veiled && !shown && url !== undefined;
  return (
    <span className={cn('relative block overflow-hidden rounded-md border bg-muted', large ? 'aspect-[4/5] w-40' : 'size-16')} title={label}>
      {url ? (
        <img src={url} alt="" loading="lazy" className={cn('size-full object-cover', hidden && 'scale-110 blur-xl')} />
      ) : (
        <span className="grid size-full place-items-center text-muted-foreground" aria-hidden="true">
          <ImageOff className="size-4" />
        </span>
      )}
      {hidden && (
        <Button
          type="button"
          variant="secondary"
          size={large ? 'sm' : 'icon'}
          className={cn('absolute inset-0 m-auto shadow-md', !large && 'size-8')}
          onClick={() => setShown(true)}
          aria-label={large ? undefined : t('photos.show')}
        >
          <Eye aria-hidden="true" />
          {large && t('photos.show')}
        </Button>
      )}
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** The chat evidence: asked for (and audited) only on "Show chat". */
function ChatCard({ report }: { report: AdminReportDetail }) {
  const { t, locale } = useI18n();
  const { me } = useSession();
  const [evidence, setEvidence] = useState<AdminEvidence | null>(null);
  const [busy, setBusy] = useState(false);
  const canView = can(me, 'reports.view_chat');
  const collecting = report.evidence === 'collecting';

  async function show() {
    if (busy) return;
    setBusy(true);
    try {
      setEvidence(await apiRequest<AdminEvidence>(`/v1/admin/reports/${report.id}/evidence`, { method: 'POST', body: {} }));
      // The view is audited: the history shows it on the next read.
      void queryClient.invalidateQueries({ queryKey: queryKeys.report(report.id) });
    } catch (error) {
      showToast(problemText(asApiError(error), t), 'error', 6_000);
    } finally {
      setBusy(false);
    }
  }

  const snapshots = evidence?.chat ?? [];
  return (
    <SectionCard
      title={t('report.chat')}
      actions={
        canView &&
        evidence === null && (
          <Button size="sm" variant="outline" onClick={() => void show()} disabled={busy}>
            <Eye aria-hidden="true" />
            {t('report.showChat')}
          </Button>
        )
      }
    >
      {evidence === null ? (
        collecting ? (
          <StatusDot tone="amber">{t('report.collecting')}</StatusDot>
        ) : !canView ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <MessageSquare className="size-4" aria-hidden="true" />
            {t('report.chatNoAccess')}
          </p>
        ) : null
      ) : snapshots.length === 0 ? (
        <p className="text-sm text-muted-foreground">{collecting ? t('report.collecting') : t('report.noChat')}</p>
      ) : (
        <div className="grid gap-5">
          {snapshots.map((snapshot) => (
            <div key={snapshot.filingId} className="grid gap-2">
              <span className="text-xs text-muted-foreground">{t('report.takenAt', { date: formatDateTime(snapshot.takenAt, locale) })}</span>
              <ol className="grid gap-2">
                {snapshot.messages.map((m) => (
                  <Bubble key={m.id} from={m.from} at={m.at} kind={m.kind} flags={m.flags} late={m.late} named={m.named}>
                    {m.body}
                  </Bubble>
                ))}
                {snapshot.requests.map((r) => (
                  <Bubble key={r.id} from={r.from} at={r.at} kind="request" flags={[]} late={false} named={false}>
                    {r.body}
                  </Bubble>
                ))}
              </ol>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function Bubble({
  from,
  at,
  kind,
  flags,
  late,
  named,
  children,
}: {
  from: AdminEvidence['chat'][number]['messages'][number]['from'];
  at: string;
  kind: string;
  flags: string[];
  late: boolean;
  named: boolean;
  children: ReactNode;
}) {
  const { t, locale } = useI18n();
  const reported = from === 'reported';
  return (
    <li className={cn('flex', reported ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'grid max-w-[85%] gap-1 rounded-2xl px-3 py-2 text-sm',
          reported ? 'rounded-ee-sm bg-primary/10 text-foreground dark:bg-primary/25' : from === 'reporter' ? 'rounded-es-sm bg-muted' : 'rounded-es-sm border border-dashed',
          named && 'ring-2 ring-amber-500/70 dark:ring-amber-400/60',
        )}
      >
        <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-medium">{t(`evidence.from.${from}` as MessageKey)}</span>
          {named && <Badge variant="warning">{t('evidence.named')}</Badge>}
          {kind !== 'text' && <Badge variant="outline">{t(`messageKind.${kind}` as MessageKey)}</Badge>}
          {flags.map((flag) => (
            <Badge key={flag} variant={flag === 'risky' ? 'warning' : 'outline'}>
              {t(`messageFlag.${flag}` as MessageKey)}
            </Badge>
          ))}
        </span>
        {children !== null && children !== undefined && (
          <p dir="auto" className="whitespace-pre-wrap">
            {children}
          </p>
        )}
        <span className="text-xs text-muted-foreground">
          {formatDateTime(at, locale)}
          {late && ` · ${t('evidence.late')}`}
        </span>
      </div>
    </li>
  );
}

