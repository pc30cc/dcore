import { OWNER_ROLE, type AdminAccount } from '@app/shared';
import { Ban, CircleCheck, KeyRound, MoreHorizontal, Pencil, Plus, RotateCcw, UserCog } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadError, TableSkeleton } from '@/components/QueryState';
import { ConfirmDialog } from '@/components/ui/alert-dialog';
import { Badge, StatusDot } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { MessageKey } from '@/i18n/messages';
import { useI18n } from '@/i18n/useI18n';
import { adminState, roleName, type AdminState } from '@/lib/admins';
import { apiRequest } from '@/lib/api';
import { asApiError } from '@/lib/http';
import { formatDateTime } from '@/lib/format';
import { problemText } from '@/lib/problemText';
import { queryClient, queryKeys, useAdmins, useRoles } from '@/lib/queries';
import { can } from '@/lib/session';
import { showToast } from '@/lib/toast';
import { useSession } from '@/lib/useSession';
import { CreateAdminDialog, EditAdminDialog, InitialPasswordDialog } from './AdminDialogs';

type Action = 'disable' | 'enable' | 'reset-totp' | 'reset-password';
type Open = { kind: 'create' } | { kind: 'edit'; admin: AdminAccount } | { kind: 'confirm'; admin: AdminAccount; action: Action } | { kind: 'password'; admin: AdminAccount; password: string } | null;

const stateText: Readonly<Record<AdminState, { label: MessageKey; tone: 'green' | 'amber' | 'red' | 'gray' }>> = {
  active: { label: 'admins.state.active', tone: 'green' },
  pending: { label: 'admins.state.pending', tone: 'gray' },
  locked: { label: 'admins.state.locked', tone: 'amber' },
  disabled: { label: 'admins.state.disabled', tone: 'red' },
};

const confirmText: Readonly<Record<Action, { title: MessageKey; body: MessageKey; action: MessageKey; done: MessageKey; destructive: boolean }>> = {
  disable: { title: 'admins.disable.title', body: 'admins.disable.body', action: 'admins.disable', done: 'admins.disable.done', destructive: true },
  enable: { title: 'admins.enable.title', body: 'admins.enable.body', action: 'admins.enable', done: 'admins.enable.done', destructive: false },
  'reset-totp': { title: 'admins.resetTotp.title', body: 'admins.resetTotp.body', action: 'admins.resetTotp', done: 'admins.resetTotp.done', destructive: true },
  'reset-password': { title: 'admins.resetPassword.title', body: 'admins.resetPassword.body', action: 'admins.resetPassword', done: 'admins.resetPassword.done', destructive: true },
};

/**
 * The panel's admins (owner only): who they are, their roles, whether their
 * authenticator is set up, and their state. Any change of access signs the
 * person out everywhere; at least one enabled owner always remains. Nobody
 * changes their own account here (that is My account).
 */
export function AdminsPage() {
  const { t, locale, dir } = useI18n();
  const { me } = useSession();
  const admins = useAdmins();
  const roles = useRoles();
  const [open, setOpen] = useState<Open>(null);
  const [busy, setBusy] = useState(false);
  const [now] = useState(() => Date.now());
  const canManage = can(me, 'admins.manage');
  const roleList = roles.data?.items ?? [];
  const items = admins.data?.pages.flatMap((page) => page.items) ?? [];

  function replace(admin: AdminAccount) {
    queryClient.setQueryData<typeof admins.data>(queryKeys.admins, (data) =>
      data ? { ...data, pages: data.pages.map((page) => ({ ...page, items: page.items.map((item) => (item.id === admin.id ? admin : item)) })) } : data,
    );
  }

  async function run(admin: AdminAccount, action: Action) {
    setBusy(true);
    try {
      if (action === 'reset-password') {
        const result = await apiRequest<{ admin: AdminAccount; initialPassword: string }>(`/v1/admin/admins/${admin.id}/reset-password`, { method: 'POST' });
        replace(result.admin);
        setOpen({ kind: 'password', admin: result.admin, password: result.initialPassword });
      } else {
        const saved = await apiRequest<AdminAccount>(`/v1/admin/admins/${admin.id}/${action}`, { method: 'POST' });
        replace(saved);
        setOpen(null);
      }
      showToast(t(confirmText[action].done, { name: admin.displayName }));
    } catch (error) {
      const failure = asApiError(error);
      showToast(failure.code === 'conflict' ? t('admins.error.lastOwner') : problemText(failure, t), 'error', 6_000);
      setOpen(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto grid max-w-6xl gap-6">
      <PageHeader
        icon={UserCog}
        title={t('admins.title')}
        description={t('admins.intro')}
        actions={
          canManage && (
            <Button onClick={() => setOpen({ kind: 'create' })} disabled={!roles.data}>
              <Plus aria-hidden="true" />
              {t('admins.new')}
            </Button>
          )
        }
      />
      {admins.isError && <LoadError error={admins.error} onRetry={() => void admins.refetch()} />}
      <Card className="gap-0 overflow-hidden py-0">
        {admins.isPending ? (
          <TableSkeleton />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('admins.col.admin')}</TableHead>
                <TableHead>{t('admins.roles')}</TableHead>
                <TableHead>{t('admins.col.state')}</TableHead>
                <TableHead>{t('admins.col.lastLogin')}</TableHead>
                <TableHead>
                  <span className="sr-only">{t('common.actions')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((admin) => {
                const self = admin.id === me?.id;
                const state = stateText[adminState(admin, now)];
                return (
                  <TableRow key={admin.id}>
                    <TableCell>
                      <span className="grid justify-items-start gap-0.5">
                        <span className="flex items-center gap-2 font-medium">
                          {admin.displayName}
                          {self && <Badge variant="outline">{t('admins.you')}</Badge>}
                        </span>
                        <span dir="ltr" className="text-xs text-muted-foreground">
                          {admin.email}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="flex flex-wrap gap-1.5">
                        {admin.roles.map((key) => (
                          <Badge key={key} variant={key === OWNER_ROLE ? 'default' : 'secondary'}>
                            {roleName(
                              roleList.find((role) => role.key === key),
                              key,
                              locale,
                            )}
                          </Badge>
                        ))}
                      </span>
                    </TableCell>
                    <TableCell>
                      <StatusDot tone={state.tone}>
                        {t(state.label, { until: admin.lockedUntil ? formatDateTime(admin.lockedUntil, locale) : '' })}
                      </StatusDot>
                    </TableCell>
                    <TableCell className="text-sm whitespace-nowrap text-muted-foreground">{admin.lastLoginAt ? formatDateTime(admin.lastLoginAt, locale) : t('admins.never')}</TableCell>
                    <TableCell className="text-end">
                      {canManage && !self && (
                        <DropdownMenu dir={dir}>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" aria-label={t('admins.actionsFor', { name: admin.displayName })}>
                              <MoreHorizontal aria-hidden="true" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => setOpen({ kind: 'edit', admin })} disabled={!roles.data}>
                              <Pencil aria-hidden="true" />
                              {t('admins.edit')}
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => setOpen({ kind: 'confirm', admin, action: 'reset-totp' })}>
                              <RotateCcw aria-hidden="true" />
                              {t('admins.resetTotp')}
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => setOpen({ kind: 'confirm', admin, action: 'reset-password' })}>
                              <KeyRound aria-hidden="true" />
                              {t('admins.resetPassword')}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            {admin.disabledAt === null ? (
                              <DropdownMenuItem destructive onSelect={() => setOpen({ kind: 'confirm', admin, action: 'disable' })}>
                                <Ban aria-hidden="true" />
                                {t('admins.disable')}
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem onSelect={() => setOpen({ kind: 'confirm', admin, action: 'enable' })}>
                                <CircleCheck aria-hidden="true" />
                                {t('admins.enable')}
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {admins.hasNextPage && (
          <div className="border-t p-3 text-center">
            <Button variant="outline" size="sm" onClick={() => void admins.fetchNextPage()} disabled={admins.isFetchingNextPage}>
              {t('common.loadMore')}
            </Button>
          </div>
        )}
      </Card>

      {open?.kind === 'create' && roles.data && (
        <CreateAdminDialog
          roles={roleList}
          onClose={() => setOpen(null)}
          onCreated={(admin, password) => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.admins });
            showToast(t('admins.created', { name: admin.displayName }));
            setOpen(password ? { kind: 'password', admin, password } : null);
          }}
        />
      )}
      {open?.kind === 'edit' && (
        <EditAdminDialog
          admin={open.admin}
          roles={roleList}
          onClose={() => setOpen(null)}
          onSaved={(admin) => {
            replace(admin);
            showToast(t('admins.saved', { name: admin.displayName }));
            setOpen(null);
          }}
        />
      )}
      {open?.kind === 'password' && <InitialPasswordDialog admin={open.admin} password={open.password} onClose={() => setOpen(null)} />}
      <ConfirmDialog
        open={open?.kind === 'confirm'}
        onOpenChange={(value) => !value && setOpen(null)}
        title={open?.kind === 'confirm' ? t(confirmText[open.action].title, { name: open.admin.displayName }) : ''}
        description={open?.kind === 'confirm' ? <p>{t(confirmText[open.action].body)}</p> : null}
        confirmLabel={open?.kind === 'confirm' ? t(confirmText[open.action].action) : ''}
        destructive={open?.kind === 'confirm' && confirmText[open.action].destructive}
        busy={busy}
        onConfirm={() => open?.kind === 'confirm' && void run(open.admin, open.action)}
      />
    </div>
  );
}
