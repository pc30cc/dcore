import type { AdminPhotoDecision, AdminUserDetail, AdminUserPhoto, PhotoRejectReason } from '@app/shared';
import { Check, ImageOff, MoreHorizontal, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ReasonPicker } from '@/components/moderation/ReasonPicker';
import { LoadError, TableSkeleton } from '@/components/QueryState';
import { ConfirmDialog } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { MessageKey } from '@/i18n/messages';
import { useI18n } from '@/i18n/useI18n';
import { apiRequest } from '@/lib/api';
import { asApiError } from '@/lib/http';
import { photoReasons } from '@/lib/moderation';
import { problemText } from '@/lib/problemText';
import { queryClient, useUserTab } from '@/lib/queries';
import { can } from '@/lib/session';
import { showToast } from '@/lib/toast';
import { useSession } from '@/lib/useSession';
import { savedToast } from '@/lib/users';
import { cn } from '@/lib/utils';

// Over a photo the tinted badges lose their contrast (dark mode most): solid fills in both themes.
const overlayTone: Readonly<Record<AdminUserPhoto['status'], string>> = {
  processing: 'bg-zinc-800 text-white',
  review: 'bg-amber-400 text-amber-950',
  approved: 'bg-emerald-600 text-white',
  rejected: 'bg-red-600 text-white',
};

/**
 * A person's photos in every state: status, the reject reason, the
 * automatic labels; with `moderation.decide`, each photo that is not being
 * processed can be approved or rejected from its menu (a report on a live
 * photo, a rejection to undo).
 */
export function PhotosTab({ user }: { user: AdminUserDetail }) {
  const { t, dir } = useI18n();
  const { me } = useSession();
  const canDecide = can(me, 'moderation.decide') && user.status !== 'deleted';
  const photos = useUserTab<{ items: AdminUserPhoto[] }>(user.id, 'photos', `/v1/admin/users/${user.id}/photos`);
  const [rejecting, setRejecting] = useState<AdminUserPhoto | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const options = useMemo(() => photoReasons.map((name) => ({ value: name, label: t(`reason.photo.${name}` as MessageKey) })), [t]);

  async function decide(photo: AdminUserPhoto, rejectWith: PhotoRejectReason | null) {
    if (busy) return;
    setBusy(true);
    try {
      const path = `/v1/admin/moderation/photos/${photo.id}/${rejectWith ? 'reject' : 'approve'}`;
      // `from`: the state this page shows; decided elsewhere since is a 409 that keeps that decision.
      const from = photo.status;
      const result = await apiRequest<AdminPhotoDecision>(path, { method: 'POST', body: rejectWith ? { reason: rejectWith, from } : { from } });
      setRejecting(null);
      for (const tab of ['photos', 'moderation', 'audit']) void queryClient.invalidateQueries({ queryKey: ['user', user.id, tab] });
      void queryClient.invalidateQueries({ queryKey: ['photoQueue'] });
      savedToast(result.sideEffects, rejectWith ? 'photos.rejected' : 'photos.approved');
    } catch (error) {
      const failure = asApiError(error);
      showToast((t, lang) => problemText(failure, t, lang), 'error', 6_000);
      // Decided elsewhere: show the photo as it is now.
      if (failure.code === 'conflict') void queryClient.invalidateQueries({ queryKey: ['user', user.id, 'photos'] });
    } finally {
      setBusy(false);
    }
  }

  if (photos.isPending) return <TableSkeleton rows={2} />;
  if (photos.isError) return <LoadError error={photos.error} onRetry={() => void photos.refetch()} />;
  if (photos.data.items.length === 0) return <p className="py-4 text-center text-sm text-muted-foreground">{t('user.noPhotos')}</p>;
  return (
    <>
      <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        {photos.data.items.map((photo) => (
          <li key={photo.id} className="grid content-start gap-1.5">
            <div className="relative aspect-[4/5] overflow-hidden rounded-lg border bg-muted">
              {photo.thumbUrl ? (
                <img src={photo.thumbUrl} alt="" loading="lazy" className="size-full object-cover" />
              ) : (
                <span className="grid size-full place-items-center text-muted-foreground" aria-hidden="true">
                  <ImageOff className="size-6" />
                </span>
              )}
              <Badge className={cn('absolute start-1.5 top-1.5 shadow-sm ring-1 ring-black/10', overlayTone[photo.status])}>{t(`photoStatus.${photo.status}` as MessageKey)}</Badge>
              {canDecide && photo.status !== 'processing' && (
                <DropdownMenu dir={dir}>
                  <DropdownMenuTrigger asChild>
                    <Button variant="secondary" size="icon" className="absolute end-1.5 bottom-1.5 size-7 shadow-sm" aria-label={t('photos.menu')} disabled={busy}>
                      <MoreHorizontal aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {photo.status !== 'approved' && (
                      <DropdownMenuItem onSelect={() => void decide(photo, null)}>
                        <Check aria-hidden="true" />
                        {t('queue.approve')}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      destructive
                      onSelect={() => {
                        setReason('');
                        setRejecting(photo);
                      }}
                    >
                      <X aria-hidden="true" />
                      {t('queue.reject')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
            {photo.rejectReason && <span className="text-xs text-destructive">{t(`reason.photo.${photo.rejectReason}` as MessageKey)}</span>}
            {photo.modFlags.length > 0 && (
              <span className="flex flex-wrap gap-1">
                {photo.modFlags.map((flag) => (
                  <Badge key={flag} variant={flag === 'nudity' || flag === 'possible_minor' ? 'destructive' : 'outline'}>
                    {t(`modFlag.${flag}` as MessageKey)}
                  </Badge>
                ))}
              </span>
            )}
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={rejecting !== null}
        onOpenChange={(open) => !open && !busy && setRejecting(null)}
        title={t('photos.reject.title', { name: user.name ?? user.id })}
        description={null}
        confirmLabel={t('queue.reject')}
        destructive
        busy={busy}
        confirmDisabled={!reason}
        onConfirm={() => rejecting && reason && void decide(rejecting, reason as PhotoRejectReason)}
      >
        <ReasonPicker label={t('photos.reason')} options={options} value={reason} onChange={setReason} onConfirm={() => rejecting && reason && void decide(rejecting, reason as PhotoRejectReason)} />
      </ConfirmDialog>
    </>
  );
}
