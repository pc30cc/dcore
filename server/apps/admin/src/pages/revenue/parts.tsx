import type { AdminUserRef } from '@app/shared';
import { UserRef } from '@/components/UserRef';
import { StatusDot } from '@/components/ui/badge';
import { useI18n } from '@/i18n/useI18n';
import { localized } from '@/lib/format';
import { purchaseStateTone, type PurchaseState } from '@/lib/purchases';
import { usePlans } from '@/lib/queries';
import { can } from '@/lib/session';
import { useSession } from '@/lib/useSession';
import { cn } from '@/lib/utils';

/**
 * Small views the revenue pages and the person's purchases and wallet tabs
 * share: a plan by its name, a person (or no account), a purchase's state.
 */

/** A plan by its name in the panel's language with its key under it; the key alone without billing.read or for a plan the catalogue lacks. */
export function PlanName({ planKey, inline = false }: { planKey: string; inline?: boolean }) {
  const { locale } = useI18n();
  const { me } = useSession();
  const plans = usePlans(can(me, 'billing.read'));
  const plan = plans.data?.items.find((item) => item.key === planKey);
  if (!plan) {
    return (
      <span dir="ltr" className="font-mono text-xs">
        {planKey}
      </span>
    );
  }
  const name = localized(plan.names, locale, plan.key);
  if (inline) return <bdi className="font-medium">{name}</bdi>;
  return (
    <span className="grid justify-items-start gap-0.5">
      <span className="text-sm font-medium">{name}</span>
      <span dir="ltr" className="font-mono text-xs text-muted-foreground">
        {plan.key}
      </span>
    </span>
  );
}

/**
 * A person (photo, name, public id, their page), a deleted account (no page
 * to open), or no account at all ("—" when `compact`: a list's state says it).
 */
export function PersonCell({ user, wrap = false, state, compact = false }: { user: AdminUserRef | null; wrap?: boolean; state?: unknown; compact?: boolean }) {
  const { t } = useI18n();
  if (!user) return <span className="text-sm text-muted-foreground">{compact ? t('common.none') : t('purchases.unclaimed')}</span>;
  if (user.status === 'purged') {
    return (
      <span className="grid justify-items-start">
        <span className="text-sm text-muted-foreground">{t('chats.deletedAccount')}</span>
        <span dir="ltr" className="font-mono text-xs text-muted-foreground">
          {user.id}
        </span>
      </span>
    );
  }
  return <UserRef user={user} wrap={wrap} state={state} />;
}

export function PurchaseStateDot({ state, className }: { state: PurchaseState; className?: string }) {
  const { t } = useI18n();
  return (
    <StatusDot tone={purchaseStateTone[state]} className={cn(className)}>
      {t(`purchaseState.${state}`)}
    </StatusDot>
  );
}
