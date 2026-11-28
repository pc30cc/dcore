import { GRANT_DAYS_MAX, GRANT_START_AHEAD_DAYS_MAX, REVENUE_NOTE_MAX, type AdminGrantResult, type AdminUserPurchases, type AdminUserRef } from '@app/shared';
import { useId, useState, type FormEvent } from 'react';
import { DayField } from '@/components/form/DayField';
import { Field } from '@/components/form/Field';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { NativeSelect } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { MessageKey } from '@/i18n/messages';
import { useI18n } from '@/i18n/useI18n';
import { Worded } from '@/i18n/Worded';
import { apiRequest } from '@/lib/api';
import { formatDate, formatPlain, localized, todayDay } from '@/lib/format';
import {
  currentPlanEnd,
  giftsChanged,
  GRANT_QUICK_DAYS,
  grantPlans,
  grantProblems,
  grantStartsAt,
  newRequestId,
  personId,
  personIdValid,
  wholeNumber,
  type GrantField,
  type GrantForm,
  type GrantProblems,
  type GrantStart,
} from '@/lib/grants';
import { asApiError } from '@/lib/http';
import { fieldText, problemText } from '@/lib/problemText';
import { usePlans, useUserTab } from '@/lib/queries';
import { can } from '@/lib/session';
import { showToast } from '@/lib/toast';
import { useSession } from '@/lib/useSession';
import { PersonField } from './PersonField';

const DAY_MS = 86_400_000;

/** Where a refusal's pointer lands in the form. */
const fieldOf: Readonly<Record<string, GrantField>> = { '/user': 'person', '/plan': 'plan', '/days': 'days', '/startsAt': 'start', '/reason': 'reason' };

/**
 * Days of a plan for a person: now, when their current plan ends, or from
 * a later day. The dialog's `requestId` is made when it opens, so a second
 * click or a retry gives the days once.
 */
export function GrantDialog({ person, onClose }: { person: AdminUserRef | null; onClose: () => void }) {
  const { t, locale } = useI18n();
  const id = useId();
  const { me } = useSession();
  const [requestId] = useState(newRequestId);
  // The dialog's own clock for its previews (a render reads no time of its own).
  const [openedAt] = useState(() => Date.now());
  const plans = usePlans();
  const choices = grantPlans(plans.data?.items ?? []);
  // Days in the panel's digits (typed in any, read by `wholeNumber`).
  const [form, setForm] = useState<GrantForm>(() => ({ person: person?.id ?? '', plan: '', days: formatPlain(30, locale), start: 'now', day: '', reason: '' }));
  const [problems, setProblems] = useState<GrantProblems>({});
  const [serverText, setServerText] = useState<Partial<Record<GrantField, string | undefined>>>({});
  const [busy, setBusy] = useState(false);
  const userId = person?.id ?? personId(form.person);
  const known = person !== null || personIdValid(form.person);
  const purchases = useUserTab<AdminUserPurchases>(userId, 'purchases', `/v1/admin/users/${userId}/purchases`, known && can(me, 'users.read'));
  const currentEnd = form.plan ? currentPlanEnd(purchases.data, form.plan) : null;
  const starts: GrantStart[] = currentEnd ? ['now', 'after', 'day'] : ['now', 'day'];
  const start = starts.includes(form.start) ? form.start : 'now';
  const live = (purchases.data?.subscriptions ?? []).filter((s) => Date.parse(s.expiresAt) > openedAt);
  const planName = (key: string) => {
    const plan = plans.data?.items.find((item) => item.key === key);
    return plan ? localized(plan.names, locale, plan.key) : key;
  };

  function set<K extends keyof GrantForm>(key: K, value: GrantForm[K], field: GrantField) {
    setForm((current) => ({ ...current, [key]: value }));
    setProblems((current) => ({ ...current, [field]: undefined }));
    setServerText((current) => ({ ...current, [field]: undefined }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const current = { ...form, start };
    const found = grantProblems(current, currentEnd);
    if (!found.person && person === null && !personIdValid(form.person)) found.person = 'grantDialog.person.invalid';
    setProblems(found);
    if (Object.values(found).some(Boolean)) return;
    const startsAt = grantStartsAt(current, currentEnd);
    setBusy(true);
    try {
      const result = await apiRequest<AdminGrantResult>('/v1/admin/grants', {
        method: 'POST',
        body: { requestId, user: userId, plan: form.plan, days: wholeNumber(form.days), ...(startsAt ? { startsAt } : {}), reason: form.reason.trim() },
      });
      giftsChanged(userId);
      // Given, but the person's app was not told or the start and end jobs were not queued: say so.
      if (result.sideEffects === 'failed') showToast((t) => t('common.sideEffectsLate'), 'info', 6_000);
      else showToast((t) => t('grants.given'));
      onClose();
    } catch (error) {
      const failure = asApiError(error);
      if (failure.reason === 'duplicate_request') {
        // The first request gave the days (its answer was lost): nothing more to do.
        giftsChanged(userId);
        showToast((t) => t('revenue.error.duplicate'), 'info');
        onClose();
        return;
      }
      const texts: Partial<Record<GrantField, string | undefined>> = {};
      for (const issue of failure.errors) {
        const field = fieldOf[issue.pointer];
        if (!field || texts[field]) continue;
        texts[field] = issue.code === 'unknown_user' ? t('grantDialog.person.unknown') : (fieldText(issue.code, t, issue.pointer) ?? undefined);
      }
      if (Object.values(texts).some(Boolean)) setServerText(texts);
      else showToast((t, lang) => problemText(failure, t, lang), 'error', 6_000);
    } finally {
      setBusy(false);
    }
  }

  const problem = (field: GrantField) => serverText[field] ?? (problems[field] ? t(problems[field]) : undefined);
  const errors: Readonly<Record<GrantField, string | undefined>> = { person: problem('person'), plan: problem('plan'), days: problem('days'), start: problem('start'), reason: problem('reason') };
  const days = wholeNumber(form.days);
  const startsAt = grantStartsAt({ ...form, start }, currentEnd, openedAt);
  const endsAt = days !== null && days >= 1 && days <= GRANT_DAYS_MAX && (start !== 'day' || form.day) ? new Date((startsAt ? Date.parse(startsAt) : openedAt) + days * DAY_MS).toISOString() : null;
  const maxDay = todayDay(new Date(openedAt + GRANT_START_AHEAD_DAYS_MAX * DAY_MS));
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{person ? t('grantDialog.titleFor', { name: person.name ?? person.id }) : t('grants.new')}</DialogTitle>
        </DialogHeader>
        <form className="grid gap-5" onSubmit={(event) => void submit(event)} noValidate>
          <PersonField id={`${id}-person`} fixed={person} value={form.person} onChange={(value) => set('person', value, 'person')} error={problems.person} />
          {serverText.person && <p className="-mt-3 text-sm text-destructive">{serverText.person}</p>}
          {live.length > 0 && (
            <ul className="-mt-2 grid gap-1 text-xs text-muted-foreground">
              {live.map((s) => (
                <li key={`${s.store ?? 'admin'}-${s.plan}`}>
                  <Worded text={(t) => t('grantDialog.current', { plan: planName(s.plan), date: formatDate(s.expiresAt, locale) })} />
                </li>
              ))}
            </ul>
          )}
          <Field id={`${id}-plan`} label={t('purchases.col.plan')} error={errors.plan}>
            {(control) => (
              <NativeSelect {...control} value={form.plan} onChange={(event) => set('plan', event.target.value, 'plan')} disabled={plans.isPending}>
                <option value="">{t('form.choose')}</option>
                {choices.map((plan) => (
                  <option key={plan.key} value={plan.key}>
                    {localized(plan.names, locale, plan.key)}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field id={`${id}-days`} label={t('grantDialog.days')} error={errors.days}>
            {(control) => (
              <div className="flex flex-wrap items-center gap-2">
                <Input {...control} inputMode="numeric" className="w-20 tabular-nums sm:w-28" value={form.days} onChange={(event) => set('days', event.target.value, 'days')} />
                {GRANT_QUICK_DAYS.map((count) => (
                  <Button key={count} type="button" variant={days === count ? 'secondary' : 'outline'} size="sm" onClick={() => set('days', formatPlain(count, locale), 'days')}>
                    {t('grantDialog.daysQuick', { count })}
                  </Button>
                ))}
              </div>
            )}
          </Field>
          <div className="grid gap-2">
            <span className="text-sm font-medium">{t('grantDialog.start')}</span>
            <Segmented
              label={t('grantDialog.start')}
              value={start}
              options={starts}
              text={(option) => t(`grantDialog.start.${option}` as MessageKey)}
              onChange={(value) => set('start', value, 'start')}
            />
            {start === 'day' && (
              <Field id={`${id}-day`} label={<span className="sr-only">{t('grantDialog.start.day')}</span>} error={errors.start}>
                {(control) => <DayField {...control} value={form.day} min={todayDay()} max={maxDay} onChange={(day) => set('day', day, 'start')} />}
              </Field>
            )}
            {start !== 'day' && errors.start && <p className="text-sm text-destructive">{errors.start}</p>}
            {endsAt && <p className="text-xs text-muted-foreground">{t('grantDialog.ends', { date: formatDate(endsAt, locale) })}</p>}
          </div>
          <Field
            id={`${id}-reason`}
            label={
              <span className="flex w-full items-center gap-2">
                {t('wallet.col.reason')}
                <span className="ms-auto text-xs font-normal text-muted-foreground tabular-nums">{t('form.counter', { count: form.reason.length, max: REVENUE_NOTE_MAX })}</span>
              </span>
            }
            error={errors.reason}
          >
            {(control) => <Textarea {...control} dir="auto" rows={2} maxLength={REVENUE_NOTE_MAX} value={form.reason} onChange={(event) => set('reason', event.target.value, 'reason')} />}
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={busy || plans.isPending}>
              {busy ? t('common.saving') : t('grants.new')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
