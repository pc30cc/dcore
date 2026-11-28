import { REVENUE_NOTE_MAX, type AdminUserRef, type AdminUserWallet, type AdminWalletAdjustResult, type WalletBalance } from '@app/shared';
import { useQuery } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { Field } from '@/components/form/Field';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { NativeSelect } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { MessageKey } from '@/i18n/messages';
import { useI18n } from '@/i18n/useI18n';
import { apiRequest } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import {
  balanceOf,
  giftsChanged,
  mayCorrect,
  newRequestId,
  personId,
  personIdValid,
  walletBalances,
  walletItems,
  walletProblems,
  wholeNumber,
  type WalletForm,
  type WalletKind,
  type WalletProblems,
} from '@/lib/grants';
import { asApiError } from '@/lib/http';
import { problemText } from '@/lib/problemText';
import { can } from '@/lib/session';
import { showToast } from '@/lib/toast';
import { useSession } from '@/lib/useSession';
import { cn } from '@/lib/utils';
import { PersonField } from './PersonField';

const balanceText: Readonly<Record<WalletBalance, MessageKey>> = { gifts: 'store.admin', play: 'store.play', bazaar: 'store.bazaar' };

/**
 * A gift to a person's gifts balance, or a correction of one of their
 * balances (with billing.grant): either way, never below zero. The balance
 * now and after the change are shown before it is sent.
 */
export function WalletAdjustDialog({ person, onClose }: { person: AdminUserRef | null; onClose: () => void }) {
  const { t, locale } = useI18n();
  const id = useId();
  const { me } = useSession();
  const corrections = mayCorrect(me);
  const [requestId] = useState(newRequestId);
  const [form, setForm] = useState<WalletForm>({ person: person?.id ?? '', kind: 'gift', item: 'superlike', amount: '', balance: 'gifts', note: '' });
  const [problems, setProblems] = useState<WalletProblems>({});
  const [busy, setBusy] = useState(false);
  const userId = person?.id ?? personId(form.person);
  const known = person !== null || personIdValid(form.person);
  // The balances only (the ledger's first row is enough): its own key, beside the wallet tab's pages.
  const wallet = useQuery({
    queryKey: ['user', userId, 'wallet', 'balances'],
    enabled: known && can(me, 'users.read'),
    queryFn: ({ signal }) => apiRequest<AdminUserWallet>(`/v1/admin/users/${userId}/wallet?limit=1`, { signal }),
  });
  const balance: WalletBalance = form.kind === 'gift' ? 'gifts' : form.balance;
  const now = balanceOf(wallet.data, form.item, balance);
  const amount = wholeNumber(form.amount);
  const after = now !== null && amount !== null ? now + (form.kind === 'gift' ? Math.abs(amount) : amount) : null;
  // A balance never goes below zero: the admin sees the refusal before sending (the server still decides).
  const short = after !== null && after < 0;
  const amountProblem = problems.amount ?? (short ? 'walletAdjust.insufficient' : undefined);

  function set<K extends keyof WalletForm>(key: K, value: WalletForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setProblems((current) => ({ ...current, ...(key === 'person' || key === 'note' ? { [key]: undefined } : { amount: undefined }) }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const found = walletProblems(form);
    if (!found.person && person === null && !personIdValid(form.person)) found.person = 'grantDialog.person.invalid';
    if (!found.amount && short) found.amount = 'walletAdjust.insufficient';
    setProblems(found);
    if (Object.values(found).some(Boolean) || amount === null) {
      // The balance shown may be old: read it again.
      if (short) void wallet.refetch();
      return;
    }
    setBusy(true);
    try {
      const body =
        form.kind === 'gift'
          ? { kind: 'gift', requestId, item: form.item, quantity: amount, note: form.note.trim() }
          : { kind: 'correction', requestId, item: form.item, balance: form.balance, delta: amount, note: form.note.trim() };
      const result = await apiRequest<AdminWalletAdjustResult>(`/v1/admin/users/${userId}/wallet-adjust`, { method: 'POST', body });
      giftsChanged(userId);
      if (result.sideEffects === 'failed') showToast((t) => t('common.sideEffectsLate'), 'info', 6_000);
      else showToast((t) => t('walletAdjust.done'));
      onClose();
    } catch (error) {
      const failure = asApiError(error);
      if (failure.reason === 'duplicate_request') {
        giftsChanged(userId);
        showToast((t) => t('revenue.error.duplicate'), 'info');
        onClose();
        return;
      }
      if (failure.errors.some((issue) => issue.code === 'insufficient_balance')) {
        setProblems({ amount: 'walletAdjust.insufficient' });
        void wallet.refetch();
      } else if (failure.status === 404 && person === null) setProblems({ person: 'grantDialog.person.unknown' });
      else showToast((t, lang) => problemText(failure, t, lang), 'error', 6_000);
    } finally {
      setBusy(false);
    }
  }

  const kinds: WalletKind[] = corrections ? ['gift', 'correction'] : ['gift'];
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{person ? t('walletAdjust.titleFor', { name: person.name ?? person.id }) : t('walletAdjust.new')}</DialogTitle>
        </DialogHeader>
        <form className="grid gap-5" onSubmit={(event) => void submit(event)} noValidate>
          <PersonField id={`${id}-person`} fixed={person} value={form.person} onChange={(value) => set('person', value)} error={problems.person} />
          {kinds.length > 1 && (
            <div className="grid gap-2">
              <span className="text-sm font-medium">{t('walletAdjust.kind')}</span>
              <Segmented label={t('walletAdjust.kind')} value={form.kind} options={kinds} text={(kind) => t(`walletAdjust.kind.${kind}`)} onChange={(kind) => set('kind', kind)} />
            </div>
          )}
          <div className="grid gap-5 sm:grid-cols-2">
            <Field id={`${id}-item`} label={t('wallet.col.item')}>
              {(control) => (
                <NativeSelect {...control} value={form.item} onChange={(event) => set('item', event.target.value as WalletForm['item'])}>
                  {walletItems.map((item) => (
                    <option key={item} value={item}>
                      {t(`walletItem.${item}`)}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <Field id={`${id}-amount`} label={t('walletAdjust.amount')} error={amountProblem ? t(amountProblem) : undefined}>
              {(control) => (
                <Input
                  {...control}
                  inputMode={form.kind === 'gift' ? 'numeric' : 'text'}
                  dir="ltr"
                  className="tabular-nums"
                  value={form.amount}
                  onChange={(event) => set('amount', event.target.value)}
                />
              )}
            </Field>
          </div>
          {form.kind === 'correction' && (
            <div className="grid gap-2">
              <span className="text-sm font-medium">{t('wallet.col.balance')}</span>
              <Segmented label={t('wallet.col.balance')} value={form.balance} options={walletBalances} text={(option) => t(balanceText[option])} onChange={(option) => set('balance', option)} />
            </div>
          )}
          {now !== null && (
            <p className={cn('-mt-2 text-sm tabular-nums', short ? 'text-destructive' : 'text-muted-foreground')}>
              {after !== null ? t('walletAdjust.preview', { now: formatNumber(now, locale), after: formatNumber(after, locale) }) : t('walletAdjust.current', { now: formatNumber(now, locale) })}
            </p>
          )}
          <Field
            id={`${id}-note`}
            label={
              <span className="flex w-full items-center gap-2">
                {t('purchase.note')}
                <span className="ms-auto text-xs font-normal text-muted-foreground tabular-nums">{t('form.counter', { count: form.note.length, max: REVENUE_NOTE_MAX })}</span>
              </span>
            }
            error={problems.note ? t(problems.note) : undefined}
          >
            {(control) => <Textarea {...control} dir="auto" rows={2} maxLength={REVENUE_NOTE_MAX} value={form.note} onChange={(event) => set('note', event.target.value)} />}
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? t('common.saving') : t(form.kind === 'gift' ? 'walletAdjust.submit.gift' : 'walletAdjust.submit.correction')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
