import type { AdminUserDetail, SideEffects } from '@app/shared';
import { ArrowLeft, ArrowRight, LogOut, MoreHorizontal, Pencil, ShieldAlert, ShieldCheck, ShieldOff, Trash2, TriangleAlert, Undo2, UserX } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useFromList } from '@/lib/listState';
import { Field } from '@/components/form/Field';
import { PageHeader } from '@/components/layout/PageHeader';
import { ActionDialog, type ActionKind } from '@/components/moderation/ActionDialog';
import { LoadError, TableSkeleton } from '@/components/QueryState';
import { ConfirmDialog } from '@/components/ui/alert-dialog';
import { Badge, StatusDot } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { CopyId } from '@/components/CopyId';
import { Avatar } from '@/components/UserRef';
import type { MessageKey } from '@/i18n/messages';
import { useI18n } from '@/i18n/useI18n';
import { apiRequest } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { asApiError } from '@/lib/http';
import { problemText } from '@/lib/problemText';
import { queryClient, queryKeys, storeUser, useUser } from '@/lib/queries';
import { can, isOwner } from '@/lib/session';
import { showToast } from '@/lib/toast';
import { useSession } from '@/lib/useSession';
import { savedToast, statusTone, type UserTab } from '@/lib/users';
import { ModerationTab } from './tabs/ModerationTab';
import { AuditTab, ConsentsTab, DevicesTab, PurchasesTab, ReportsTab, SessionsTab, WalletTab } from './tabs/RecordTabs';
import { ProfileTab } from './tabs/ProfileTab';

type Open = { kind: ActionKind } | { kind: 'signOut' } | { kind: 'delete' } | { kind: 'rename' } | { kind: 'test'; on: boolean } | null;

/** `/users/:id`: a person's header, actions and tabs. While it loads or when it fails, the header keeps the way back. */
export function UserPage() {
  const { t } = useI18n();
  const { id = '' } = useParams();
  const user = useUser(id);
  if (user.isSuccess) return <UserView user={user.data} />;
  const code = user.isError ? asApiError(user.error).code : null;
  // An id the API does not know, or one that is not an id at all: nothing to retry.
  const missing = code === 'not_found' || code === 'validation_failed';
  return (
    <div className="mx-auto grid max-w-6xl gap-6">
      <PageHeader
        eyebrow={<BackToUsers />}
        title={
          missing ? (
            t('user.notFound')
          ) : (
            <span className="flex items-center gap-4" aria-hidden="true">
              <Skeleton className="size-14 rounded-full" />
              <span className="grid gap-2">
                <Skeleton className="h-6 w-48" />
                <Skeleton className="h-4 w-32" />
              </span>
            </span>
          )
        }
      />
      {user.isPending && <TableSkeleton rows={4} />}
      {user.isError && !missing && <LoadError error={user.error} onRetry={() => void user.refetch()} />}
    </div>
  );
}

function BackToUsers() {
  const { t, dir } = useI18n();
  const from = useFromList();
  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;
  return (
    <Link to={`/users${from}`} className="inline-flex items-center gap-1 hover:text-foreground">
      <Back className="size-4" aria-hidden="true" />
      {t('users.title')}
    </Link>
  );
}

function UserView({ user }: { user: AdminUserDetail }) {
  const { t, dir } = useI18n();
  const { me } = useSession();
  const [params, setParams] = useSearchParams();
  const [open, setOpenState] = useState<Open>(null);
  const [busy, setBusy] = useState(false);
  // The sign-out and delete questions share one note field: it starts empty each time one opens or closes.
  const [note, setNote] = useState('');
  const name = user.name ?? user.id;

  function setOpen(next: Open) {
    setNote('');
    setOpenState(next);
  }

  const live = user.status !== 'deleted';
  const allow = {
    warn: can(me, 'users.warn'),
    suspend: can(me, 'users.suspend'),
    ban: can(me, 'users.ban'),
    shadowban: can(me, 'users.shadowban'),
    lift: can(me, 'users.lift') && user.standing.length > 0,
    signOut: live && can(me, 'users.revoke_sessions'),
    rename: live && can(me, 'users.edit') && user.profile !== null,
    delete: live && can(me, 'users.delete'),
  };
  const penalties = live && (allow.warn || allow.suspend || allow.ban || allow.shadowban || allow.lift);
  const anyAction = penalties || allow.signOut || allow.rename || allow.delete;

  const tabs: { id: UserTab; label: MessageKey; shown: boolean }[] = [
    { id: 'profile', label: 'user.tab.profile', shown: true },
    { id: 'moderation', label: 'user.tab.moderation', shown: true },
    {
      id: 'reports',
      label: 'user.tab.reports',
      shown: can(me, 'reports.read'),
    },
    { id: 'purchases', label: 'user.tab.purchases', shown: true },
    { id: 'wallet', label: 'user.tab.wallet', shown: true },
    { id: 'devices', label: 'user.tab.devices', shown: true },
    { id: 'sessions', label: 'user.tab.sessions', shown: true },
    { id: 'consents', label: 'user.tab.consents', shown: true },
    { id: 'audit', label: 'user.tab.audit', shown: can(me, 'audit.read') },
  ];
  // A tab from the URL that this admin may not open is the profile (its content would only fail with 403).
  const raw = params.get('tab');
  const tab: UserTab = tabs.find((item) => item.id === raw && item.shown)?.id ?? 'profile';

  async function simple(path: string, body: unknown, after: (result: { user?: AdminUserDetail; sideEffects: SideEffects }) => void) {
    setBusy(true);
    try {
      after(await apiRequest<{ user?: AdminUserDetail; sideEffects: SideEffects }>(path, { method: 'POST', body }));
      setOpen(null);
    } catch (error) {
      showToast(problemText(asApiError(error), t), 'error', 6_000);
    } finally {
      setBusy(false);
    }
  }

  const noteBody = () => (note.trim() ? { note: note.trim() } : {});

  return (
    <div className="mx-auto grid max-w-6xl gap-6">
      <PageHeader
        eyebrow={<BackToUsers />}
        title={<UserTitle user={user} />}
        actions={
          <>
            {isOwner(me) && live && (
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={user.test} onCheckedChange={(checked) => setOpen({ kind: 'test', on: checked })} aria-label={t('user.testAccount')} />
                {t('user.testAccount')}
              </label>
            )}
            {anyAction && (
              <DropdownMenu dir={dir}>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline">
                    <MoreHorizontal aria-hidden="true" />
                    {t('user.actions')}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-52">
                  {live && allow.warn && <MenuItem icon={TriangleAlert} label="action.menu.warn" onSelect={() => setOpen({ kind: 'warn' })} />}
                  {live && allow.suspend && <MenuItem icon={ShieldAlert} label="action.menu.suspend" onSelect={() => setOpen({ kind: 'suspend' })} />}
                  {live && allow.ban && <MenuItem icon={ShieldOff} label="action.menu.ban" onSelect={() => setOpen({ kind: 'ban' })} />}
                  {live && allow.shadowban && <MenuItem icon={UserX} label="action.menu.shadowban" onSelect={() => setOpen({ kind: 'shadowban' })} />}
                  {live && allow.lift && <MenuItem icon={Undo2} label="action.menu.lift" onSelect={() => setOpen({ kind: 'lift' })} />}
                  {penalties && (allow.signOut || allow.rename) && <DropdownMenuSeparator />}
                  {allow.signOut && <MenuItem icon={LogOut} label="action.menu.signOut" onSelect={() => setOpen({ kind: 'signOut' })} />}
                  {allow.rename && <MenuItem icon={Pencil} label="action.menu.rename" onSelect={() => setOpen({ kind: 'rename' })} />}
                  {allow.delete && (
                    <>
                      <DropdownMenuSeparator />
                      <MenuItem icon={Trash2} label="action.menu.delete" destructive onSelect={() => setOpen({ kind: 'delete' })} />
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        }
      />

      <Tabs
        value={tab}
        onValueChange={(value) =>
          setParams(value === 'profile' ? {} : { tab: value }, {
            replace: true,
          })
        }
        dir={dir}
        className="min-w-0"
      >
        <div className="-mx-4 overflow-x-auto px-4 lg:mx-0 lg:px-0">
          <TabsList>
            {tabs
              .filter((item) => item.shown)
              .map((item) => (
                <TabsTrigger key={item.id} value={item.id}>
                  {t(item.label)}
                </TabsTrigger>
              ))}
          </TabsList>
        </div>
        <TabsContent value="profile">
          <ProfileTab user={user} />
        </TabsContent>
        <TabsContent value="moderation">{tab === 'moderation' && <ModerationTab user={user} />}</TabsContent>
        <TabsContent value="reports">{tab === 'reports' && <ReportsTab user={user} />}</TabsContent>
        <TabsContent value="purchases">{tab === 'purchases' && <PurchasesTab user={user} />}</TabsContent>
        <TabsContent value="wallet">{tab === 'wallet' && <WalletTab user={user} />}</TabsContent>
        <TabsContent value="devices">{tab === 'devices' && <DevicesTab user={user} />}</TabsContent>
        <TabsContent value="sessions">{tab === 'sessions' && <SessionsTab user={user} />}</TabsContent>
        <TabsContent value="consents">{tab === 'consents' && <ConsentsTab user={user} />}</TabsContent>
        <TabsContent value="audit">{tab === 'audit' && <AuditTab user={user} />}</TabsContent>
      </Tabs>

      {open && (open.kind === 'warn' || open.kind === 'suspend' || open.kind === 'ban' || open.kind === 'shadowban' || open.kind === 'lift') && (
        <ActionDialog
          kind={open.kind}
          user={user}
          onClose={() => setOpen(null)}
          onDone={(result) => {
            storeUser(result.user, ['moderation', 'audit']);
            savedToast(t, result.sideEffects);
            setOpen(null);
          }}
        />
      )}
      {open?.kind === 'rename' && user.profile && (
        <RenameDialog
          user={user}
          onClose={() => setOpen(null)}
          onDone={(result) => {
            storeUser(result.user, ['moderation', 'audit']);
            savedToast(t, result.sideEffects);
            setOpen(null);
          }}
        />
      )}
      <ConfirmDialog
        open={open?.kind === 'signOut' || open?.kind === 'delete'}
        onOpenChange={(value) => !value && !busy && setOpen(null)}
        title={open?.kind === 'delete' ? t('action.delete.title', { name }) : t('action.signOut.title', { name })}
        description={null}
        confirmLabel={open?.kind === 'delete' ? t('action.delete.confirm') : t('action.signOut.confirm')}
        destructive
        busy={busy}
        onConfirm={() => {
          if (open?.kind === 'delete') {
            void simple(`/v1/admin/users/${user.id}/delete`, noteBody(), (result) => {
              if (result.user) storeUser(result.user, ['moderation', 'audit', 'sessions']);
              savedToast(t, result.sideEffects);
            });
          } else {
            void simple(`/v1/admin/users/${user.id}/revoke-sessions`, noteBody(), (result) => {
              for (const stale of ['moderation', 'audit', 'sessions'])
                void queryClient.invalidateQueries({
                  queryKey: ['user', user.id, stale],
                });
              savedToast(t, result.sideEffects);
            });
          }
        }}
      >
        <NoteField value={note} onChange={setNote} />
      </ConfirmDialog>
      <ConfirmDialog
        open={open?.kind === 'test'}
        onOpenChange={(value) => !value && !busy && setOpen(null)}
        title={open?.kind === 'test' && open.on ? t('user.testAccount.onTitle', { name }) : t('user.testAccount.offTitle', { name })}
        description={null}
        confirmLabel={open?.kind === 'test' && open.on ? t('user.testAccount.on') : t('user.testAccount.off')}
        busy={busy}
        onConfirm={() =>
          open?.kind === 'test' &&
          void simple(`/v1/admin/users/${user.id}/test-account`, { test: open.on }, (result) => {
            if (result.user) storeUser(result.user, ['audit']);
            savedToast(t, result.sideEffects);
          })
        }
      />
    </div>
  );
}

function MenuItem({ icon: Icon, label, onSelect, destructive = false }: { icon: typeof Pencil; label: MessageKey; onSelect: () => void; destructive?: boolean }) {
  const { t } = useI18n();
  return (
    <DropdownMenuItem destructive={destructive} onSelect={onSelect}>
      <Icon aria-hidden="true" />
      {t(label)}
    </DropdownMenuItem>
  );
}

function NoteField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useI18n();
  const id = useId();
  return (
    <Field id={id} label={t('action.note')} optional={t('form.optional')}>
      {(control) => <Textarea {...control} rows={2} maxLength={2_000} value={value} onChange={(event) => onChange(event.target.value)} />}
    </Field>
  );
}

function UserTitle({ user }: { user: AdminUserDetail }) {
  const { t, locale } = useI18n();
  return (
    <span className="flex min-w-0 items-center gap-4">
      <Avatar url={user.photoUrl} size={56} />
      <span className="grid min-w-0 gap-1">
        <span className="truncate">
          <bdi>{user.name ?? t('users.noName')}</bdi>
        </span>
        <span className="flex flex-wrap items-center gap-2 text-sm font-normal">
          <CopyId value={user.id} />
          <StatusDot tone={statusTone[user.status]}>{t(`status.account.${user.status}` as MessageKey)}</StatusDot>
          {user.shadowbanned && <Badge variant="warning">{t('user.badge.shadowbanned')}</Badge>}
          {user.test && <Badge variant="secondary">{t('user.badge.test')}</Badge>}
          {user.verified && (
            <Badge variant="success">
              <ShieldCheck aria-hidden="true" />
              {t('user.badge.verified')}
            </Badge>
          )}
          {user.heldNow && <Badge variant="destructive">{t('user.badge.held')}</Badge>}
          {user.status === 'deleted' && user.purgeAt && (
            <Badge variant="muted">
              {t('user.badge.deleted', {
                date: formatDate(user.purgeAt, locale),
              })}
            </Badge>
          )}
        </span>
      </span>
    </span>
  );
}

/** A new display name with the reason the person reads; sent with the profile version read. */
function RenameDialog({ user, onClose, onDone }: { user: AdminUserDetail; onClose: () => void; onDone: (result: { user: AdminUserDetail; sideEffects: SideEffects }) => void }) {
  const { t } = useI18n();
  const id = useId();
  const [displayName, setDisplayName] = useState(user.profile?.name ?? '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<{ name?: string; reason?: string }>({});
  const [busy, setBusy] = useState(false);
  const name = user.name ?? user.id;
  const reasons = ['contact_details', 'offensive', 'sexual', 'commercial', 'impersonation', 'other'] as const;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = displayName.trim();
    const problems = {
      ...(trimmed ? {} : { name: t('form.required') }),
      ...(reason ? {} : { reason: t('form.required') }),
    };
    setError(problems);
    if (Object.keys(problems).length > 0 || busy || !user.profile) return;
    setBusy(true);
    try {
      onDone(
        await apiRequest(`/v1/admin/users/${user.id}/profile`, {
          method: 'PATCH',
          body: { displayName: trimmed, reason, version: user.profile.version },
        }),
      );
    } catch (failure) {
      const problem = asApiError(failure);
      if (problem.errors[0]?.code === 'name_refused') setError({ name: t('action.error.nameRefused') });
      else if (problem.code === 'conflict') {
        showToast(t('action.error.stale'), 'error', 6_000);
        void queryClient.invalidateQueries({
          queryKey: queryKeys.user(user.id),
        });
        onClose();
      } else showToast(problemText(problem, t), 'error', 6_000);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('action.rename.title', { name })}</DialogTitle>
        </DialogHeader>
        <form className="grid gap-5" onSubmit={(event) => void submit(event)} noValidate>
          <Field id={`${id}-name`} label={t('action.rename.name')} error={error.name}>
            {(control) => <Input {...control} dir="auto" maxLength={40} value={displayName} onChange={(event) => setDisplayName(event.target.value)} />}
          </Field>
          <Field id={`${id}-reason`} label={t('action.reason')} error={error.reason}>
            {(control) => (
              <NativeSelect {...control} value={reason} onChange={(event) => setReason(event.target.value)}>
                <option value="">{t('form.choose')}</option>
                {reasons.map((r) => (
                  <option key={r} value={r}>
                    {t(`reason.text.${r}` as MessageKey)}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? t('common.saving') : t('action.rename.confirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
