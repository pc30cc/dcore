import { PUBLIC_UID_PATTERN, type AdminUserRef } from '@app/shared';
import { Field } from '@/components/form/Field';
import { UserRef } from '@/components/UserRef';
import { Input } from '@/components/ui/input';
import type { MessageKey } from '@/i18n/messages';
import { useI18n } from '@/i18n/useI18n';
import { personId } from '@/lib/grants';
import { ApiError } from '@/lib/http';
import { useUser } from '@/lib/queries';
import { can } from '@/lib/session';
import { useSession } from '@/lib/useSession';

/**
 * The person a gift is for: fixed (opened from their page), or a public id
 * typed here. A typed id is read back (their name and photo, with
 * users.read) once it has the shape of one, so the admin sees who it is
 * before giving anything; an unknown one says so at the field.
 */
export function PersonField({ id, fixed, value, onChange, error }: { id: string; fixed: AdminUserRef | null; value: string; onChange: (value: string) => void; error?: MessageKey | undefined }) {
  const { t } = useI18n();
  const { me } = useSession();
  const typed = personId(value);
  const valid = PUBLIC_UID_PATTERN.test(typed);
  const lookup = useUser(typed, !fixed && valid && can(me, 'users.read'));
  const unknown = lookup.error instanceof ApiError && lookup.error.status === 404;
  if (fixed) {
    return (
      <div className="grid gap-2">
        <span className="text-sm font-medium">{t('purchases.col.person')}</span>
        <UserRef user={fixed} link={false} />
      </div>
    );
  }
  const problem = error ?? (unknown ? 'grantDialog.person.unknown' : value.trim() !== '' && !valid && typed.length >= 13 ? 'grantDialog.person.invalid' : undefined);
  return (
    <Field id={id} label={t('grantDialog.person')} error={problem ? t(problem) : undefined}>
      {(control) => (
        <div className="grid gap-2">
          <Input {...control} dir="ltr" className="font-mono" autoComplete="off" spellCheck={false} maxLength={40} value={value} onChange={(event) => onChange(event.target.value)} />
          {lookup.data && !unknown && <UserRef user={lookup.data} link={false} />}
        </div>
      )}
    </Field>
  );
}
