import { LayoutGrid, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n/useI18n';
import { brand } from '@/lib/brand';
import { cn } from '@/lib/utils';
import { Preferences } from './Preferences';

/**
 * The frame of the sign-in steps: the brand's side (its colour and name,
 * nothing else) and the step's card, with the language and theme pickers.
 * On a phone only the card shows.
 */
export function AuthLayout({ step, total, children }: { step: number; total: number; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <aside className="relative hidden overflow-hidden bg-primary text-primary-foreground lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -end-32 -top-32 size-[28rem] rounded-full bg-primary-foreground/10 blur-3xl"
        />
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-40 -start-24 size-[26rem] rounded-full bg-black/10 blur-3xl" />
        <div className="relative flex items-center gap-3 text-lg font-semibold">
          <span className="flex size-10 items-center justify-center rounded-xl bg-primary-foreground/15">
            <LayoutGrid className="size-5" aria-hidden="true" />
          </span>
          {brand.shortName}
        </div>
        <div className="relative grid max-w-md gap-4">
          <h2 className="text-3xl leading-tight font-semibold">{t('auth.aside.title')}</h2>
          <p className="text-base leading-relaxed text-primary-foreground/80">{t('auth.aside.body')}</p>
        </div>
        <p className="relative flex items-center gap-2 text-sm text-primary-foreground/80">
          <ShieldCheck className="size-4" aria-hidden="true" />
          {t('auth.aside.audit')}
        </p>
      </aside>

      <main className="flex flex-col bg-muted/30">
        <div className="flex items-center justify-between gap-4 p-4 lg:p-6">
          <span className="font-semibold lg:invisible">{brand.shortName}</span>
          <Preferences />
        </div>
        <div className="flex flex-1 items-center justify-center p-4 pb-16">
          <div className="grid w-full max-w-md gap-6">
            <ol className="flex items-center gap-2" aria-label={t('auth.steps', { step, total })}>
              {Array.from({ length: total }, (_, index) => (
                <li
                  key={index}
                  aria-current={index + 1 === step ? 'step' : undefined}
                  className={cn('h-1.5 flex-1 rounded-full bg-border', index + 1 <= step && 'bg-primary')}
                />
              ))}
            </ol>
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
