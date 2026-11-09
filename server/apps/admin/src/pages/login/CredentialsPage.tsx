import { Eye, EyeOff, Info, TriangleAlert } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { AuthLayout } from '@/components/layout/AuthLayout';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useI18n } from '@/i18n/useI18n';
import { login, startSession } from '@/lib/auth';
import { asApiError } from '@/lib/http';
import { safeReturnPath, startPendingSignIn } from '@/lib/signIn';
import { useSession } from '@/lib/useSession';
import { signInProblem } from './authErrors';

interface LoginState {
  from?: unknown;
  expired?: unknown;
  notice?: unknown;
}

/**
 * Sign-in, first step: work e-mail and password. Every refusal reads the
 * same (the API never says whether an e-mail exists); five failed attempts
 * lock the account for 15 minutes, which the message says up front.
 */
export function CredentialsPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const session = useSession();
  const state = (location.state ?? {}) as LoginState;
  const returnTo = safeReturnPath(state.from);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // A refresh cookie from an earlier visit signs in without the form (the guard does the same for other pages).
  useEffect(() => {
    if (session.status === 'unknown') startSession().catch(() => undefined);
  }, [session.status]);

  if (session.status === 'signedIn') return <Navigate to={returnTo} replace />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (email.trim() === '' || password === '') {
      setProblem(t('login.error.missing'));
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const result = await login(email, password);
      startPendingSignIn({ mfaToken: result.mfaToken, enrollRequired: result.enrollRequired, expiresAtMs: Date.parse(result.expiresAt), email: email.trim(), returnTo });
      setPassword('');
      await navigate(result.enrollRequired ? '/login/enroll' : '/login/totp');
    } catch (error) {
      const found = signInProblem(asApiError(error), 'password');
      setProblem(t(found.key, found.values));
    } finally {
      setBusy(false);
    }
  }

  const notice =
    state.notice === 'signedOut' ? t('login.notice.signedOut') : state.notice === 'ticket' ? t('login.error.ticket') : state.notice === 'locked' ? t('login.error.locked') : null;

  return (
    <AuthLayout step={1} total={2}>
      <Card className="gap-5 shadow-md">
        <CardHeader>
          <CardTitle className="text-xl" role="heading" aria-level={1}>{t('login.title')}</CardTitle>
          <CardDescription>{t('login.subtitle')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {state.expired === true && (
            <Alert variant="warning">
              <Info aria-hidden="true" />
              <AlertTitle>{t('login.expired.title')}</AlertTitle>
              <AlertDescription>{t('login.expired.body')}</AlertDescription>
            </Alert>
          )}
          {notice && state.expired !== true && (
            <Alert variant={state.notice === 'locked' ? 'warning' : 'default'}>
              <Info aria-hidden="true" />
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          )}
          <form className="grid gap-4" onSubmit={(event) => void submit(event)} noValidate>
            <div className="grid gap-2">
              <Label htmlFor="email">{t('login.email')}</Label>
              <Input id="email" type="email" autoComplete="username" dir="ltr" value={email} onChange={(event) => setEmail(event.target.value)} autoFocus required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">{t('login.password')}</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={reveal ? 'text' : 'password'}
                  autoComplete="current-password"
                  dir="ltr"
                  className="pe-10"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
                <button
                  type="button"
                  onClick={() => setReveal(!reveal)}
                  aria-pressed={reveal}
                  aria-label={reveal ? t('login.password.hide') : t('login.password.show')}
                  className="absolute end-1 top-1/2 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  {reveal ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
                </button>
              </div>
            </div>
            {problem && (
              <Alert variant="destructive">
                <TriangleAlert aria-hidden="true" />
                <AlertDescription>{problem}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" size="lg" className="w-full" disabled={busy}>
              {busy ? t('login.submitting') : t('login.next')}
            </Button>
          </form>
          <p className="text-xs leading-relaxed text-muted-foreground">{t('login.lockHint')}</p>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
