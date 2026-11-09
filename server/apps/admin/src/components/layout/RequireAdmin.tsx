import type { Permission } from '@app/shared';
import { Lock, RefreshCw, TriangleAlert } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useI18n } from '@/i18n/useI18n';
import { startSession } from '@/lib/auth';
import { asApiError } from '@/lib/http';
import { can, isOwner } from '@/lib/session';
import { useSession } from '@/lib/useSession';

/**
 * Guards the panel: nothing renders until an admin is signed in. On a fresh
 * page the refresh cookie is tried once; without a session the sign-in page
 * opens (and comes back here afterwards). A session that ends while the
 * panel is open says so on the sign-in page.
 */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const session = useSession();
  const location = useLocation();
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (session.status !== 'unknown') return;
    startSession().catch((error: unknown) => setFailure(asApiError(error).code));
  }, [session.status, attempt]);

  const from = `${location.pathname}${location.search}`;
  if (session.status === 'signedOut') return <Navigate to="/login" replace state={session.byUser ? { notice: 'signedOut' } : { from }} />;
  if (session.status === 'expired') return <Navigate to="/login" replace state={{ from, expired: true }} />;
  if (session.status === 'signedIn') return children;

  if (failure) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>{t('session.unreachable.title')}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <Alert variant="destructive">
              <TriangleAlert aria-hidden="true" />
              <AlertDescription>{failure === 'not_configured' ? t('common.error.notConfigured') : t('common.error.unreachable')}</AlertDescription>
            </Alert>
            <Button
              onClick={() => {
                setFailure(null);
                setAttempt(attempt + 1);
              }}
            >
              <RefreshCw aria-hidden="true" />
              {t('common.retry')}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center p-4" role="status" aria-live="polite">
      <span className="flex items-center gap-3 text-sm text-muted-foreground">
        <span className="size-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-primary" aria-hidden="true" />
        {t('session.checking')}
      </span>
    </div>
  );
}

/** A page the admin's roles do not reach: says so (the API refuses it too). */
export function RequirePermission({ permission, owner = false, children }: { permission?: Permission; owner?: boolean; children: ReactNode }) {
  const { t } = useI18n();
  const { me } = useSession();
  const allowed = owner ? isOwner(me) : permission ? can(me, permission) : true;
  if (allowed) return children;
  return (
    <div className="mx-auto grid max-w-xl gap-6 py-10">
      <Alert>
        <Lock aria-hidden="true" />
        <AlertTitle>{t('access.denied.title')}</AlertTitle>
        <AlertDescription>{t('access.denied.body')}</AlertDescription>
      </Alert>
    </div>
  );
}
