import type { AdminPurchaseActionResult, AdminPurchaseDetail } from '@app/shared';
import { REVENUE_NOTE_MAX } from '@app/shared';
import { useId, useState, type FormEvent } from 'react';
import { Field } from '@/components/form/Field';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/segmented';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/i18n/useI18n';
import { apiRequest } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { asApiError } from '@/lib/http';
import { problemText } from '@/lib/problemText';
import { actionBody, actionLabel, actionRequest, noteRequired, outcomeMessage, purchaseKeys, refundModes, storePurchase, type PurchaseButton } from '@/lib/purchases';
import { queryClient } from '@/lib/queries';
import { showToast } from '@/lib/toast';

/**
 * One admin action on a purchase: what it does in one sentence, the refund's
 * mode where the store offers both, and the note (kept in the audit log;
 * the person never sees it). The body carries the state the admin saw, so
 * a purchase that moved meanwhile is refused rather than acted on.
 */
export function PurchaseActionDialog({ purchase, action, onClose }: { purchase: AdminPurchaseDetail; action: PurchaseButton; onClose: () => void }) {
  const { t, locale } = useI18n();
  const id = useId();
  const modes = action === 'refund' ? refundModes(purchase.available) : [];
  const [mode, setMode] = useState<'full' | 'prorated'>(modes[0] ?? 'full');
  const [note, setNote] = useState('');
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const destructive = action === 'refund' || action === 'revoke';
  const body =
    action === 'cancel'
      ? purchase.expiresAt
        ? t('purchase.action.cancel.body', { date: formatDate(purchase.expiresAt, locale) })
        : t('purchase.action.cancel.bodyOpen')
      : t(actionBody(action, purchase.kind));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (noteRequired(action) && !note.trim()) {
      setMissing(true);
      return;
    }
    setBusy(true);
    try {
      const result = await apiRequest<AdminPurchaseActionResult>(`/v1/admin/purchases/${purchase.id}/${action}`, {
        method: 'POST',
        body: actionRequest(action, purchase, note, mode === 'prorated'),
      });
      storePurchase(result.purchase);
      const done = result.sideEffects === 'failed' ? 'common.sideEffectsLate' : outcomeMessage(action, result);
      showToast((t) => t(done), result.outcome === 'pending' ? 'info' : 'success', 6_000);
      onClose();
    } catch (error) {
      const failure = asApiError(error);
      showToast((t, lang) => problemText(failure, t, lang), 'error', 6_000);
      // The purchase moved, another action ran, or the re-check recorded a foreign account: the page reads it again.
      if (failure.reason === 'purchase_changed' || failure.reason === 'purchase_busy' || failure.reason === 'action_not_available' || failure.reason === 'foreign_account') {
        void queryClient.invalidateQueries({ queryKey: purchaseKeys.detail(purchase.id) });
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
          <DialogTitle>{t(actionLabel[action])}</DialogTitle>
          <DialogDescription>{body}</DialogDescription>
        </DialogHeader>
        <form className="grid gap-5" onSubmit={(event) => void submit(event)} noValidate>
          {modes.length > 1 && (
            <div className="grid gap-2">
              <span className="text-sm font-medium" id={`${id}-mode`}>
                {t('purchase.refund.mode')}
              </span>
              <Segmented label={t('purchase.refund.mode')} value={mode} options={modes} text={(option) => t(`purchase.refund.${option}`)} onChange={setMode} />
            </div>
          )}
          <Field
            id={`${id}-note`}
            label={
              <span className="flex w-full items-center gap-2">
                {t('purchase.note')}
                <span className="ms-auto text-xs font-normal text-muted-foreground tabular-nums">{t('form.counter', { count: note.length, max: REVENUE_NOTE_MAX })}</span>
              </span>
            }
            {...(noteRequired(action) ? {} : { optional: t('form.optional') })}
            error={missing && !note.trim() ? t('form.required') : undefined}
          >
            {(control) => <Textarea {...control} dir="auto" rows={3} maxLength={REVENUE_NOTE_MAX} value={note} onChange={(event) => setNote(event.target.value)} />}
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant={destructive ? 'destructive' : 'default'} disabled={busy}>
              {busy ? t('common.saving') : t(actionLabel[action])}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
