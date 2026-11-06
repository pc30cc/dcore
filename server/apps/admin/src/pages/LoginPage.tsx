import { Info } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Preferences } from '@/components/layout/Preferences';
import { useI18n } from '@/i18n/useI18n';

/**
 * The admin sign-in screen: e-mail, password and a required second factor.
 * The API has no admin authentication
 * yet, so the form is shown disabled with that explanation; it never pretends
 * to sign anyone in.
 */
export function LoginPage() {
  const { t } = useI18n();
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">{t('login.title')}</CardTitle>
          <CardDescription>{t('login.subtitle')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Alert>
            <Info aria-hidden="true" />
            <AlertTitle>{t('login.unavailable.title')}</AlertTitle>
            <AlertDescription>{t('login.unavailable.body')}</AlertDescription>
          </Alert>
          <form className="grid gap-4" onSubmit={(event) => event.preventDefault()} aria-disabled="true">
            <fieldset disabled className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="email">{t('login.email')}</Label>
                <Input id="email" type="email" autoComplete="username" dir="ltr" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="password">{t('login.password')}</Label>
                <Input id="password" type="password" autoComplete="current-password" dir="ltr" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="otp">{t('login.otp')}</Label>
                <Input id="otp" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" dir="ltr" />
              </div>
            </fieldset>
          </form>
        </CardContent>
        <CardFooter>
          <Button className="w-full" disabled>
            {t('login.submit')}
          </Button>
        </CardFooter>
      </Card>
      <Preferences />
    </div>
  );
}
