import type { AdminAction, AdminPenaltyKind, AdminUserDetail, ModerationReason, SideEffects } from '@app/shared';
import { useId, useState, type FormEvent } from 'react';
import { Field } from '@/components/form/Field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { MessageKey } from '@/i18n/messages';
import { useI18n } from '@/i18n/useI18n';
import { apiRequest } from '@/lib/api';
import { formatDate, languageName } from '@/lib/format';
import { asApiError } from '@/lib/http';
import { problemText } from '@/lib/problemText';
import { useReasons } from '@/lib/queries';
import { can } from '@/lib/session';
import { showToast } from '@/lib/toast';
import { useSession } from '@/lib/useSession';
import {
  endField,
  endOf,
  moderationReasons,
  penaltyBody,
  penaltyProblems,
  personLocale,
  prefilledMessage,
  reasonLabel,
  untilPresets,
  type PenaltyForm,
  type PenaltyProblems,
  type UntilChoice,
  standingPeriod,
} from '@/lib/users';

export type ActionKind = AdminPenaltyKind | 'lift';

export interface ActionResult {
  user: AdminUserDetail;
  action: AdminAction;
  sideEffects: SideEffects;
}

const MESSAGE_MAX = 1_000;
const NOTE_MAX = 2_000;

const titles: Readonly<Record<ActionKind, MessageKey>> = {
  warn: 'action.warn.title',
  suspend: 'action.suspend.title',
  ban: 'action.ban.title',
  shadowban: 'action.shadowban.title',
  lift: 'action.lift.title',
};

const submits: Readonly<Record<ActionKind, MessageKey>> = {
  warn: 'action.submit.warn',
  suspend: 'action.submit.suspend',
  ban: 'action.submit.ban',
  shadowban: 'action.submit.shadowban',
  lift: 'action.submit.lift',
};

/**
 * A warning, suspension, ban or shadowban of a person, or the lift of one
 * that stands. The message is what the person reads, in their language:
 * pre-filled from the reason, replaced when the reason changes until the
 * admin edits it. A shadowban has no message (the person is never told). A
 * lift's text stays on the lift record, which the person never reads: it is
 * an internal note.
 */
export function ActionDialog({
  kind,
  user,
  reportId,
  initialReason,
  onClose,
  onDone,
}: {
  kind: ActionKind;
  user: AdminUserDetail;
  reportId?: string;
  /** The reason chosen to begin with (a report's own reason): its message is pre-filled at once. */
  initialReason?: ModerationReason | undefined;
  onClose: () => void;
  onDone: (result: ActionResult) => void;
}) {
  const { t } = useI18n();
  const name = user.name ?? user.id;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(titles[kind], { name })}</DialogTitle>
        </DialogHeader>
        {kind === 'lift' ? (
          <LiftForm user={user} onClose={onClose} onDone={onDone} />
        ) : (
          <PenaltyFields kind={kind} user={user} reportId={reportId} initialReason={initialReason} onClose={onClose} onDone={onDone} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function PenaltyFields({
  kind,
  user,
  reportId,
  initialReason,
  onClose,
  onDone,
}: {
  kind: AdminPenaltyKind;
  user: AdminUserDetail;
  reportId?: string | undefined;
  initialReason?: ModerationReason | undefined;
  onClose: () => void;
  onDone: (result: ActionResult) => void;
}) {
  const { t, locale } = useI18n();
  const id = useId();
  const reasons = useReasons(kind !== 'shadowban');
  const language = personLocale(user.locale);
  const [form, setForm] = useState<PenaltyForm>({
    reason: initialReason ?? '',
    message: '',
    until: kind === 'suspend' ? '' : 'permanent',
    date: '',
    note: '',
  });
  const [edited, setEdited] = useState(false);
  const [openedAt] = useState(() => Date.now());
  const { me } = useSession();
  // A ban can also refuse what the person signs in with (device keys, phone, Google account).
  const offerDeviceBan = kind === 'ban' && can(me, 'moderation.device_bans');
  const [alsoDevices, setAlsoDevices] = useState(false);
  // Until the admin edits it, the message is the reason's text in the person's language (it follows the reason).
  const message = edited ? form.message : prefilledMessage(reasons.data, form.reason, language);
  const current: PenaltyForm = { ...form, message };
  const [problems, setProblems] = useState<PenaltyProblems>({});
  const [busy, setBusy] = useState(false);
  const name = user.name ?? user.id;
  const destructive = kind !== 'warn';

  function clearProblem(key: keyof PenaltyProblems) {
    setProblems((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  function chooseReason(reason: ModerationReason | '') {
    setForm((current) => ({ ...current, reason }));
    clearProblem('reason');
  }

  /**
   * After the ban: its devices, phone and Google account for the same period, tied to the ban (lifting it or
   * overturning its appeal removes them); a failure leaves the ban as it is and says so.
   */
  async function banDevices(actionId: string, endsAt: string | undefined) {
    const reason = form.note.trim() || t(`reason.moderation.${form.reason}` as MessageKey);
    try {
      await apiRequest('/v1/admin/device-bans', {
        method: 'POST',
        body: {
          from: 'user',
          user: user.id,
          kinds: ['device', 'phone', 'google'],
          reason: reason.slice(0, 500),
          forAction: actionId,
          ...(endsAt ? { expiresAt: endsAt } : {}),
        },
      });
    } catch (error) {
      const failure = asApiError(error);
      if (failure.errors[0]?.code !== 'nothing_to_ban') showToast((t) => t('action.alsoBan.failed'), 'error', 6_000);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const now = Date.now();
    const found = penaltyProblems(kind, current, now);
    setProblems(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    try {
      const body = penaltyBody(kind, current, now, reportId);
      const result = await apiRequest<ActionResult>(`/v1/admin/users/${user.id}/${kind}`, { method: 'POST', body });
      if (offerDeviceBan && alsoDevices) await banDevices(result.action.id, typeof body.endsAt === 'string' ? body.endsAt : undefined);
      onDone(result);
    } catch (error) {
      const failure = asApiError(error);
      const code = failure.errors[0]?.code;
      if (code === 'ends_in_past' || code === 'ends_too_far') setProblems({ [endField(form)]: 'action.error.untilPast' });
      else if (code === 'unknown_report' || code === 'not_this_user') showToast((t) => t('action.error.report'), 'error', 6_000);
      else showToast((t) => problemText(failure, t), 'error', 6_000);
    } finally {
      setBusy(false);
    }
  }

  const until = endOf(form.until, form.date, openedAt);
  const endsOn = until.endsAt ? t('moderation.until', { date: formatDate(until.endsAt, locale) }) : undefined;
  // The message's "required" goes once it has text (a reason chosen after the first try pre-fills it).
  const messageProblem = problems.message && message.trim() === '' ? t(problems.message) : undefined;
  return (
    <form className="grid gap-5" onSubmit={(event) => void submit(event)} noValidate>
      <Field id={`${id}-reason`} label={t('action.reason')} error={problems.reason ? t(problems.reason) : undefined}>
        {(control) => (
          <NativeSelect {...control} value={form.reason} onChange={(event) => chooseReason(event.target.value as ModerationReason | '')}>
            <option value="">{t('form.choose')}</option>
            {moderationReasons.map((reason) => (
              <option key={reason} value={reason}>
                {t(`reason.moderation.${reason}` as MessageKey)}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      {kind !== 'shadowban' && (
        <Field
          id={`${id}-message`}
          label={
            <span className="flex w-full items-center gap-2">
              {t('action.message', { name })}
              <Badge variant="muted">{languageName(language, locale)}</Badge>
              <span className="ms-auto text-xs font-normal text-muted-foreground tabular-nums">{t('form.counter', { count: message.length, max: MESSAGE_MAX })}</span>
            </span>
          }
          error={messageProblem}
        >
          {(control) => (
            <Textarea
              {...control}
              dir={language === 'fa' ? 'rtl' : 'ltr'}
              lang={language}
              rows={4}
              maxLength={MESSAGE_MAX}
              value={message}
              onChange={(event) => {
                setEdited(true);
                setForm({ ...form, message: event.target.value });
                clearProblem('message');
              }}
            />
          )}
        </Field>
      )}
      {kind !== 'warn' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={`${id}-until`} label={t('action.until')} error={problems.until ? t(problems.until) : undefined}>
            {(control) => (
              <NativeSelect
                {...control}
                value={form.until}
                onChange={(event) => {
                  setForm({
                    ...form,
                    until: event.target.value as UntilChoice,
                  });
                  clearProblem('until');
                  clearProblem('date');
                }}
              >
                {kind === 'suspend' ? <option value="">{t('form.choose')}</option> : <option value="permanent">{t('action.permanent')}</option>}
                {untilPresets.map((preset) => (
                  <option key={preset} value={preset}>
                    {t(`action.preset.${preset}` as MessageKey)}
                  </option>
                ))}
                <option value="date">{t('action.preset.date')}</option>
              </NativeSelect>
            )}
          </Field>
          {form.until === 'date' ? (
            // The end in the panel's calendar under the native (Gregorian) picker.
            <Field id={`${id}-date`} label={t('action.date')} hint={endsOn} error={problems.date ? t(problems.date) : undefined}>
              {(control) => (
                <Input
                  {...control}
                  type="date"
                  dir="ltr"
                  value={form.date}
                  onChange={(event) => {
                    setForm({ ...form, date: event.target.value });
                    clearProblem('date');
                  }}
                />
              )}
            </Field>
          ) : (
            endsOn && <p className="self-end pb-2 text-sm text-muted-foreground">{endsOn}</p>
          )}
        </div>
      )}
      <Field id={`${id}-note`} label={t('action.note')} optional={t('form.optional')}>
        {(control) => <Textarea {...control} rows={2} maxLength={NOTE_MAX} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />}
      </Field>
      {offerDeviceBan && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-primary" checked={alsoDevices} onChange={(event) => setAlsoDevices(event.target.checked)} />
          {t('action.alsoBan')}
        </label>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" variant={destructive ? 'destructive' : 'default'} disabled={busy}>
          {busy ? t('common.saving') : t(submits[kind])}
        </Button>
      </DialogFooter>
    </form>
  );
}

function LiftForm({ user, onClose, onDone }: { user: AdminUserDetail; onClose: () => void; onDone: (result: ActionResult) => void }) {
  const { t, locale } = useI18n();
  const id = useId();
  const standing = user.standing;
  const [actionId, setActionId] = useState(standing[0]?.id ?? '');
  // The route's `reasonText`: kept on the lift record only (no route the person reads returns a lift).
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !actionId) return;
    setBusy(true);
    try {
      const body = message.trim() ? { actionId, reasonText: message.trim() } : { actionId };
      onDone(
        await apiRequest<ActionResult>(`/v1/admin/users/${user.id}/lift`, {
          method: 'POST',
          body,
        }),
      );
    } catch (error) {
      showToast((t) => problemText(asApiError(error), t), 'error', 6_000);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="grid gap-5" onSubmit={(event) => void submit(event)} noValidate>
      {standing.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('action.lift.none')}</p>
      ) : (
        <fieldset className="grid gap-2">
          <legend className="mb-2 text-sm font-medium">{t('action.lift.which')}</legend>
          {standing.map((action) => (
            <label key={action.id} className="flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm has-checked:border-primary has-checked:bg-primary/5">
              <input type="radio" name={`${id}-action`} value={action.id} checked={actionId === action.id} onChange={() => setActionId(action.id)} className="accent-primary" />
              <span className="font-medium">{t(`kind.action.${action.kind}` as MessageKey)}</span>
              <span className="text-muted-foreground">{t(reasonLabel(action))}</span>
              <span className="ms-auto text-xs text-muted-foreground">{standingPeriod(action, t, locale)}</span>
            </label>
          ))}
        </fieldset>
      )}
      {standing.length > 0 && (
        <Field id={`${id}-note`} label={t('action.note')} optional={t('form.optional')}>
          {(control) => <Textarea {...control} dir="auto" rows={2} maxLength={MESSAGE_MAX} value={message} onChange={(event) => setMessage(event.target.value)} />}
        </Field>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={busy || standing.length === 0}>
          {busy ? t('common.saving') : t('action.submit.lift')}
        </Button>
      </DialogFooter>
    </form>
  );
}
