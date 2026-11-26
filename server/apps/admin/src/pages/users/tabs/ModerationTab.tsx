import type { AdminAction, AdminUserDetail } from '@app/shared';
import { LoadError, TableSkeleton } from '@/components/QueryState';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { MessageKey } from '@/i18n/messages';
import { useI18n } from '@/i18n/useI18n';
import { formatDate, formatDateTime } from '@/lib/format';
import { useUserPages } from '@/lib/queries';
import { LIFT_DEFAULT_TEXT, actionTone, reasonLabel, reasonlessKinds, textPartsOf } from '@/lib/users';

/** Every moderation record of the person, newest first: the shadowban and internal notes included. */
export function ModerationTab({ user }: { user: AdminUserDetail }) {
  const { t } = useI18n();
  const pages = useUserPages<AdminAction>(user.id, 'moderation', `/v1/admin/users/${user.id}/moderation`);
  if (pages.isPending) return <TableSkeleton rows={3} />;
  if (pages.isError) return <LoadError error={pages.error} onRetry={() => void pages.refetch()} />;
  const items = pages.data.pages.flatMap((page) => page.items);
  if (items.length === 0) return <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('moderation.empty')}</p>;
  return (
    <div className="grid gap-3">
      <ul className="grid divide-y rounded-xl border bg-card">
        {items.map((action) => (
          <ActionRow key={action.id} action={action} />
        ))}
      </ul>
      {pages.hasNextPage && (
        <div className="text-center">
          <Button variant="outline" size="sm" onClick={() => void pages.fetchNextPage()} disabled={pages.isFetchingNextPage}>
            {t('common.loadMore')}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * One record. What the person read (a warning's, suspension's or ban's
 * text) is in a box; a text rejection names its parts in words (its note is
 * written by the server); a lift's text is internal (empty for a caller
 * without moderation.read); a sign-out or a device ban has no reason of its own.
 */
export function ActionRow({ action }: { action: AdminAction }) {
  const { t, locale } = useI18n();
  const by = action.admin ? t('moderation.by', { name: action.admin.displayName }) : t('common.automatic');
  const parts = action.kind === 'text_rejected' && action.note ? textPartsOf(action.note, t) : null;
  // A lift's text comes empty to a caller without moderation.read (it is internal).
  const note = parts ? null : action.kind === 'lift' ? (action.reasonText && action.reasonText !== LIFT_DEFAULT_TEXT ? action.reasonText : null) : action.note;
  return (
    <li className="grid gap-2 p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={actionTone[action.kind] ?? 'secondary'}>{t(`kind.action.${action.kind}` as MessageKey)}</Badge>
        {!reasonlessKinds.has(action.kind) && <span className="font-medium">{t(reasonLabel(action))}</span>}
        {action.standing && <Badge variant="outline">{t('moderation.standing')}</Badge>}
        <span className="ms-auto text-xs text-muted-foreground">{formatDateTime(action.startsAt, locale)}</span>
      </div>
      {(action.kind === 'warning' || action.kind === 'suspension' || action.kind === 'ban') && (
        <p dir="auto" className="rounded-md bg-muted/50 px-3 py-2 whitespace-pre-wrap">
          {action.reasonText}
        </p>
      )}
      {parts && (
        <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
          <span className="font-medium">{t('texts.parts')}:</span>
          {parts.map((part) => (
            <Badge key={part} variant="outline">
              {part}
            </Badge>
          ))}
        </div>
      )}
      {note && (
        <p className="whitespace-pre-wrap text-muted-foreground">
          <span className="font-medium">{t('moderation.note')}: </span>
          <bdi>{note}</bdi>
        </p>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>{by}</span>
        {(action.kind === 'suspension' || action.kind === 'ban' || action.kind === 'shadowban') && (
          <span>
            {action.endsAt
              ? t('moderation.until', {
                  date: formatDate(action.endsAt, locale),
                })
              : t('common.permanent')}
          </span>
        )}
        {action.revokedAt && (
          <span>
            {action.revokedBy
              ? t('moderation.liftedBy', {
                  date: formatDate(action.revokedAt, locale),
                  name: action.revokedBy.displayName,
                })
              : t('moderation.lifted', {
                  date: formatDate(action.revokedAt, locale),
                })}
          </span>
        )}
      </div>
      {action.appeal && (
        <div className="grid gap-1 rounded-lg border-s-2 border-primary/40 bg-muted/40 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2 text-xs font-medium">
            {t('moderation.appeal')}
            <Badge variant={action.appeal.status === 'open' ? 'warning' : action.appeal.status === 'overturned' ? 'success' : 'muted'}>{t(`appealStatus.${action.appeal.status}` as MessageKey)}</Badge>
          </div>
          <p dir="auto" className="whitespace-pre-wrap">
            {action.appeal.body}
          </p>
          {action.appeal.decisionText && (
            <p className="whitespace-pre-wrap text-muted-foreground">
              <span className="font-medium">{t('moderation.decision')}: </span>
              <bdi>{action.appeal.decisionText}</bdi>
            </p>
          )}
        </div>
      )}
    </li>
  );
}
