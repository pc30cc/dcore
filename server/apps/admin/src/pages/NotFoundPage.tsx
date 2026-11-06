import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n/useI18n';

export function NotFoundPage() {
  const { t } = useI18n();
  return (
    <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-4 text-center">
      <h1 className="text-2xl font-semibold">{t('notFound.title')}</h1>
      <Button asChild variant="outline">
        <Link to="/">{t('notFound.back')}</Link>
      </Button>
    </div>
  );
}
