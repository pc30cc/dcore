import { LogOut, Monitor, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Field } from '@/components/form/Field';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadError, TableSkeleton } from '@/components/QueryState';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ConfirmDialog } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/i18n/useI18n';
import { passwordProblem } from '@/lib/admins';
import { apiRequest } from '@/lib/api';
import { logout } from '@/lib/auth';
import { asApiError } from '@/lib/http';
import { formatDateTime } from '@/lib/format';
import { problemText } from '@/lib/problemText';
import { queryClient, queryKeys, useSessions, type AdminSession } from '@/lib/queries';
import { showToast } from '@/lib/toast';
import { useSession } from '@/lib/useSession';

/** `/me/security`: the signed-in admin's sessions (sign out one, or everywhere) and their password. */
export function SecurityPage() {
  const { t, locale } = useI18n();
  const { me } = useSession();
  const sessions = useSessions();
  const [confirmAll, setConfirmAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  async function revoke(session: AdminSession) {
    setBusy(session.id);
    try {
      await apiRequest<undefined>(`/v1/admin/me/sessions/${session.id}`, { method: 'DELETE' });
      queryClient.setQueryData<{ items: AdminSession[] }>(queryKeys.sessions, (data) => (data ? { items: data.items.filter((item) => item.id !== session.id) } : data));
      showToast(t('security.sessions.revoked'));
    } catch (error) {
      showToast(problemText(asApiError(error), t), 'error');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto grid max-w-4xl gap-6">
      <PageHeader icon={ShieldCheck} title={t('account.security')} description={me ? t('security.intro', { email: me.email }) : undefined} />

      <Card>
        <CardHeader>
          <CardTitle>{t('security.sessions.title')}</CardTitle>
          <CardDescription>{t('security.sessions.body')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {sessions.isPending && <TableSkeleton rows={2} />}
          {sessions.isError && <LoadError error={sessions.error} onRetry={() => void sessions.refetch()} />}
          {sessions.data && (
            <ul className="divide-y rounded-lg border">
              {sessions.data.items.map((session) => (
                <li key={session.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <Monitor className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <div className="grid min-w-0 flex-1 gap-0.5">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <span className="truncate" dir="ltr">
                        {session.userAgent ? summarizeAgent(session.userAgent) : t('security.sessions.unknownDevice')}
                      </span>
                      {session.current && <Badge variant="success">{t('security.sessions.current')}</Badge>}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t('security.sessions.meta', { ip: session.ip ?? '—', seen: formatDateTime(session.refreshedAt, locale), since: formatDateTime(session.createdAt, locale) })}
                    </span>
                  </div>
                  {!session.current && (
                    <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void revoke(session)}>
                      {busy === session.id ? t('common.saving') : t('security.sessions.revoke')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div>
            <Button variant="outline" onClick={() => setConfirmAll(true)}>
              <LogOut aria-hidden="true" />
              {t('security.sessions.all')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <PasswordCard email={me?.email ?? ''} />

      <ConfirmDialog
        open={confirmAll}
        onOpenChange={setConfirmAll}
        title={t('security.sessions.all.title')}
        description={<p>{t('security.sessions.all.body')}</p>}
        confirmLabel={t('security.sessions.all')}
        destructive
        onConfirm={() => void logout(true)}
      />
    </div>
  );
}

/** "Chrome on macOS" from a user agent, or the agent cut short. */
function summarizeAgent(agent: string): string {
  const has = (part: string) => agent.includes(part);
  const browser = has('Edg/') ? 'Edge' : has('Firefox/') ? 'Firefox' : has('Chrome/') ? 'Chrome' : has('Safari/') ? 'Safari' : null;
  const system = has('Windows') ? 'Windows' : has('Android') ? 'Android' : has('iPhone') || has('iPad') ? 'iOS' : has('Mac OS X') ? 'macOS' : has('Linux') ? 'Linux' : null;
  if (browser && system) return `${browser} · ${system}`;
  return agent.length > 60 ? `${agent.slice(0, 57)}…` : agent;
}

function PasswordCard({ email }: { email: string }) {
  const { t } = useI18n();
  const baseId = useId();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [wrongCurrent, setWrongCurrent] = useState(false);
  const [saving, setSaving] = useState(false);
  const nextProblem = attempted ? passwordProblem(next, email) : null;
  const repeatProblem = attempted && repeat !== next ? 'security.password.mismatch' : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setAttempted(true);
    setNotice(null);
    setWrongCurrent(false);
    if (current === '' || passwordProblem(next, email) || repeat !== next) return;
    setSaving(true);
    try {
      await apiRequest<undefined>('/v1/admin/me/password', { method: 'PUT', body: { currentPassword: current, newPassword: next } });
      setCurrent('');
      setNext('');
      setRepeat('');
      setAttempted(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      showToast(t('security.password.saved'));
    } catch (error) {
      const failure = asApiError(error);
      if (failure.errors.some((issue) => issue.pointer === '/currentPassword')) setWrongCurrent(true);
      else setNotice(failure.errors.some((issue) => issue.pointer === '/newPassword') ? t('admins.error.passwordShort', { min: 12 }) : problemText(failure, t));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('security.password.title')}</CardTitle>
        <CardDescription>{t('security.password.body')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid max-w-md gap-4" noValidate onSubmit={(event) => void submit(event)}>
          <fieldset disabled={saving} className="grid gap-4">
            <Field
              id={`${baseId}-current`}
              label={t('security.password.current')}
              error={wrongCurrent ? t('security.password.wrong') : attempted && current === '' ? t('form.required') : undefined}
            >
              {(control) => <Input {...control} type="password" dir="ltr" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} />}
            </Field>
            <Field id={`${baseId}-new`} label={t('security.password.new')} hint={t('admins.password.rule')} error={nextProblem ? t(nextProblem, { min: 12 }) : undefined}>
              {(control) => <Input {...control} type="password" dir="ltr" autoComplete="new-password" value={next} onChange={(event) => setNext(event.target.value)} />}
            </Field>
            <Field id={`${baseId}-repeat`} label={t('security.password.repeat')} error={repeatProblem ? t(repeatProblem) : undefined}>
              {(control) => <Input {...control} type="password" dir="ltr" autoComplete="new-password" value={repeat} onChange={(event) => setRepeat(event.target.value)} />}
            </Field>
          </fieldset>
          {notice && (
            <Alert variant="destructive">
              <TriangleAlert aria-hidden="true" />
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          )}
          <div>
            <Button type="submit" disabled={saving}>
              {saving ? t('common.saving') : t('security.password.save')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
