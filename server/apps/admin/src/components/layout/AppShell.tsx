import { Menu, TriangleAlert, X } from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n/useI18n';
import { brand } from '@/lib/brand';
import { sections } from '@/lib/sections';
import { cn } from '@/lib/utils';
import { Preferences } from './Preferences';

/**
 * The panel's frame: a sidebar on the reading-start side (left in English,
 * right in Persian, through logical properties only) and a header with the
 * language and theme pickers. On small screens the sidebar is a drawer.
 */
export function AppShell() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  const nav = (
    <nav aria-label={t('nav.label')} className="flex flex-col gap-1 p-3">
      {sections.map(({ path, label, icon: Icon }) => (
        <NavLink
          key={path}
          to={`/${path}`}
          end={path === ''}
          onClick={() => setOpen(false)}
          className={({ isActive }) =>
            cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground/80 outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50',
              isActive && 'bg-sidebar-accent text-sidebar-accent-foreground',
            )
          }
        >
          <Icon className="size-4 shrink-0" aria-hidden="true" />
          {t(label)}
        </NavLink>
      ))}
    </nav>
  );

  return (
    <div className="flex min-h-dvh">
      <aside className="hidden w-60 shrink-0 border-e border-sidebar-border bg-sidebar lg:block">
        <div className="flex h-14 items-center border-b border-sidebar-border px-6 font-semibold">{brand.shortName}</div>
        {nav}
      </aside>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button type="button" aria-label={t('nav.close')} className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 start-0 w-64 border-e border-sidebar-border bg-sidebar shadow-xl">
            <div className="flex h-14 items-center justify-between border-b border-sidebar-border ps-6 pe-2 font-semibold">
              {brand.shortName}
              <Button variant="ghost" size="icon" onClick={() => setOpen(false)} aria-label={t('nav.close')}>
                <X aria-hidden="true" />
              </Button>
            </div>
            {nav}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-3 border-b px-4 lg:px-6">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setOpen(true)} aria-label={t('nav.open')}>
            <Menu aria-hidden="true" />
          </Button>
          <span className="truncate font-semibold">{t('app.title')}</span>
          <Preferences className="ms-auto" />
        </header>
        <main className="flex-1 p-4 lg:p-8">
          {import.meta.env.DEV && (
            <Alert variant="warning" className="mb-6">
              <TriangleAlert aria-hidden="true" />
              <AlertDescription>{t('shell.devNotice')}</AlertDescription>
            </Alert>
          )}
          <Outlet />
        </main>
      </div>
    </div>
  );
}
