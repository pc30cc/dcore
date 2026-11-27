import type { AdminHoldAndFile, AdminPenaltyKind, AdminReportDetail, AdminReportSummary, FilingAuthority, ReportResolution } from '@app/shared';
import { useId, useState, type FormEvent } from 'react';
import { Field } from '@/components/form/Field';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { MessageKey } from '@/i18n/messages';
import { useI18n } from '@/i18n/useI18n';
import { apiRequest } from '@/lib/api';
import { asApiError } from '@/lib/http';
import { actionResolutions, closeResolutions, filingAuthorities, penaltyOfResolution } from '@/lib/moderation';
import { problemText } from '@/lib/problemText';
import { showToast } from '@/lib/toast';

/** The report page's dialogs: closing it (with or without an action) and filing it with an authority. */

export type CloseMode = 'resolve' | 'dismiss';

/**
 * Closing a report. Opened after a penalty taken from the report, its resolution comes pre-chosen. Opened on
 * its own ("close with action"), a penalty resolution is not just a label: choosing one hands over to that
 * penalty's dialog (`onPenalty`), whose success brings this dialog back pre-chosen; the penalties the admin
 * may not take are not offered.
 */
export function CloseDialog({
  report,
  mode,
  initial,
  penalties = [],
  onPenalty,
  onClose,
  onDone,
}: {
  report: AdminReportDetail;
  mode: CloseMode;
  initial?: ReportResolution | undefined;
  /** The penalties the admin may take here (offered as resolutions when the dialog opens on its own). */
  penalties?: readonly AdminPenaltyKind[];
  onPenalty?: ((penalty: AdminPenaltyKind) => void) | undefined;
  onClose: () => void;
  onDone: (items: AdminReportSummary[]) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const handOver = mode === 'resolve' && initial === undefined && onPenalty !== undefined;
  const choices =
    mode === 'resolve'
      ? actionResolutions.filter((r) => {
          const penalty = penaltyOfResolution(r);
          return penalty === null || r === initial || (handOver && penalties.includes(penalty));
        })
      : closeResolutions;
  const [resolution, setResolution] = useState<string>(initial && choices.includes(initial) ? initial : '');
  const handsOver = handOver && resolution !== '' && penaltyOfResolution(resolution as ReportResolution) !== null;
  const [note, setNote] = useState('');
  const [sameTarget, setSameTarget] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!resolution) {
      setError(t('form.required'));
      return;
    }
    if (busy) return;
    // A penalty is taken first, in its own dialog; nothing is closed here.
    const penalty = handOver ? penaltyOfResolution(resolution as ReportResolution) : null;
    if (penalty !== null && onPenalty) {
      onPenalty(penalty);
      return;
    }
    setBusy(true);
    try {
      const body = { resolution, ...(note.trim() ? { note: note.trim() } : {}), ...(sameTarget ? { sameTarget: true } : {}) };
      const result = await apiRequest<{ items: AdminReportSummary[] }>(`/v1/admin/reports/${report.id}/${mode}`, { method: 'POST', body });
      onDone(result.items);
    } catch (failure) {
      showToast((t) => problemText(asApiError(failure), t), 'error', 6_000);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === 'resolve' ? t('report.resolve') : t('report.dismiss')}</DialogTitle>
        </DialogHeader>
        <form className="grid gap-5" onSubmit={(event) => void submit(event)} noValidate>
          <Field id={`${id}-resolution`} label={t('report.resolution')} error={error}>
            {(control) => (
              <NativeSelect {...control} value={resolution} onChange={(event) => setResolution(event.target.value)}>
                <option value="">{t('form.choose')}</option>
                {choices.map((r) => (
                  <option key={r} value={r}>
                    {t(`resolution.${r}` as MessageKey)}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field id={`${id}-note`} label={t('action.note')} optional={t('form.optional')}>
            {(control) => <Textarea {...control} rows={2} maxLength={2_000} value={note} onChange={(event) => setNote(event.target.value)} />}
          </Field>
          <label className="flex items-center gap-3 text-sm">
            <input type="checkbox" checked={sameTarget} onChange={(event) => setSameTarget(event.target.checked)} className="size-4 accent-primary" />
            {t('report.sameTarget')}
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? t('common.saving') : handsOver ? t('common.continue') : mode === 'resolve' ? t('report.resolve') : t('report.dismiss')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function HoldAndFileDialog({ report, onClose, onDone }: { report: AdminReportDetail; onClose: () => void; onDone: (result: AdminHoldAndFile) => void }) {
  const { t } = useI18n();
  const id = useId();
  const [authority, setAuthority] = useState<string>(report.reason === 'child_safety' ? 'ncmec' : '');
  const [externalRef, setExternalRef] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const contact = report.childSafetyContact;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!authority) {
      setError(t('form.required'));
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      const body = { authority: authority as FilingAuthority, ...(externalRef.trim() ? { externalRef: externalRef.trim() } : {}) };
      onDone(await apiRequest<AdminHoldAndFile>(`/v1/admin/reports/${report.id}/hold-and-file`, { method: 'POST', body }));
    } catch (failure) {
      showToast((t) => problemText(asApiError(failure), t), 'error', 6_000);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('report.holdAndFile')}</DialogTitle>
        </DialogHeader>
        <form className="grid gap-5" onSubmit={(event) => void submit(event)} noValidate>
          {contact && (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-lg bg-muted/50 px-3 py-2.5 text-sm">
              <dt className="text-muted-foreground">{t('report.contact')}</dt>
              <dd>
                <bdi>{contact.name ?? t('common.none')}</bdi>
              </dd>
              {contact.email && (
                <>
                  <dt className="text-muted-foreground">{t('report.contactEmail')}</dt>
                  <dd className="truncate">
                    <bdi dir="ltr" className="font-mono text-xs leading-5">
                      {contact.email}
                    </bdi>
                  </dd>
                </>
              )}
            </dl>
          )}
          <Field id={`${id}-authority`} label={t('report.authority')} error={error}>
            {(control) => (
              <NativeSelect {...control} value={authority} onChange={(event) => setAuthority(event.target.value)}>
                <option value="">{t('form.choose')}</option>
                {filingAuthorities.map((a) => (
                  <option key={a} value={a}>
                    {t(`authority.${a}` as MessageKey)}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field id={`${id}-ref`} label={t('report.caseNumber')} optional={t('form.optional')}>
            {(control) => <Input {...control} dir="auto" maxLength={200} value={externalRef} onChange={(event) => setExternalRef(event.target.value)} autoComplete="off" />}
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="destructive" disabled={busy}>
              {busy ? t('common.saving') : t('report.holdAndFile')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
