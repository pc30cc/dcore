import { OWNER_ROLE, type AdminAccount } from '@app/shared';
import { Check, Copy, KeyRound, TriangleAlert } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Field } from '@/components/form/Field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/i18n/useI18n';
import { roleName, validateNewAdmin, type NewAdminErrors, type NewAdminForm } from '@/lib/admins';
import { apiRequest } from '@/lib/api';
import { asApiError } from '@/lib/http';
import { problemText } from '@/lib/problemText';
import type { AdminRole } from '@/lib/queries';
import { cn } from '@/lib/utils';

/** Role check boxes, the owner role first and marked as such. */
function RolePicker({ roles, value, onChange, invalid }: { roles: readonly AdminRole[]; value: readonly string[]; onChange: (roles: string[]) => void; invalid?: boolean }) {
  const { t, locale } = useI18n();
  return (
    <div role="group" aria-label={t('admins.roles')} className={cn('grid gap-2 sm:grid-cols-2', invalid && 'rounded-lg ring-2 ring-destructive/40')}>
      {roles.map((role) => {
        const checked = value.includes(role.key);
        return (
          <label key={role.key} className={cn('flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm', checked && 'border-primary bg-primary/5')}>
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-primary"
              checked={checked}
              onChange={(event) => onChange(event.target.checked ? [...value, role.key] : value.filter((key) => key !== role.key))}
            />
            <span className="grid gap-0.5">
              <span className="font-medium">{roleName(role, role.key, locale)}</span>
              <span className="text-xs text-muted-foreground">{role.key === OWNER_ROLE ? t('admins.role.owner') : t('admins.role.permissions', { count: role.permissions.length })}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

/** A new admin: e-mail, name, roles, and a password (or one the API makes, shown once). */
export function CreateAdminDialog({ roles, onClose, onCreated }: { roles: readonly AdminRole[]; onClose: () => void; onCreated: (admin: AdminAccount, password: string | undefined) => void }) {
  const { t } = useI18n();
  const baseId = useId();
  const [form, setForm] = useState<NewAdminForm>({ email: '', displayName: '', roles: [], password: '' });
  const [attempted, setAttempted] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const errors: NewAdminErrors = attempted ? validateNewAdmin(form) : {};

  function update(patch: Partial<NewAdminForm>) {
    setForm((current) => ({ ...current, ...patch }));
    setNotice(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setAttempted(true);
    if (Object.keys(validateNewAdmin(form)).length > 0) return;
    setSaving(true);
    try {
      const body = { email: form.email.trim(), displayName: form.displayName.trim(), roles: form.roles, ...(form.password === '' ? {} : { password: form.password }) };
      const created = await apiRequest<{ admin: AdminAccount; initialPassword?: string }>('/v1/admin/admins', { method: 'POST', body });
      onCreated(created.admin, created.initialPassword);
    } catch (error) {
      const failure = asApiError(error);
      setNotice(failure.code === 'conflict' ? t('admins.error.emailTaken') : failure.errors.some((issue) => issue.pointer === '/password') ? t('admins.error.passwordShort', { min: 12 }) : problemText(failure, t));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>{t('admins.new')}</DialogTitle>
          <DialogDescription>{t('admins.new.body')}</DialogDescription>
        </DialogHeader>
        <form className="grid gap-5" noValidate onSubmit={(event) => void submit(event)}>
          <fieldset disabled={saving} className="grid min-w-0 gap-5">
            <div className="grid gap-5 sm:grid-cols-2">
              <Field id={`${baseId}-email`} label={t('login.email')} error={errors.email ? t(errors.email) : undefined}>
                {(control) => <Input {...control} type="email" dir="ltr" autoComplete="off" value={form.email} onChange={(event) => update({ email: event.target.value })} />}
              </Field>
              <Field id={`${baseId}-name`} label={t('admins.name')} error={errors.displayName ? t(errors.displayName) : undefined}>
                {(control) => <Input {...control} autoComplete="off" value={form.displayName} onChange={(event) => update({ displayName: event.target.value })} />}
              </Field>
            </div>
            <div className="grid gap-2">
              <span className="text-sm font-medium">{t('admins.roles')}</span>
              <RolePicker roles={roles} value={form.roles} onChange={(next) => update({ roles: next })} invalid={Boolean(errors.roles)} />
              {errors.roles && <p className="text-sm text-destructive">{t(errors.roles)}</p>}
            </div>
            <Field
              id={`${baseId}-password`}
              label={t('admins.password')}
              optional={t('form.optional')}
              hint={t('admins.password.hint')}
              error={errors.password ? t(errors.password, { min: 12 }) : undefined}
            >
              {(control) => <Input {...control} type="password" dir="ltr" autoComplete="new-password" value={form.password} onChange={(event) => update({ password: event.target.value })} />}
            </Field>
          </fieldset>
          {notice && (
            <Alert variant="destructive">
              <TriangleAlert aria-hidden="true" />
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? t('common.saving') : t('admins.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Name and roles of an existing admin. A change signs them out everywhere. */
export function EditAdminDialog({ admin, roles, onClose, onSaved }: { admin: AdminAccount; roles: readonly AdminRole[]; onClose: () => void; onSaved: (admin: AdminAccount) => void }) {
  const { t } = useI18n();
  const baseId = useId();
  const [displayName, setDisplayName] = useState(admin.displayName);
  const [picked, setPicked] = useState<string[]>(admin.roles);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const nameError = displayName.trim() === '' ? 'form.required' : displayName.trim().length > 80 ? 'admins.error.nameLong' : null;
  const rolesChanged = [...picked].sort().join() !== [...admin.roles].sort().join();
  const nameChanged = displayName.trim() !== admin.displayName;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (nameError || picked.length === 0) return;
    if (!rolesChanged && !nameChanged) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      const saved = await apiRequest<AdminAccount>(`/v1/admin/admins/${admin.id}`, {
        method: 'PATCH',
        body: { ...(nameChanged ? { displayName: displayName.trim() } : {}), ...(rolesChanged ? { roles: picked } : {}) },
      });
      onSaved(saved);
    } catch (error) {
      const failure = asApiError(error);
      setNotice(failure.code === 'conflict' ? t('admins.error.lastOwner') : problemText(failure, t));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>{t('admins.edit.title', { name: admin.displayName })}</DialogTitle>
          <DialogDescription>{t('admins.edit.body')}</DialogDescription>
        </DialogHeader>
        <form className="grid gap-5" noValidate onSubmit={(event) => void submit(event)}>
          <fieldset disabled={saving} className="grid min-w-0 gap-5">
            <Field id={`${baseId}-name`} label={t('admins.name')} error={nameError ? t(nameError) : undefined}>
              {(control) => <Input {...control} value={displayName} onChange={(event) => setDisplayName(event.target.value)} />}
            </Field>
            <div className="grid gap-2">
              <span className="text-sm font-medium">{t('admins.roles')}</span>
              <RolePicker roles={roles} value={picked} onChange={setPicked} invalid={picked.length === 0} />
              {picked.length === 0 && <p className="text-sm text-destructive">{t('admins.error.roles')}</p>}
              {rolesChanged && <p className="text-xs text-muted-foreground">{t('admins.edit.signOut')}</p>}
            </div>
          </fieldset>
          {notice && (
            <Alert variant="destructive">
              <TriangleAlert aria-hidden="true" />
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={saving || Boolean(nameError) || picked.length === 0}>
              {saving ? t('common.saving') : t('form.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A password made by the API: shown this once, never again. */
export function InitialPasswordDialog({ admin, password, onClose }: { admin: AdminAccount; password: string; onClose: () => void }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <div className="mb-1 flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <KeyRound className="size-5" aria-hidden="true" />
          </div>
          <DialogTitle>{t('admins.password.once.title')}</DialogTitle>
          <DialogDescription>{t('admins.password.once.body', { name: admin.displayName, email: admin.email })}</DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <code dir="ltr" className="flex min-h-10 flex-1 items-center rounded-md border bg-muted/50 px-3 font-mono text-sm break-all select-all">
            {password}
          </code>
          <Button type="button" variant="outline" size="icon" className="size-10" onClick={() => void copy()} aria-label={copied ? t('common.copied') : t('common.copy')}>
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          </Button>
        </div>
        <Alert variant="warning">
          <TriangleAlert aria-hidden="true" />
          <AlertDescription>{t('admins.password.once.warning')}</AlertDescription>
        </Alert>
        <DialogFooter>
          <Button onClick={onClose}>{t('admins.password.once.done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
