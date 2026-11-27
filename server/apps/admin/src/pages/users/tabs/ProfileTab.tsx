import type { AdminUserDetail, TextState } from '@app/shared';
import { Check, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { TextDecisionDialog, type TextDecision } from '@/components/moderation/TextDecisionDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { MessageKey } from '@/i18n/messages';
import { useI18n } from '@/i18n/useI18n';
import { apiRequest } from '@/lib/api';
import { formatDate, formatNumber, languageName, localized, regionName } from '@/lib/format';
import { asApiError } from '@/lib/http';
import { problemText } from '@/lib/problemText';
import { queryClient, queryKeys } from '@/lib/queries';
import { can } from '@/lib/session';
import { showToast } from '@/lib/toast';
import { useSession } from '@/lib/useSession';
import { actionTone, reasonLabel, savedToast, standingPeriod } from '@/lib/users';
import { PhoneReveal } from '../PhoneReveal';
import { SectionCard } from '../SectionCard';
import { PhotosTab } from './PhotosTab';

const stateVariant: Readonly<Record<TextState, 'success' | 'warning' | 'destructive'>> = { checking: 'warning', approved: 'success', rejected: 'destructive' };

function StateBadge({ state }: { state: TextState }) {
  const { t } = useI18n();
  return <Badge variant={stateVariant[state]}>{t(`textState.${state}` as MessageKey)}</Badge>;
}

/** The profile tab: the texts with their states and decisions, the photos, and the account's details. */
export function ProfileTab({ user }: { user: AdminUserDetail }) {
  const { t, locale } = useI18n();
  const { me } = useSession();
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const profile = user.profile;
  // The parts a decision can be made on: about and job, and the written answers (a voice answer is not a text).
  const hasText = profile !== null && (profile.about !== null || profile.job !== null || profile.prompts.some((p) => p.answer !== null));
  const canDecide = can(me, 'moderation.decide') && hasText && user.status !== 'deleted';
  const waiting = profile !== null && (profile.textState === 'checking' || profile.prompts.some((p) => p.status === 'checking'));
  const promptLabel = (prompt: { position: number; question: Partial<Record<string, string>> }) => localized(prompt.question, locale, t('texts.part.prompt', { n: prompt.position + 1 }));

  function decided(result: TextDecision, done: MessageKey) {
    for (const key of [queryKeys.user(user.id), ['user', user.id, 'moderation'], ['user', user.id, 'audit']]) void queryClient.invalidateQueries({ queryKey: key });
    savedToast(result.sideEffects, done);
  }

  async function approve() {
    if (!profile || busy) return;
    setBusy(true);
    try {
      decided(await apiRequest<TextDecision>(`/v1/admin/moderation/texts/${user.id}/approve`, { method: 'POST', body: { version: profile.version } }), 'texts.approved');
    } catch (error) {
      const failure = asApiError(error);
      if (failure.code === 'conflict') {
        showToast((t) => t('texts.stale'), 'error', 6_000);
        void queryClient.invalidateQueries({
          queryKey: queryKeys.user(user.id),
        });
      } else showToast((t) => problemText(failure, t), 'error', 6_000);
    } finally {
      setBusy(false);
    }
  }

  // On a narrow screen the side column dissolves into the page's column, and what stands comes first.
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="grid min-w-0 content-start gap-6">
        <SectionCard
          title={t('user.section.texts')}
          actions={
            canDecide && (
              <>
                <Button size="sm" variant="outline" onClick={() => void approve()} disabled={busy || !waiting}>
                  <Check aria-hidden="true" />
                  {t('texts.approve')}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setRejecting(true)} disabled={busy}>
                  <X aria-hidden="true" />
                  {t('texts.reject')}
                </Button>
              </>
            )
          }
        >
          {profile === null ? (
            <p className="text-sm text-muted-foreground">{t('user.noProfile')}</p>
          ) : profile.about === null && profile.job === null && profile.prompts.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('user.noTexts')}</p>
          ) : (
            <dl className="grid gap-4">
              <TextPart label={t('user.field.about')} state={profile.textState} reason={profile.textRejectReason}>
                {profile.about}
              </TextPart>
              <TextPart label={t('user.field.job')} state={profile.textState} reason={profile.textRejectReason}>
                {profile.job}
              </TextPart>
              {profile.prompts.map((prompt) => (
                <TextPart key={prompt.position} label={promptLabel(prompt)} state={prompt.status} reason={prompt.rejectReason}>
                  {prompt.answer ?? <span className="text-muted-foreground italic">{t('user.voiceAnswer')}</span>}
                </TextPart>
              ))}
            </dl>
          )}
        </SectionCard>
        <SectionCard title={t('user.section.photos')}>
          <PhotosTab user={user} />
        </SectionCard>
      </div>
      <div className="contents lg:grid lg:content-start lg:gap-6">
        {user.standing.length > 0 && (
          <div className="order-first lg:order-none">
            <SectionCard title={t('user.section.standing')}>
              <ul className="grid gap-2 text-sm">
                {user.standing.map((action) => (
                  <li key={action.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Badge variant={actionTone[action.kind] ?? 'secondary'}>{t(`kind.action.${action.kind}` as MessageKey)}</Badge>
                    <span>{t(reasonLabel(action))}</span>
                    <span className="ms-auto text-xs text-muted-foreground">{standingPeriod(action, t, locale)}</span>
                  </li>
                ))}
              </ul>
            </SectionCard>
          </div>
        )}
        <SectionCard title={t('user.section.details')}>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-sm">
            <Detail label={t('user.field.gender')}>{user.gender ? t(`gender.${user.gender}` as MessageKey) : t('common.none')}</Detail>
            <Detail label={t('user.field.birthDate')}>{user.birthDate ? formatDate(`${user.birthDate}T12:00:00.000Z`, locale) : t('common.none')}</Detail>
            {profile?.intention && <Detail label={t('user.field.intention')}>{t(`intention.${profile.intention}` as MessageKey)}</Detail>}
            <Detail label={t('users.col.country')}>{user.country ? regionName(user.country, locale) : t('common.none')}</Detail>
            <Detail label={t('user.field.locale')}>
              {languageName(user.locale, locale)}{' '}
              <span dir="ltr" className="font-mono text-xs text-muted-foreground">
                {user.locale}
              </span>
            </Detail>
            <Detail label={t('users.col.joined')}>{formatDate(user.createdAt, locale)}</Detail>
            <Detail label={t('users.col.lastActive')}>{user.lastActiveOn ? formatDate(`${user.lastActiveOn}T12:00:00.000Z`, locale) : t('common.none')}</Detail>
            {profile && (
              <Detail label={t('user.field.completeness')}>
                {t('user.percent', {
                  value: formatNumber(profile.completeness, locale),
                })}
              </Detail>
            )}
            <Detail label={t('user.field.signIn')}>{[user.phoneOnFile && t('user.signIn.phone'), user.googleOnFile && t('user.signIn.google')].filter(Boolean).join(' · ') || t('common.none')}</Detail>
            {user.phoneOnFile && can(me, 'users.view_phone') && (
              <Detail label={t('user.signIn.phone')}>
                <PhoneReveal user={user} />
              </Detail>
            )}
            <Detail label={t('user.field.openReports')}>{user.openReports.more ? `${formatNumber(20, locale)}+` : formatNumber(user.openReports.count, locale)}</Detail>
          </dl>
        </SectionCard>
      </div>
      {rejecting && profile && (
        <TextDecisionDialog
          parts={{
            publicUid: user.id,
            name: user.name ?? user.id,
            version: profile.version,
            profile: {
              present: profile.about !== null || profile.job !== null,
              waiting: profile.textState === 'checking',
              state: profile.textState,
            },
            prompts: profile.prompts.map((p) => ({
              position: p.position,
              label: promptLabel(p),
              hasText: p.answer !== null,
              waiting: p.status === 'checking',
              state: p.status,
            })),
          }}
          onClose={() => setRejecting(false)}
          onStale={() => {
            setRejecting(false);
            void queryClient.invalidateQueries({
              queryKey: queryKeys.user(user.id),
            });
          }}
          onDone={(result) => {
            setRejecting(false);
            decided(result, 'texts.rejected');
          }}
        />
      )}
    </div>
  );
}

function TextPart({ label, state, reason, children }: { label: string; state: TextState; reason?: string | undefined; children: ReactNode }) {
  const { t } = useI18n();
  if (children === null || children === undefined) return null;
  return (
    <div className="grid gap-1.5">
      <dt className="flex flex-wrap items-center gap-2 text-sm font-medium">
        <span dir="auto">{label}</span>
        <StateBadge state={state} />
        {state === 'rejected' && reason && <span className="text-xs text-destructive">{t(`reason.text.${reason}` as MessageKey)}</span>}
      </dt>
      <dd dir="auto" className="rounded-md bg-muted/50 px-3 py-2 text-sm whitespace-pre-wrap text-foreground/90">
        {children}
      </dd>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate">{children}</dd>
    </>
  );
}
