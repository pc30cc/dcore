import { Copy } from 'lucide-react';
import { useI18n } from '@/i18n/useI18n';
import { showToast } from '@/lib/toast';

/** A machine id (left to right, mono) that copies itself on a click. */
export function CopyId({ value, truncate = false }: { value: string; truncate?: boolean }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      dir="ltr"
      onClick={() => void navigator.clipboard?.writeText(value).then(() => showToast((t) => t('common.copied')))}
      className="inline-flex max-w-full min-w-0 items-center gap-1 rounded font-mono text-xs text-muted-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      aria-label={`${t('user.copyId')} ${value}`}
      title={truncate ? value : undefined}
    >
      {truncate ? <span className="max-w-[9ch] truncate">{value}</span> : value}
      <Copy className="size-3" aria-hidden="true" />
    </button>
  );
}
