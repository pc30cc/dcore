import { ADMIN_PASSWORD_MAX, ADMIN_PASSWORD_MIN, adminEmailSchema, isPermission, permissionCatalog, type AdminAccount, type PermissionInfo } from '@app/shared';
import type { MessageKey } from '@/i18n/messages';
import { hasMessage, type Translate } from '@/i18n/translate';

/** The admins screen's rules, checked before anything is sent (the API checks them again). */

export interface NewAdminForm {
  email: string;
  displayName: string;
  roles: string[];
  /** Empty: the API makes one and shows it once. */
  password: string;
}

export type NewAdminErrors = Partial<Record<keyof NewAdminForm, MessageKey>>;

export function passwordProblem(password: string, email: string): MessageKey | null {
  const length = [...password.normalize('NFKC')].length;
  if (length < ADMIN_PASSWORD_MIN) return 'admins.error.passwordShort';
  if (length > ADMIN_PASSWORD_MAX) return 'admins.error.passwordLong';
  if (email.trim() !== '' && password.normalize('NFKC').trim().toLowerCase() === email.trim().toLowerCase()) return 'admins.error.passwordEmail';
  return null;
}

export function validateNewAdmin(form: NewAdminForm): NewAdminErrors {
  const errors: NewAdminErrors = {};
  if (!adminEmailSchema.safeParse(form.email).success) errors.email = 'admins.error.email';
  const name = form.displayName.trim();
  if (name === '') errors.displayName = 'form.required';
  else if (name.length > 80) errors.displayName = 'admins.error.nameLong';
  if (form.roles.length === 0) errors.roles = 'admins.error.roles';
  if (form.password !== '') {
    const problem = passwordProblem(form.password, form.email);
    if (problem) errors.password = problem;
  }
  return errors;
}

export type AdminState = 'active' | 'locked' | 'disabled' | 'pending';

/** Where an account stands: disabled, locked after failed attempts, waiting for its authenticator, or active. */
export function adminState(admin: AdminAccount, now: number): AdminState {
  if (admin.disabledAt !== null) return 'disabled';
  if (admin.lockedUntil !== null && Date.parse(admin.lockedUntil) > now) return 'locked';
  if (!admin.totpEnabled) return 'pending';
  return 'active';
}

/**
 * A role's name in the panel's language: the panel's own words for the
 * roles the database seeds (`role.<key>`, the owner role is "Owner"), the
 * names stored with a role made later (this language, else Persian, else
 * English), else its key.
 */
export function roleName(role: { key: string; names: Record<string, string> } | undefined, key: string, locale: string, t: Translate): string {
  const own = `role.${key}`;
  if (hasMessage(own)) return t(own);
  return role?.names[locale] || role?.names.fa || role?.names.en || key;
}

/** A permission's name in the panel's language (the code for one this build has no words for). */
export function permissionLabel(permission: string, t: Translate): string {
  return isPermission(permission) ? t(`permission.${permission}`) : permission;
}

/** What a permission allows, in a sentence; null for one this build has no words for. */
export function permissionHint(permission: string, t: Translate): string | null {
  return isPermission(permission) ? t(`permission.${permission}.hint`) : null;
}

/** Whether only `*` or the permission itself grants it (never its area's wildcard). */
export function permissionRestricted(permission: string): boolean {
  return isPermission(permission) && (permissionCatalog[permission] as PermissionInfo).restricted === true;
}
