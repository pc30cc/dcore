import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { useI18n } from '@/i18n/useI18n';
import { dismissToast, subscribeToasts, toastList } from '@/lib/toast';
import { cn } from '@/lib/utils';

const icons = { success: CircleCheck, error: CircleAlert, info: Info } as const;

export function Toaster() {
  const { t } = useI18n();
  const toasts = useSyncExternalStore(subscribeToasts, toastList, toastList);
  return (
    <div aria-live="polite" role="status" className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4 sm:items-end sm:pe-6">
      {toasts.map((toast) => {
        const Icon = icons[toast.tone];
        return (
          <div
            key={toast.id}
            className={cn(
              'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border bg-popover px-4 py-3 text-sm text-popover-foreground shadow-lg animate-in fade-in-0 slide-in-from-bottom-2',
            )}
          >
            <Icon className={cn('mt-0.5 size-4 shrink-0', toast.tone === 'success' && 'text-emerald-600 dark:text-emerald-400', toast.tone === 'error' && 'text-destructive')} aria-hidden="true" />
            <span className="flex-1">{toast.text}</span>
            <button type="button" onClick={() => dismissToast(toast.id)} className="text-muted-foreground hover:text-foreground" aria-label={t('common.close')}>
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
