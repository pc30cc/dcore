import { KeyRound, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Link, Navigate } from 'react-router';
import { CodeInput } from '@/components/auth/CodeInput';
import { AuthLayout } from '@/components/layout/AuthLayout';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { useI18n } from '@/i18n/useI18n';
import { verifyCode } from '@/lib/auth';
import { pendingSignIn } from '@/lib/signIn';
import { useCodeStep } from './useCodeStep';

/** Sign-in, second step: the 6-digit code of the admin's authenticator app. */
export function TotpPage() {
  const [ticket] = useState(() => pendingSignIn());
  if (!ticket) return <Navigate to="/login" replace state={{ notice: 'ticket' }} />;
  if (ticket.enrollRequired) return <Navigate to="/login/enroll" replace />;
  return <TotpStep ticket={ticket} />;
}

function TotpStep({ ticket }: { ticket: NonNullable<ReturnType<typeof pendingSignIn>> }) {
  const { t } = useI18n();
  const step = useCodeStep(ticket, verifyCode);
  return (
    <AuthLayout step={2} total={2}>
      <Card className="gap-5 shadow-md">
        <CardHeader>
          <div className="mb-2 flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <KeyRound className="size-5" aria-hidden="true" />
          </div>
          <CardTitle className="text-xl" role="heading" aria-level={1}>{t('totp.title')}</CardTitle>
          <CardDescription>{t('totp.subtitle', { email: ticket.email })}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void step.submit();
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="otp">{t('totp.code')}</Label>
              <CodeInput id="otp" autoFocus value={step.code} onValueChange={step.change} disabled={step.busy} aria-invalid={Boolean(step.problem)} />
            </div>
            {step.problem && (
              <Alert variant="destructive">
                <TriangleAlert aria-hidden="true" />
                <AlertDescription>{step.problem}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" size="lg" className="w-full" disabled={step.busy}>
              {step.busy ? t('totp.checking') : t('totp.submit')}
            </Button>
            <p className="text-xs leading-relaxed text-muted-foreground">{t('totp.lostDevice')}</p>
            <Button asChild variant="link" className="h-auto justify-self-center p-0">
              <Link to="/login" replace>
                {t('totp.otherAccount')}
              </Link>
            </Button>
          </form>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
