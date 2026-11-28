import { REVENUE_NOTE_MAX, type AdminGrant, type AdminGrantResult } from '@app/shared';
import { CalendarX2 } from 'lucide-react';
import { useId, useState } from 'react';
import { Field } from '@/components/form/Field';
import { ConfirmDialog } from '@/components/ui/alert-dialog';
import { StatusDot } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/i18n/useI18n';
import { apiRequest } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { giftsChanged, grantEndable, grantShownEnd, grantTone } from '@/lib/grants';
import { asApiError } from '@/lib/http';
import { problemText } from '@/lib/problemText';
import { showToast } from '@/lib/toast';
import { PersonCell, PlanName } from './parts';

/**
 * Plan days given, one row a grant: the person (but on their own page),
 * the plan, its days, its state and who gave it why; "End now" with
 * billing.grant for a running or coming one.
 */
export function GrantTable({ rows, showPerson = true, canEnd }: { rows: readonly AdminGrant[]; showPerson?: boolean; canEnd: boolean }) {
  const { t, locale } = useI18n();
  const [ending, setEnding] = useState<AdminGrant | null>(null);
  const actions = canEnd && rows.some((grant) => grantEndable(grant.state));
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {showPerson && <TableHead>{t('purchases.col.person')}</TableHead>}
            <TableHead>{t('purchases.col.plan')}</TableHead>
            <TableHead className="hidden sm:table-cell">{t('grants.col.period')}</TableHead>
            <TableHead className="hidden sm:table-cell">{t('purchases.col.state')}</TableHead>
            <TableHead className="hidden md:table-cell">{t('grants.col.by')}</TableHead>
            <TableHead className="hidden lg:table-cell">{t('wallet.col.reason')}</TableHead>
            {actions && (
              <TableHead className="w-12">
                <span className="sr-only">{t('common.actions')}</span>
              </TableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((grant) => {
            const period = t('grants.period', { from: formatDate(grant.startsAt, locale), to: formatDate(grantShownEnd(grant), locale) });
            const state = (
              <span className="grid justify-items-start gap-0.5">
                <StatusDot tone={grantTone[grant.state]}>{t(`grants.state.${grant.state}`)}</StatusDot>
                {grant.state === 'revoked' && grant.revokedBy && <bdi className="text-xs text-muted-foreground">{grant.revokedBy.displayName}</bdi>}
                {grant.state === 'revoked' && grant.revokeReason && (
                  <p dir="auto" className="line-clamp-2 text-xs break-words text-muted-foreground">
                    {grant.revokeReason}
                  </p>
                )}
              </span>
            );
            return (
              <TableRow key={grant.id}>
                {showPerson && (
                  <TableCell className="max-w-56 sm:min-w-40">
                    <PersonCell user={grant.user} />
                  </TableCell>
                )}
                <TableCell className="max-w-64">
                  <span className="grid justify-items-start gap-1">
                    <PlanName planKey={grant.plan} />
                    {/* On a phone the period and the state sit here (their columns are hidden). */}
                    <span className="grid gap-1 text-xs text-muted-foreground sm:hidden">
                      <span>{period}</span>
                      {state}
                    </span>
                    {/* Below lg the reason sits here (its column is hidden). */}
                    <p dir="auto" className="line-clamp-2 text-xs break-words text-muted-foreground lg:hidden">
                      {grant.reason}
                    </p>
                  </span>
                </TableCell>
                <TableCell className="hidden text-sm text-muted-foreground sm:table-cell">{period}</TableCell>
                <TableCell className="hidden sm:table-cell">{state}</TableCell>
                <TableCell className="hidden text-sm whitespace-nowrap md:table-cell">{grant.grantedBy ? <bdi>{grant.grantedBy.displayName}</bdi> : t('common.none')}</TableCell>
                <TableCell className="hidden max-w-56 lg:table-cell">
                  <p dir="auto" className="line-clamp-2 text-sm break-words text-muted-foreground" title={grant.reason}>
                    {grant.reason}
                  </p>
                </TableCell>
                {actions && (
                  <TableCell className="text-end">
                    {grantEndable(grant.state) && (
                      // Below lg the icon alone (its name stays for a screen reader and on hover).
                      <Button variant="ghost" size="sm" onClick={() => setEnding(grant)} aria-label={t('grants.end')} title={t('grants.end')}>
                        <CalendarX2 aria-hidden="true" />
                        <span className="hidden lg:inline">{t('grants.end')}</span>
                      </Button>
                    )}
                  </TableCell>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {ending && <EndGrantDialog key={ending.id} grant={ending} onClose={() => setEnding(null)} />}
    </>
  );
}

/** Ends a grant now, with the admin's reason (kept on the grant; the person never sees it). */
function EndGrantDialog({ grant, onClose }: { grant: AdminGrant; onClose: () => void }) {
  const { t } = useI18n();
  const id = useId();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const name = grant.user.status === 'purged' ? t('chats.deletedAccount') : (grant.user.name ?? grant.user.id);

  async function end() {
    if (busy || !reason.trim()) return;
    setBusy(true);
    try {
      const result = await apiRequest<AdminGrantResult>(`/v1/admin/grants/${grant.id}`, { method: 'DELETE', body: { reason: reason.trim() } });
      showToast((t) => t(result.sideEffects === 'failed' ? 'common.sideEffectsLate' : 'grants.ended'));
      giftsChanged(grant.user.id);
      onClose();
    } catch (error) {
      const failure = asApiError(error);
      showToast((t, lang) => problemText(failure, t, lang), 'error', 6_000);
      if (failure.reason === 'grant_ended' || failure.status === 404) {
        giftsChanged(grant.user.id);
        onClose();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && !busy && onClose()}
      title={t('grants.end.title')}
      description={
        <>
          <bdi className="font-medium text-foreground">{name}</bdi>
          <p>{t(grant.state === 'scheduled' ? 'grants.end.bodyScheduled' : 'grants.end.bodyActive')}</p>
        </>
      }
      confirmLabel={t('grants.end')}
      destructive
      busy={busy}
      confirmDisabled={!reason.trim()}
      onConfirm={() => void end()}
    >
      <Field id={`${id}-reason`} label={t('wallet.col.reason')}>
        {(control) => <Textarea {...control} dir="auto" rows={2} maxLength={REVENUE_NOTE_MAX} value={reason} onChange={(event) => setReason(event.target.value)} />}
      </Field>
    </ConfirmDialog>
  );
}
