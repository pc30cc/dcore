import { FREE_PLAN_KEY, planFlagKeys, type AdminPlan } from '@app/shared';
import { ArrowUpDown, ChevronRight, Layers, Plus, Users } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadError, TableSkeleton } from '@/components/QueryState';
import { Badge, StatusDot } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useI18n } from '@/i18n/useI18n';
import { formatDateTime, formatNumber, localized } from '@/lib/format';
import { planStatus } from '@/lib/plans';
import { usePlans } from '@/lib/queries';
import { can } from '@/lib/session';
import { useSession } from '@/lib/useSession';
import { badgeText, statusText } from './planText';
import { PlanRanksDialog } from './PlanRanksDialog';

/**
 * Every plan: what it is called, where it stands in the upgrade order,
 * whether it is on sale, and whether anyone holds it. New plans are made
 * here; a plan is archived, never deleted.
 */
export function PlansPage() {
  const { t, locale } = useI18n();
  const { me } = useSession();
  const plans = usePlans();
  const [showArchived, setShowArchived] = useState(false);
  const [reorder, setReorder] = useState(false);
  const canWrite = can(me, 'billing.catalog');

  const items = plans.data?.items ?? [];
  const archivedCount = items.filter((plan) => plan.archivedAt !== null).length;
  const shown = items.filter((plan) => showArchived || plan.archivedAt === null);

  return (
    <div className="mx-auto grid max-w-6xl gap-6">
      <PageHeader
        icon={Layers}
        title={t('plans.title')}
        description={t('plans.intro')}
        actions={
          canWrite && (
            <>
              <Button variant="outline" onClick={() => setReorder(true)} disabled={!plans.data}>
                <ArrowUpDown aria-hidden="true" />
                {t('plans.reorder')}
              </Button>
              <Button asChild>
                <Link to="/revenue/plans/new">
                  <Plus aria-hidden="true" />
                  {t('plans.new')}
                </Link>
              </Button>
            </>
          )
        }
      />

      {plans.isError && <LoadError error={plans.error} onRetry={() => void plans.refetch()} />}

      <Card className="gap-0 overflow-hidden py-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <p className="text-sm text-muted-foreground">
            {plans.data ? t('plans.count', { count: formatNumber(items.length - archivedCount, locale), archived: formatNumber(archivedCount, locale) }) : t('common.loading')}
          </p>
          {archivedCount > 0 && (
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={showArchived} onCheckedChange={setShowArchived} aria-label={t('plans.showArchived')} />
              {t('plans.showArchived')}
            </label>
          )}
        </div>
        {plans.isPending ? (
          <TableSkeleton />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('plans.col.plan')}</TableHead>
                <TableHead>{t('plans.col.rank')}</TableHead>
                <TableHead>{t('plans.col.status')}</TableHead>
                <TableHead>{t('plans.col.features')}</TableHead>
                <TableHead>{t('plans.col.holders')}</TableHead>
                <TableHead>{t('plans.col.updated')}</TableHead>
                <TableHead>
                  <span className="sr-only">{t('common.actions')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((plan) => (
                <PlanRow key={plan.key} plan={plan} />
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {plans.data && reorder && <PlanRanksDialog open={reorder} onOpenChange={setReorder} plans={plans.data.items} />}
    </div>
  );
}

function PlanRow({ plan }: { plan: AdminPlan }) {
  const { t, locale } = useI18n();
  const status = statusText[planStatus(plan)];
  const on = planFlagKeys.filter((key) => plan.features[key]).length;
  const name = localized(plan.names, locale, plan.key);
  return (
    <TableRow className={plan.archivedAt !== null ? 'opacity-60' : undefined}>
      <TableCell>
        <Link to={`/revenue/plans/${plan.key}`} className="group grid justify-items-start gap-0.5 outline-none">
          <span className="flex items-center gap-2 font-medium group-hover:underline group-focus-visible:underline">
            {name}
            {plan.badge && <Badge variant="secondary">{t(badgeText[plan.badge])}</Badge>}
          </span>
          <code className="text-xs text-muted-foreground" dir="ltr">
            {plan.key}
          </code>
        </Link>
      </TableCell>
      <TableCell className="tabular-nums">{plan.key === FREE_PLAN_KEY ? <span className="text-muted-foreground">{t('plans.baseline')}</span> : formatNumber(plan.rank, locale)}</TableCell>
      <TableCell>
        <StatusDot tone={status.tone}>{t(status.label)}</StatusDot>
      </TableCell>
      <TableCell className="text-muted-foreground tabular-nums">{t('plans.featuresOn', { on: formatNumber(on, locale), total: formatNumber(planFlagKeys.length, locale) })}</TableCell>
      <TableCell>
        {plan.hasLiveSubscriptions ? (
          <span className="inline-flex items-center gap-1.5 text-sm">
            <Users className="size-4 text-muted-foreground" aria-hidden="true" />
            {t('plans.holders.yes')}
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">{t('plans.holders.none')}</span>
        )}
      </TableCell>
      <TableCell className="text-sm whitespace-nowrap text-muted-foreground">{formatDateTime(plan.updatedAt, locale)}</TableCell>
      <TableCell className="text-end">
        <Button asChild variant="ghost" size="sm">
          <Link to={`/revenue/plans/${plan.key}`} aria-label={t('plans.editNamed', { name })}>
            {t('common.edit')}
            <ChevronRight className="rtl:rotate-180" aria-hidden="true" />
          </Link>
        </Button>
      </TableCell>
    </TableRow>
  );
}
