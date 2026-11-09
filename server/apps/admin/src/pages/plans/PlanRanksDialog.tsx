import type { AdminPlan } from '@app/shared';
import { ArrowDown, ArrowUp, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/i18n/useI18n';
import { apiRequest } from '@/lib/api';
import { asApiError } from '@/lib/http';
import { localized } from '@/lib/format';
import { moveInOrder, rankOrder } from '@/lib/plans';
import { problemText } from '@/lib/problemText';
import { queryClient, queryKeys, type PlanList } from '@/lib/queries';
import { showToast } from '@/lib/toast';

/**
 * The upgrade order of every plan but free (the baseline), best on top:
 * which plan counts as an upgrade of which. One request sets the whole
 * order (ranks 1..n), so two plans never hold one rank on the way.
 */
export function PlanRanksDialog({ open, onOpenChange, plans }: { open: boolean; onOpenChange: (open: boolean) => void; plans: readonly AdminPlan[] }) {
  const { t, locale } = useI18n();
  const [order, setOrder] = useState(() => rankOrder(plans).map((plan) => plan.key));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const byKey = new Map(plans.map((plan) => [plan.key, plan]));
  const initial = rankOrder(plans).map((plan) => plan.key);
  const changed = order.join() !== initial.join();

  async function save() {
    setBusy(true);
    setProblem(null);
    try {
      const list = await apiRequest<PlanList>('/v1/admin/plan-ranks', { method: 'PUT', body: { order } });
      queryClient.setQueryData(queryKeys.plans, list);
      showToast(t('plans.reorder.saved'));
      onOpenChange(false);
    } catch (error) {
      setProblem(problemText(asApiError(error), t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('plans.reorder.title')}</DialogTitle>
          <DialogDescription>{t('plans.reorder.body')}</DialogDescription>
        </DialogHeader>
        <ol className="grid gap-2" aria-label={t('plans.reorder.list')}>
          {[...order].reverse().map((key, position) => {
            const index = order.length - 1 - position;
            const plan = byKey.get(key);
            const name = plan ? localized(plan.names, locale, key) : key;
            return (
              <li key={key} className="flex items-center gap-3 rounded-lg border px-3 py-2">
                <span className="w-6 text-center text-sm text-muted-foreground tabular-nums">{index + 1}</span>
                <span className="grid min-w-0 flex-1 justify-items-start">
                  <span className="truncate font-medium">{name}</span>
                  <code className="text-xs text-muted-foreground" dir="ltr">
                    {key}
                  </code>
                </span>
                {plan?.archivedAt && <Badge variant="muted">{t('plan.status.archived')}</Badge>}
                <Button variant="ghost" size="icon" disabled={position === 0 || busy} onClick={() => setOrder(moveInOrder(order, index, 1))} aria-label={t('plans.reorder.up', { name })}>
                  <ArrowUp aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={position === order.length - 1 || busy}
                  onClick={() => setOrder(moveInOrder(order, index, -1))}
                  aria-label={t('plans.reorder.down', { name })}
                >
                  <ArrowDown aria-hidden="true" />
                </Button>
              </li>
            );
          })}
        </ol>
        <p className="text-xs text-muted-foreground">{t('plans.reorder.hint')}</p>
        {problem && (
          <Alert variant="destructive">
            <TriangleAlert aria-hidden="true" />
            <AlertDescription>{problem}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void save()} disabled={busy || !changed}>
            {busy ? t('common.saving') : t('plans.reorder.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
