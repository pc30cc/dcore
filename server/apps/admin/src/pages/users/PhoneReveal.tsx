import type { AdminUserDetail } from '@app/shared';
import { Copy, Eye } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n/useI18n';
import { apiRequest } from '@/lib/api';
import { asApiError } from '@/lib/http';
import { problemText } from '@/lib/problemText';
import { queryClient } from '@/lib/queries';
import { showToast } from '@/lib/toast';

/** The number on file, read through the audited route on request; kept in this component's state only (never the URL or the cache). */
export function PhoneReveal({ user }: { user: AdminUserDetail }) {
  const { t } = useI18n();
  const [phone, setPhone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function reveal() {
    setBusy(true);
    try {
      setPhone((await apiRequest<{ phone: string }>(`/v1/admin/users/${user.id}/reveal-phone`, { method: 'POST' })).phone);
      void queryClient.invalidateQueries({
        queryKey: ['user', user.id, 'audit'],
      });
    } catch (error) {
      const failure = asApiError(error);
      showToast((t, lang) => (failure.code === 'not_found' ? t('user.phone.none') : problemText(failure, t, lang)), 'error', 6_000);
    } finally {
      setBusy(false);
    }
  }
  if (phone === null) {
    return (
      <Button variant="outline" size="sm" className="h-7" onClick={() => void reveal()} disabled={busy}>
        <Eye aria-hidden="true" />
        {t('user.phone.show')}
      </Button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      <span dir="ltr" className="font-mono">
        {phone}
      </span>
      <Button variant="ghost" size="icon" className="size-7" aria-label={t('user.phone.copy')} onClick={() => void navigator.clipboard?.writeText(phone).then(() => showToast((t) => t('common.copied')))}>
        <Copy aria-hidden="true" />
      </Button>
    </span>
  );
}
