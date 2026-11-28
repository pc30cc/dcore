import type { AdminWalletAdjustment } from '@app/shared';
import { Gift, Wallet } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadError, TableSkeleton } from '@/components/QueryState';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Segmented } from '@/components/ui/segmented';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useI18n } from '@/i18n/useI18n';
import { formatDate, formatDateTime, formatNumber } from '@/lib/format';
import { mayCorrect, mayGift, useGrants, useWalletAdjustments, type GrantFilter } from '@/lib/grants';
import { useSession } from '@/lib/useSession';
import { cn } from '@/lib/utils';
import { GrantDialog } from './GrantDialog';
import { GrantTable } from './GrantTable';
import { PersonCell } from './parts';
import { WalletAdjustDialog } from './WalletAdjustDialog';

type Tab = 'plans' | 'wallet';
const filters: readonly GrantFilter[] = ['all', 'active'];

/** `/revenue/grants`: plan days given (`?state=active`) and the wallet's admin gifts and corrections (`?tab=wallet`), with the dialogs that make them. */
export function GrantsPage() {
  const { t } = useI18n();
  const { me } = useSession();
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'wallet' ? 'wallet' : 'plans';
  const filter: GrantFilter = params.get('state') === 'active' ? 'active' : 'all';
  const [open, setOpen] = useState<'grant' | 'wallet' | null>(null);
  const gifts = mayGift(me);
  return (
    <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6">
      <PageHeader
        icon={Gift}
        title={t('grants.title')}
        actions={
          gifts && (
            <>
              <Button variant="outline" onClick={() => setOpen('wallet')}>
                <Wallet aria-hidden="true" />
                {t('walletAdjust.new')}
              </Button>
              <Button onClick={() => setOpen('grant')}>
                <Gift aria-hidden="true" />
                {t('grants.new')}
              </Button>
            </>
          )
        }
      />
      <Tabs value={tab} onValueChange={(value) => setParams(value === 'wallet' ? { tab: 'wallet' } : {}, { replace: true })}>
        <TabsList>
          <TabsTrigger value="plans">{t('grants.tab.plans')}</TabsTrigger>
          <TabsTrigger value="wallet">{t('user.tab.wallet')}</TabsTrigger>
        </TabsList>
        <TabsContent value="plans">
          {tab === 'plans' && <GrantList filter={filter} onFilter={(next) => setParams(next === 'active' ? { state: 'active' } : {}, { replace: true })} canEnd={mayCorrect(me)} />}
        </TabsContent>
        <TabsContent value="wallet">{tab === 'wallet' && <Adjustments />}</TabsContent>
      </Tabs>
      {open === 'grant' && <GrantDialog person={null} onClose={() => setOpen(null)} />}
      {open === 'wallet' && <WalletAdjustDialog person={null} onClose={() => setOpen(null)} />}
    </div>
  );
}

function GrantList({ filter, onFilter, canEnd }: { filter: GrantFilter; onFilter: (filter: GrantFilter) => void; canEnd: boolean }) {
  const { t } = useI18n();
  const grants = useGrants(filter);
  const rows = grants.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="flex items-center gap-3 border-b p-3">
        <Segmented className="w-full sm:w-auto sm:min-w-72" label={t('grants.filter.label')} value={filter} options={filters} text={(option) => t(`grants.filter.${option}`)} onChange={onFilter} />
      </div>
      {grants.isError && !grants.data ? (
        <div className="p-4">
          <LoadError error={grants.error} onRetry={() => void grants.refetch()} />
        </div>
      ) : grants.isPending ? (
        <TableSkeleton rows={6} />
      ) : rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">{filter === 'active' ? t('grants.emptyActive') : t('grants.empty')}</p>
      ) : (
        <GrantTable rows={rows} canEnd={canEnd} />
      )}
      {grants.isError && grants.data && (
        <div className="border-t p-4">
          <LoadError error={grants.error} onRetry={() => void grants.refetch()} />
        </div>
      )}
      {grants.hasNextPage && (
        <div className="border-t p-3 text-center">
          <Button variant="outline" size="sm" onClick={() => void grants.fetchNextPage()} disabled={grants.isFetchingNextPage}>
            {t('common.loadMore')}
          </Button>
        </div>
      )}
    </Card>
  );
}

function Adjustments() {
  const { t } = useI18n();
  const pages = useWalletAdjustments();
  const rows = pages.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Card className="gap-0 overflow-hidden py-0">
      {pages.isError && !pages.data ? (
        <div className="p-4">
          <LoadError error={pages.error} onRetry={() => void pages.refetch()} />
        </div>
      ) : pages.isPending ? (
        <TableSkeleton rows={6} />
      ) : rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('walletAdjust.empty')}</p>
      ) : (
        <AdjustmentTable rows={rows} />
      )}
      {pages.isError && pages.data && (
        <div className="border-t p-4">
          <LoadError error={pages.error} onRetry={() => void pages.refetch()} />
        </div>
      )}
      {pages.hasNextPage && (
        <div className="border-t p-3 text-center">
          <Button variant="outline" size="sm" onClick={() => void pages.fetchNextPage()} disabled={pages.isFetchingNextPage}>
            {t('common.loadMore')}
          </Button>
        </div>
      )}
    </Card>
  );
}

function AdjustmentTable({ rows }: { rows: readonly AdminWalletAdjustment[] }) {
  const { t, locale } = useI18n();
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>{t('purchases.col.person')}</TableHead>
          <TableHead>{t('wallet.col.item')}</TableHead>
          <TableHead>{t('wallet.col.change')}</TableHead>
          <TableHead className="hidden sm:table-cell">{t('wallet.col.after')}</TableHead>
          <TableHead className="hidden lg:table-cell">{t('walletAdjust.col.kind')}</TableHead>
          <TableHead className="hidden md:table-cell">{t('grants.col.by')}</TableHead>
          <TableHead className="hidden lg:table-cell">{t('purchase.note')}</TableHead>
          <TableHead className="hidden sm:table-cell">{t('wallet.col.when')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="max-w-56 min-w-0">
              <PersonCell user={row.user} />
            </TableCell>
            <TableCell className="text-sm">
              <span className="grid justify-items-start gap-0.5">
                <span>{t(`walletItem.${row.item}`)}</span>
                <span className="text-xs text-muted-foreground">
                  {row.store ? t(`store.${row.store}`) : t('store.admin')}
                  {/* Below lg the kind sits here (its column is hidden), and on a phone the time. */}
                  <span className="lg:hidden"> · {t(row.reason === 'gift' ? 'walletAdjust.kind.gift' : 'walletAdjust.kind.correction')}</span>
                </span>
                <span className="text-xs whitespace-nowrap text-muted-foreground sm:hidden">{formatDate(row.at, locale)}</span>
              </span>
            </TableCell>
            <TableCell className="max-w-40 text-sm">
              <span className="grid justify-items-start gap-1">
                <span dir="ltr" className={cn('tabular-nums', row.delta > 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300')}>
                  {row.delta > 0 ? `+${formatNumber(row.delta, locale)}` : formatNumber(row.delta, locale)}
                </span>
                {/* Below lg the note sits here (its column is hidden). */}
                {row.note && (
                  <p dir="auto" className="line-clamp-2 text-xs break-words text-muted-foreground lg:hidden">
                    {row.note}
                  </p>
                )}
              </span>
            </TableCell>
            <TableCell className="hidden text-sm tabular-nums sm:table-cell">{formatNumber(row.balanceAfter, locale)}</TableCell>
            <TableCell className="hidden lg:table-cell">
              <Badge variant="outline">{t(row.reason === 'gift' ? 'walletAdjust.kind.gift' : 'walletAdjust.kind.correction')}</Badge>
            </TableCell>
            <TableCell className="hidden text-sm md:table-cell">{row.admin ? <bdi>{row.admin.displayName}</bdi> : t('common.none')}</TableCell>
            <TableCell className="hidden max-w-64 lg:table-cell">
              {row.note ? (
                <p dir="auto" className="line-clamp-2 text-sm break-words text-muted-foreground" title={row.note}>
                  {row.note}
                </p>
              ) : (
                <span className="text-muted-foreground">{t('common.none')}</span>
              )}
            </TableCell>
            <TableCell className="hidden text-sm text-muted-foreground sm:table-cell">{formatDateTime(row.at, locale)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
