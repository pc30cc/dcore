import type { AdminTotpEnrollment } from '@app/shared';
import { Check, Copy, Smartphone, TriangleAlert } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router';
import { CodeInput } from '@/components/auth/CodeInput';
import { AuthLayout } from '@/components/layout/AuthLayout';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useI18n } from '@/i18n/useI18n';
import { confirmCode, enroll } from '@/lib/auth';
import { asApiError, isAbort } from '@/lib/http';
import { groupSecret, pendingSignIn, type PendingSignIn } from '@/lib/signIn';
import { signInProblem } from './authErrors';
import { useCodeStep } from './useCodeStep';

/**
 * First sign-in: sets up the authenticator app. The API makes a secret for
 * this ticket (asked once, shown once): the QR code is drawn here, in the
 * page, from its otpauth URI (nothing is sent anywhere to draw it), with the
 * same key in groups of four for typing in by hand. The first code turns it
 * on and signs in.
 */
export function EnrollPage() {
  const [ticket] = useState(() => pendingSignIn());
  if (!ticket) return <Navigate to="/login" replace state={{ notice: 'ticket' }} />;
  if (!ticket.enrollRequired) return <Navigate to="/login/totp" replace />;
  return <EnrollStep ticket={ticket} />;
}

type Secret = { state: 'loading' } | { state: 'ready'; enrollment: AdminTotpEnrollment } | { state: 'failed'; message: string; alreadySet: boolean };

function EnrollStep({ ticket }: { ticket: PendingSignIn }) {
  const { t } = useI18n();
  const [secret, setSecret] = useState<Secret>({ state: 'loading' });
  const [copied, setCopied] = useState(false);
  const step = useCodeStep(ticket, confirmCode);

  useEffect(() => {
    let live = true;
    enroll(ticket.mfaToken).then(
      (enrollment) => {
        if (live) setSecret({ state: 'ready', enrollment });
      },
      (error: unknown) => {
        if (!live || isAbort(error)) return;
        const failure = asApiError(error);
        const found = signInProblem(failure, 'code');
        setSecret({ state: 'failed', message: t(found.key, found.values), alreadySet: failure.code === 'already_set' });
      },
    );
    return () => {
      live = false;
    };
  }, [ticket.mfaToken, t]);

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <AuthLayout step={2} total={2}>
      <Card className="gap-5 shadow-md">
        <CardHeader>
          <div className="mb-2 flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Smartphone className="size-5" aria-hidden="true" />
          </div>
          <CardTitle className="text-xl" role="heading" aria-level={1}>{t('enroll.title')}</CardTitle>
          <CardDescription>{t('enroll.subtitle')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <ol className="grid gap-1.5 text-sm text-muted-foreground">
            <li>{t('enroll.step1')}</li>
            <li>{t('enroll.step2')}</li>
            <li>{t('enroll.step3')}</li>
          </ol>

          {secret.state === 'loading' && (
            <div className="flex flex-col items-center gap-3">
              <Skeleton className="size-52 rounded-xl" />
              <Skeleton className="h-5 w-64" />
            </div>
          )}
          {secret.state === 'failed' && (
            <Alert variant="destructive">
              <TriangleAlert aria-hidden="true" />
              <AlertDescription>
                {secret.alreadySet ? t('enroll.alreadySet') : secret.message}
                <Link to={secret.alreadySet ? '/login/totp' : '/login'} replace className="font-medium underline underline-offset-4">
                  {secret.alreadySet ? t('enroll.useCode') : t('login.restart')}
                </Link>
              </AlertDescription>
            </Alert>
          )}
          {secret.state === 'ready' && (
            <div className="grid gap-4">
              <figure className="mx-auto grid justify-items-center gap-3">
                <div className="rounded-xl border bg-white p-3 shadow-sm">
                  <QRCodeSVG
                    value={secret.enrollment.otpauthUri}
                    size={192}
                    level="M"
                    marginSize={2}
                    bgColor="#FFFFFF"
                    fgColor="#000000"
                    title={t('enroll.qrLabel')}
                    role="img"
                    aria-label={t('enroll.qrLabel')}
                  />
                </div>
                <figcaption className="text-xs text-muted-foreground">{t('enroll.qrCaption')}</figcaption>
              </figure>
              <div className="grid gap-2">
                <Label htmlFor="secret">{t('enroll.manual')}</Label>
                <div className="flex gap-2">
                  <code id="secret" dir="ltr" className="flex min-h-9 flex-1 items-center rounded-md border bg-muted/50 px-3 py-1.5 font-mono text-sm tracking-wide break-normal select-all">
                    {groupSecret(secret.enrollment.secret)}
                  </code>
                  <Button type="button" variant="outline" size="icon" onClick={() => void copy(secret.enrollment.secret)} aria-label={copied ? t('common.copied') : t('enroll.copy')}>
                    {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                  </Button>
                </div>
              </div>
            </div>
          )}

          <form
            className="grid gap-4"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void step.submit();
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="otp">{t('enroll.code')}</Label>
              <CodeInput id="otp" value={step.code} onValueChange={step.change} disabled={step.busy || secret.state !== 'ready'} aria-invalid={Boolean(step.problem)} />
            </div>
            {step.problem && (
              <Alert variant="destructive">
                <TriangleAlert aria-hidden="true" />
                <AlertDescription>{step.problem}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" size="lg" className="w-full" disabled={step.busy || secret.state !== 'ready'}>
              {step.busy ? t('totp.checking') : t('enroll.submit')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
