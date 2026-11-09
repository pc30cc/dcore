import { RefreshCw, TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useI18n } from '@/i18n/useI18n';
import { asApiError } from '@/lib/http';
import { problemText } from '@/lib/problemText';

/** A list that is loading: a few grey rows. */
export function TableSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="grid gap-3 p-4" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-10 w-full" />
      ))}
    </div>
  );
}

/** A read that failed: why, and a retry. */
export function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useI18n();
  const failure = asApiError(error);
  return (
    <Alert variant="destructive">
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>{t('common.error.load')}</AlertTitle>
      <AlertDescription>
        {problemText(failure, t)}
        <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>
          <RefreshCw aria-hidden="true" />
          {t('common.retry')}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
