import { LogOut, Menu, ShieldCheck, X } from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useI18n } from '@/i18n/useI18n';
import { logout } from '@/lib/auth';
import { brand } from '@/lib/brand';
import { sectionGroups, type Section } from '@/lib/sections';
import { can, isOwner } from '@/lib/session';
import { useSession } from '@/lib/useSession';
import { cn } from '@/lib/utils';
import { Preferences } from './Preferences';
import { Toaster } from './Toaster';

/**
 * The panel's frame: a sidebar on the reading-start side (left in English,
 * right in Persian, through logical properties only) with the sections the
 * admin's roles reach, and a header with the language and theme pickers and
 * the admin's menu. On small screens the sidebar is a drawer.
 */
export function AppShell() {
  const { t, dir } = useI18n();
  const { me } = useSession();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const visible = (item: Section) => (item.owner ? isOwner(me) : item.permission ? can(me, item.permission) : true);

  const nav = (
    <nav aria-label={t('nav.label')} className="flex flex-col gap-5 p-3">
      {sectionGroups.map((group) => {
        const items = group.items.filter(visible);
        if (items.length === 0) return null;
        return (
          <div key={group.label} className="grid gap-1">
            <div className="px-3 pb-1 text-xs font-medium text-sidebar-foreground/60">{t(group.label)}</div>
            {items.map(({ path, label, icon: Icon, spec }) => (
              <NavLink
                key={path}
                to={`/${path}`}
                end={path === '' || path === 'system'}
                onClick={() => setOpen(false)}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground/80 outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50',
                    isActive && 'bg-sidebar-accent text-sidebar-accent-foreground',
                  )
                }
              >
                <Icon className="size-4 shrink-0" aria-hidden="true" />
                <span className="flex-1 truncate">{t(label)}</span>
                {spec !== undefined && <span className="text-[10px] font-normal text-sidebar-foreground/45">{t('nav.soon')}</span>}
              </NavLink>
            ))}
          </div>
        );
      })}
    </nav>
  );

  // The guard around the shell opens the sign-in page once the session is gone.
  const signOut = () => logout();

  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 overflow-y-auto border-e border-sidebar-border bg-sidebar lg:block">
        <div className="flex h-14 items-center gap-2 border-b border-sidebar-border px-6 font-semibold">
          <span className="truncate">{brand.shortName}</span>
          <Badge variant="muted" className="font-normal">
            {t('shell.admin')}
          </Badge>
        </div>
        {nav}
      </aside>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button type="button" aria-label={t('nav.close')} className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 start-0 w-72 overflow-y-auto border-e border-sidebar-border bg-sidebar shadow-xl">
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
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-background/85 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/70 lg:px-6">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setOpen(true)} aria-label={t('nav.open')}>
            <Menu aria-hidden="true" />
          </Button>
          <span className="truncate font-semibold lg:hidden">{t('app.title')}</span>
          <div className="ms-auto flex items-center gap-2">
            <Preferences className="hidden sm:flex" />
            {me && (
              <DropdownMenu dir={dir}>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" className="h-9 gap-2 px-2" aria-label={t('account.menu')}>
                    <span className="flex size-7 items-center justify-center rounded-full bg-primary/10 text-primary">
                      <ShieldCheck className="size-4" aria-hidden="true" />
                    </span>
                    <span className="hidden max-w-40 truncate text-sm md:inline">{me.displayName}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  <DropdownMenuLabel className="grid justify-items-start gap-0.5">
                    <span className="truncate font-medium">{me.displayName}</span>
                    <span className="max-w-full truncate text-xs font-normal text-muted-foreground" dir="ltr">
                      {me.email}
                    </span>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => void navigate('/me/security')}>
                    <ShieldCheck aria-hidden="true" />
                    {t('account.security')}
                  </DropdownMenuItem>
                  <div className="px-2 py-1.5 sm:hidden">
                    <Preferences />
                  </div>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => void signOut()}>
                    <LogOut aria-hidden="true" />
                    {t('account.signOut')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </header>
        <main className="flex-1 p-4 lg:p-8">
          <Outlet />
        </main>
      </div>
      <Toaster />
    </div>
  );
}
