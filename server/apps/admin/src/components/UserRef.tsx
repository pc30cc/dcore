import type { AdminUserRef } from '@app/shared';
import { User } from 'lucide-react';
import { Link } from 'react-router';
import { useI18n } from '@/i18n/useI18n';
import { cn } from '@/lib/utils';

/** A person's photo (or a neutral icon), round. */
export function Avatar({ url, size = 32, className }: { url?: string | undefined; size?: 32 | 40 | 56; className?: string }) {
  const box = { 32: 'size-8', 40: 'size-10', 56: 'size-14' }[size];
  if (url) return <img src={url} alt="" className={cn(box, 'shrink-0 rounded-full bg-muted object-cover', className)} />;
  return (
    <span className={cn(box, 'grid shrink-0 place-items-center rounded-full bg-muted text-muted-foreground', className)} aria-hidden="true">
      <User className={size === 56 ? 'size-6' : 'size-4'} />
    </span>
  );
}

/**
 * A person as every admin list shows them: photo, name, public id; a link to
 * their page. In a list the name is cut to one line (the whole name on
 * hover); `wrap` lets a detail card show it all.
 */
export function UserRef({
  user,
  link = true,
  wrap = false,
  className,
  state,
}: {
  user: AdminUserRef;
  link?: boolean;
  wrap?: boolean;
  className?: string;
  /** The navigation's state (the list view the person's page goes back to). */
  state?: unknown;
}) {
  const { t } = useI18n();
  const name = user.name ?? t('users.noName');
  const body = (
    <span className={cn('flex min-w-0 items-center gap-3', className)}>
      <Avatar url={user.photoUrl} />
      <span className="grid min-w-0 justify-items-start">
        <span dir="auto" className={cn('max-w-full font-medium', wrap ? 'break-words' : 'truncate')} title={wrap ? undefined : name}>
          {name}
        </span>
        <span dir="ltr" className="font-mono text-xs text-muted-foreground">
          {user.id}
        </span>
      </span>
    </span>
  );
  if (!link) return body;
  return (
    <Link to={`/users/${user.id}`} state={state} className="block min-w-0 rounded-md outline-none hover:[&_.font-medium]:underline focus-visible:ring-[3px] focus-visible:ring-ring/50">
      {body}
    </Link>
  );
}
