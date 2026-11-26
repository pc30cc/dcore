import { textRejectReason, type AdminTextItem, type SideEffects, type TextState } from '@app/shared';
import { useCallback, useId, useMemo, useState, type KeyboardEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { MessageKey } from '@/i18n/messages';
import { useI18n } from '@/i18n/useI18n';
import { apiRequest } from '@/lib/api';
import { asApiError } from '@/lib/http';
import { problemText } from '@/lib/problemText';
import { showToast } from '@/lib/toast';
import { ReasonPicker } from './ReasonPicker';

export interface TextDecision {
  texts: AdminTextItem;
  sideEffects: SideEffects;
}

/** What a text decision is made on: the parts as the page shows them, and the profile version read. */
export interface TextParts {
  publicUid: string;
  name: string;
  version: number;
  /** About or job is there, whether it waits, and its state now. */
  profile: { present: boolean; waiting: boolean; state: TextState };
  /** Each answer with what the page calls it (its question). */
  prompts: {
    position: number;
    label: string;
    hasText: boolean;
    waiting: boolean;
    state: TextState;
  }[];
}

/**
 * What the decision does to a part: a checked one is rejected; an unchecked
 * one that waits is approved with the decision; any other keeps its state
 * (said muted).
 */
function Outcome({ id, checked, waiting, state }: { id: string; checked: boolean; waiting: boolean; state: TextState }) {
  const { t } = useI18n();
  if (checked) return <Badge id={id} variant="destructive">{t('textState.rejected')}</Badge>;
  if (waiting) return <Badge id={id} variant="success">{t('textState.approved')}</Badge>;
  return <Badge id={id} variant="muted">{t(`textState.${state}` as MessageKey)}</Badge>;
}

/** Enter on a part does not send the form (some browsers submit implicitly from a checkbox). */
function noEnterSubmit(event: KeyboardEvent<HTMLInputElement>) {
  if (event.key === 'Enter') event.preventDefault();
}

/**
 * Rejects parts of a person's texts with one reason: the parts that wait
 * are checked first; the parts that wait and are left unchecked are
 * approved. The person reads the reason in their own language.
 */
export function TextDecisionDialog({ parts, onClose, onDone, onStale }: { parts: TextParts; onClose: () => void; onDone: (result: TextDecision) => void; onStale: () => void }) {
  const { t } = useI18n();
  const id = useId();
  const [reason, setReason] = useState('');
  const [profile, setProfile] = useState(parts.profile.present && parts.profile.waiting);
  const [prompts, setPrompts] = useState<number[]>(parts.prompts.filter((p) => p.hasText && p.waiting).map((p) => p.position));
  const [busy, setBusy] = useState(false);
  const options = useMemo(
    () =>
      textRejectReason.names.map((name) => ({
        value: name,
        label: t(`reason.text.${name}` as MessageKey),
      })),
    [t],
  );
  const nothing = !profile && prompts.length === 0;

  const submit = useCallback(async () => {
    if (busy || !reason || nothing) return;
    setBusy(true);
    try {
      const body = {
        version: parts.version,
        reason,
        profile,
        prompts: [...prompts].sort(),
      };
      onDone(await apiRequest<TextDecision>(`/v1/admin/moderation/texts/${parts.publicUid}/reject`, { method: 'POST', body }));
    } catch (error) {
      const failure = asApiError(error);
      if (failure.code === 'conflict') {
        showToast(t('texts.stale'), 'error', 6_000);
        onStale();
      } else {
        showToast(problemText(failure, t), 'error', 6_000);
      }
    } finally {
      setBusy(false);
    }
  }, [busy, reason, nothing, parts, profile, prompts, onDone, onStale, t]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('texts.reject.title', { name: parts.name })}</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          noValidate
        >
          <ReasonPicker label={t('texts.reason')} options={options} value={reason} onChange={setReason} onConfirm={() => void submit()} />
          <fieldset className="grid gap-2">
            <legend className="mb-2 text-sm font-medium">{t('texts.parts')}</legend>
            {parts.profile.present && (
              <div className="flex items-center gap-3 text-sm">
                <label className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={profile}
                    onChange={(event) => setProfile(event.target.checked)}
                    onKeyDown={noEnterSubmit}
                    aria-describedby={`${id}-outcome-profile`}
                    className="size-4 accent-primary"
                  />
                  {t('texts.part.profile')}
                </label>
                <span className="ms-auto">
                  <Outcome id={`${id}-outcome-profile`} checked={profile} waiting={parts.profile.waiting} state={parts.profile.state} />
                </span>
              </div>
            )}
            {parts.prompts
              .filter((p) => p.hasText)
              .map((p) => (
                <div key={p.position} className="flex items-center gap-3 text-sm">
                  <label className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      id={`${id}-prompt-${p.position}`}
                      checked={prompts.includes(p.position)}
                      onChange={(event) => setPrompts(event.target.checked ? [...prompts, p.position] : prompts.filter((x) => x !== p.position))}
                      onKeyDown={noEnterSubmit}
                      aria-describedby={`${id}-outcome-${p.position}`}
                      className="size-4 accent-primary"
                    />
                    <span dir="auto">{p.label}</span>
                  </label>
                  <span className="ms-auto">
                    <Outcome id={`${id}-outcome-${p.position}`} checked={prompts.includes(p.position)} waiting={p.waiting} state={p.state} />
                  </span>
                </div>
              ))}
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="destructive" disabled={busy || !reason || nothing}>
              {busy ? t('common.saving') : t('texts.reject.confirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
