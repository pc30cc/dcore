import type { AdminPurchaseDetail } from '@app/shared';
import { ArrowLeft, ArrowRight, CircleSlash, FileX, PlugZap, Receipt, RefreshCw, Undo2, type LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { CopyId } from '@/components/CopyId';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadError, TableSkeleton } from '@/components/QueryState';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { MessageKey } from '@/i18n/messages';
import { useI18n } from '@/i18n/useI18n';
import { formatDateTime, formatNumber, regionName } from '@/lib/format';
import { ApiError } from '@/lib/http';
import { useFromList } from '@/lib/listState';
import { actionLabel, offeredButtons, usePurchase, walletUse, type PurchaseButton } from '@/lib/purchases';
import { SectionCard } from '../users/SectionCard';
import { PersonCell, PlanName, PurchaseStateDot } from './parts';
import { PurchaseActionDialog } from './PurchaseActionDialog';
import { PurchaseHistory, PurchaseTimeline } from './PurchaseTimeline';

const buttonIcon: Readonly<Record<PurchaseButton, LucideIcon>> = {
  recheck: RefreshCw,
  cancel: CircleSlash,
  refund: Undo2,
  revoke: FileX,
};

/** `/revenue/purchases/:id`: every stored field of a purchase (never its token), its store events, its admin history and the actions the store, its state and the caller's roles allow. */
export function PurchasePage() {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const purchase = usePurchase(id);
  const missing = purchase.error instanceof ApiError && (purchase.error.status === 404 || purchase.error.status === 400);
  if (purchase.data) return <PurchaseView purchase={purchase.data} />;
  return (
    <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6">
      <PageHeader
        eyebrow={<BackToPurchases store={null} />}
        icon={Receipt}
        title={missing ? t('purchase.notFound') : purchase.isPending ? <Skeleton className="h-7 w-48" aria-hidden="true" /> : t('purchases.title')}
      />
      {purchase.isPending && <TableSkeleton rows={6} />}
      {purchase.isError && !missing && <LoadError error={purchase.error} onRetry={() => void purchase.refetch()} />}
    </div>
  );
}

function BackToPurchases({ store }: { store: AdminPurchaseDetail['store'] | null }) {
  const { t, dir } = useI18n();
  const from = useFromList();
  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;
  // Opened directly: back to the purchase's own store.
  const search = from || (store === 'bazaar' ? '?store=bazaar' : '');
  return (
    <Link to={`/revenue/purchases${search}`} className="inline-flex items-center gap-1 hover:text-foreground">
      <Back className="size-4" aria-hidden="true" />
      {t('purchases.title')}
    </Link>
  );
}

function PurchaseView({ purchase }: { purchase: AdminPurchaseDetail }) {
  const { t } = useI18n();
  const [acting, setActing] = useState<PurchaseButton | null>(null);
  const buttons = offeredButtons(purchase.available);
  const wallet = walletUse(purchase);
  return (
    <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6">
      <PageHeader
        eyebrow={<BackToPurchases store={purchase.store} />}
        title={
          <span dir="ltr" className="font-mono text-xl" title={purchase.productId}>
            {purchase.productId}
          </span>
        }
        meta={
          <>
            <PurchaseStateDot state={purchase.state} />
            <Badge variant="outline">{t(`store.${purchase.store}`)}</Badge>
            <Badge variant="outline">{t(`productKind.${purchase.kind}`)}</Badge>
            {purchase.isTest && <Badge variant="secondary">{t('purchases.test')}</Badge>}
          </>
        }
        actions={
          buttons.length > 0 && (
            <>
              {buttons.map((button) => {
                const Icon = buttonIcon[button];
                return (
                  <Button key={button} variant={button === 'refund' ? 'destructive' : 'outline'} onClick={() => setActing(button)}>
                    <Icon aria-hidden="true" />
                    {t(actionLabel[button])}
                  </Button>
                );
              })}
            </>
          )
        }
      />
      {!purchase.connected && (
        <Alert>
          <PlugZap aria-hidden="true" />
          <AlertDescription>{t('purchases.storeOff')}</AlertDescription>
        </Alert>
      )}
      <Summary purchase={purchase} />
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <PurchaseTimeline purchase={purchase} />
        <div className="grid grid-cols-1 gap-6">
          {wallet && (
            <SectionCard title={t('purchase.section.wallet')}>
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Figure label={t('purchase.wallet.credited')} value={wallet.credited} />
                <Figure label={t('purchase.wallet.takenBack')} value={wallet.takenBack} />
                {wallet.used !== null && <Figure label={t('purchase.wallet.used')} value={wallet.used} tone="warning" />}
              </dl>
            </SectionCard>
          )}
          <PurchaseHistory history={purchase.history} />
        </div>
      </div>
      {acting && <PurchaseActionDialog key={acting} purchase={purchase} action={acting} onClose={() => setActing(null)} />}
    </div>
  );
}

function Figure({ label, value, tone }: { label: string; value: number; tone?: 'warning' }) {
  const { locale } = useI18n();
  return (
    <div className="grid gap-0.5 rounded-lg border px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={tone === 'warning' ? 'text-xl font-semibold text-amber-700 tabular-nums dark:text-amber-300' : 'text-xl font-semibold tabular-nums'}>{formatNumber(value, locale)}</dd>
    </div>
  );
}

function Summary({ purchase }: { purchase: AdminPurchaseDetail }) {
  const { t, locale } = useI18n();
  const none = t('common.none');
  const day = (iso: string | null) => (iso ? formatDateTime(iso, locale) : none);
  const yesNo = (value: boolean | null) => (value === null ? none : value ? t('common.yes') : t('common.no'));
  const rows: [MessageKey, ReactNode][] = [
    ['purchases.col.person', <PersonCell key="person" user={purchase.user} wrap />],
    [
      purchase.kind === 'subscription' ? 'purchases.col.plan' : 'wallet.col.item',
      purchase.kind === 'subscription' ? (
        purchase.plan ? (
          <PlanName key="plan" planKey={purchase.plan} />
        ) : (
          none
        )
      ) : purchase.item ? (
        <span key="item">
          {t(`walletItem.${purchase.item}`)}
          {purchase.grantQuantity !== null && <span className="text-muted-foreground"> {t('purchases.quantity', { count: purchase.grantQuantity * purchase.quantity })}</span>}
        </span>
      ) : (
        none
      ),
    ],
    ['purchase.field.product', <ProductLine key="product" purchase={purchase} />],
    ...(purchase.kind === 'subscription'
      ? ([
          ['purchase.field.period', purchase.period ? t(`period.${purchase.period}` as MessageKey) : none],
          ['purchases.col.renews', yesNo(purchase.autoRenew)],
          ['purchase.field.counts', yesNo(purchase.counts)],
        ] as [MessageKey, ReactNode][])
      : ([['purchases.col.quantity', formatNumber(purchase.quantity, locale)]] as [MessageKey, ReactNode][])),
    ['purchases.col.purchased', day(purchase.purchasedAt)],
    ...(purchase.kind === 'subscription' ? ([['purchases.col.expires', day(purchase.expiresAt)]] as [MessageKey, ReactNode][]) : []),
    ['purchase.field.nextCheck', day(purchase.nextCheckAt)],
    ['purchase.field.acknowledged', day(purchase.acknowledgedAt)],
    ...(purchase.kind === 'consumable'
      ? ([
          ['purchase.field.consumed', day(purchase.consumedAt)],
          ['purchase.field.credited', day(purchase.creditedAt)],
        ] as [MessageKey, ReactNode][])
      : []),
    ['purchases.col.order', purchase.orderId ? <CopyId key="order" value={purchase.orderId} /> : none],
    ['purchase.field.region', purchase.region ? regionName(purchase.region, locale) : none],
    ['purchase.field.id', <CopyId key="id" value={purchase.id} />],
    ...(purchase.replaces ? ([['purchase.field.replaces', <PurchaseLink key="replaces" id={purchase.replaces} />]] as [MessageKey, ReactNode][]) : []),
    ...(purchase.replacedBy ? ([['purchase.field.replacedBy', <PurchaseLink key="replacedBy" id={purchase.replacedBy} />]] as [MessageKey, ReactNode][]) : []),
    ['purchase.field.updated', day(purchase.updatedAt)],
  ];
  return (
    <SectionCard title={t('purchase.section.summary')}>
      <dl className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map(([label, value]) => (
          <div key={label} className="grid min-w-0 content-start gap-0.5">
            <dt className="text-xs text-muted-foreground">{t(label)}</dt>
            <dd className="min-w-0 text-sm break-words">{value}</dd>
          </div>
        ))}
      </dl>
    </SectionCard>
  );
}

function ProductLine({ purchase }: { purchase: AdminPurchaseDetail }) {
  return (
    <span className="grid justify-items-start font-mono text-xs">
      <span dir="ltr" className="break-all">
        {purchase.productId}
      </span>
      {purchase.basePlanId && (
        <span dir="ltr" className="break-all text-muted-foreground">
          {purchase.basePlanId}
        </span>
      )}
    </span>
  );
}

function PurchaseLink({ id }: { id: string }) {
  return (
    <Link to={`/revenue/purchases/${id}`} dir="ltr" className="font-mono text-xs text-primary hover:underline">
      {id}
    </Link>
  );
}
