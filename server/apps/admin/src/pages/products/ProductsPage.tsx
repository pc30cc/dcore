import type { AdminPlan, AdminProduct, AppStore } from '@app/shared';
import { Lock, MoreHorizontal, Pencil, Plus, Power, PowerOff, ShoppingBag } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadError, TableSkeleton } from '@/components/QueryState';
import { ConfirmDialog } from '@/components/ui/alert-dialog';
import { Badge, StatusDot } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useI18n } from '@/i18n/useI18n';
import { apiRequest } from '@/lib/api';
import { asApiError } from '@/lib/http';
import { formatNumber, localized } from '@/lib/format';
import { formatPrice } from '@/lib/products';
import { problemText } from '@/lib/problemText';
import { storeProduct, usePlans, useProducts } from '@/lib/queries';
import { can } from '@/lib/session';
import { showToast } from '@/lib/toast';
import { useSession } from '@/lib/useSession';
import { badgeText } from '../plans/planText';
import { ProductDialog } from './ProductDialog';
import { itemText, periodText, storeText } from './productText';

const storeOrder: readonly AppStore[] = ['play', 'bazaar'];

type Editing = { kind: 'new' } | { kind: 'edit'; product: AdminProduct } | null;

/**
 * Store products, one tab per store: subscriptions (a plan for a period)
 * and consumable packs (wallet items). A row is listed to apps while it is
 * on and its plan is on sale; the price people pay is always the store's.
 */
export function ProductsPage() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const store: AppStore = params.get('store') === 'bazaar' ? 'bazaar' : 'play';
  return (
    <div className="mx-auto grid max-w-6xl gap-6">
      <PageHeader icon={ShoppingBag} title={t('products.title')} description={t('products.intro')} />
      <Tabs value={store} onValueChange={(value) => setParams(value === 'play' ? {} : { store: value }, { replace: true })}>
        <TabsList>
          {storeOrder.map((code) => (
            <TabsTrigger key={code} value={code}>
              {t(storeText[code])}
            </TabsTrigger>
          ))}
        </TabsList>
        {storeOrder.map((code) => (
          <TabsContent key={code} value={code}>
            {code === store && <StoreProducts store={code} />}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function StoreProducts({ store }: { store: AppStore }) {
  const { t } = useI18n();
  const { me } = useSession();
  const products = useProducts(store);
  const plans = usePlans();
  const [editing, setEditing] = useState<Editing>(null);
  const [toggle, setToggle] = useState<AdminProduct | null>(null);
  const [busy, setBusy] = useState(false);
  const canWrite = can(me, 'billing.catalog');

  if (products.isError) return <LoadError error={products.error} onRetry={() => void products.refetch()} />;
  if (plans.isError) return <LoadError error={plans.error} onRetry={() => void plans.refetch()} />;

  const items = products.data?.items ?? [];
  const subscriptions = items.filter((item) => item.kind === 'subscription');
  const consumables = items.filter((item) => item.kind === 'consumable');
  const planList = plans.data?.items ?? [];

  async function setActive(product: AdminProduct, active: boolean) {
    setBusy(true);
    try {
      const saved = await apiRequest<AdminProduct>(`/v1/admin/store-products/${product.id}/${active ? 'activate' : 'deactivate'}`, { method: 'POST' });
      storeProduct(saved);
      showToast(t(active ? 'product.activated' : 'product.deactivated', { id: saved.productId }));
    } catch (error) {
      const failure = asApiError(error);
      showToast(failure.code === 'conflict' ? t('product.error.archivedPlan') : problemText(failure, t), 'error', 6_000);
    } finally {
      setBusy(false);
      setToggle(null);
    }
  }

  const loading = products.isPending || plans.isPending;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-3xl text-sm text-muted-foreground">{store === 'play' ? t('products.store.play') : t('products.store.bazaar')}</p>
        {canWrite && (
          <Button onClick={() => setEditing({ kind: 'new' })} disabled={loading}>
            <Plus aria-hidden="true" />
            {t('products.new')}
          </Button>
        )}
      </div>

      <ProductTable
        title={t('products.subscriptions')}
        description={t('products.subscriptions.body')}
        store={store}
        kind="subscription"
        items={subscriptions}
        plans={planList}
        loading={loading}
        canWrite={canWrite}
        onEdit={(product) => setEditing({ kind: 'edit', product })}
        onToggle={setToggle}
      />
      <ProductTable
        title={t('products.consumables')}
        description={t('products.consumables.body')}
        store={store}
        kind="consumable"
        items={consumables}
        plans={planList}
        loading={loading}
        canWrite={canWrite}
        onEdit={(product) => setEditing({ kind: 'edit', product })}
        onToggle={setToggle}
      />

      {editing && plans.data && (
        <ProductDialog
          key={editing.kind === 'edit' ? `${editing.product.id}@${editing.product.updatedAt}` : 'new'}
          open
          onOpenChange={(open) => !open && setEditing(null)}
          store={store}
          plans={plans.data.items}
          {...(editing.kind === 'edit' ? { product: editing.product } : {})}
        />
      )}

      <ConfirmDialog
        open={toggle !== null}
        onOpenChange={(open) => !open && setToggle(null)}
        title={toggle?.active ? t('product.deactivate.title', { id: toggle.productId }) : t('product.activate.title', { id: toggle?.productId ?? '' })}
        description={<p>{toggle?.active ? t('product.deactivate.body') : t('product.activate.body')}</p>}
        confirmLabel={toggle?.active ? t('product.deactivate') : t('product.activate')}
        destructive={toggle?.active === true}
        busy={busy}
        onConfirm={() => toggle && void setActive(toggle, !toggle.active)}
      />
    </div>
  );
}

function ProductTable({
  title,
  description,
  store,
  kind,
  items,
  plans,
  loading,
  canWrite,
  onEdit,
  onToggle,
}: {
  title: string;
  description: string;
  store: AppStore;
  kind: AdminProduct['kind'];
  items: readonly AdminProduct[];
  plans: readonly AdminPlan[];
  loading: boolean;
  canWrite: boolean;
  onEdit: (product: AdminProduct) => void;
  onToggle: (product: AdminProduct) => void;
}) {
  const { t, locale, dir } = useI18n();
  const subscription = kind === 'subscription';
  const planName = (key: string | null) => {
    const plan = plans.find((item) => item.key === key);
    return plan ? localized(plan.names, locale, plan.key) : (key ?? '');
  };
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="border-b py-4">
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      {loading ? (
        <TableSkeleton rows={3} />
      ) : items.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('products.empty')}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>{t('product.productId')}</TableHead>
              {subscription && store === 'play' && <TableHead>{t('product.basePlanId')}</TableHead>}
              <TableHead>{subscription ? t('product.plan') : t('product.grants')}</TableHead>
              {subscription && <TableHead>{t('product.period')}</TableHead>}
              <TableHead>{t('plan.badge')}</TableHead>
              <TableHead>{t('plan.sort')}</TableHead>
              <TableHead>{t('product.listPrice')}</TableHead>
              <TableHead>{t('product.status')}</TableHead>
              <TableHead>
                <span className="sr-only">{t('common.actions')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((product) => (
              <TableRow key={product.id}>
                <TableCell>
                  <span className="flex items-center gap-2">
                    <code dir="ltr" className="text-sm font-medium">
                      {product.productId}
                    </code>
                    {product.hasPurchases && (
                      <span title={t('product.hasPurchases')} className="text-muted-foreground">
                        <Lock className="size-3.5" aria-hidden="true" />
                        <span className="sr-only">{t('product.hasPurchases')}</span>
                      </span>
                    )}
                  </span>
                </TableCell>
                {subscription && store === 'play' && (
                  <TableCell>
                    <code dir="ltr" className="text-sm text-muted-foreground">
                      {product.basePlanId}
                    </code>
                  </TableCell>
                )}
                <TableCell>
                  {subscription ? (
                    <span className="grid justify-items-start">
                      <span>{planName(product.plan)}</span>
                      <code dir="ltr" className="text-xs text-muted-foreground">
                        {product.plan}
                      </code>
                    </span>
                  ) : (
                    <span className="tabular-nums">
                      {product.item ? t(itemText[product.item]) : '—'} × {formatNumber(product.quantity ?? 0, locale)}
                    </span>
                  )}
                </TableCell>
                {subscription && <TableCell className="whitespace-nowrap">{product.period && product.period in periodText ? t(periodText[product.period as keyof typeof periodText]) : product.period}</TableCell>}
                <TableCell>{product.badge ? <Badge variant="secondary">{t(badgeText[product.badge])}</Badge> : <span className="text-muted-foreground">—</span>}</TableCell>
                <TableCell className="tabular-nums">{formatNumber(product.sort, locale)}</TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">{product.listPrice ? formatPrice(product.listPrice, locale) : <span className="text-muted-foreground">—</span>}</TableCell>
                <TableCell>
                  <StatusDot tone={product.active ? 'green' : 'gray'}>{product.active ? t('product.on') : t('product.off')}</StatusDot>
                </TableCell>
                <TableCell className="text-end">
                  {canWrite && (
                    <DropdownMenu dir={dir}>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" aria-label={t('product.actionsFor', { id: product.productId })}>
                          <MoreHorizontal aria-hidden="true" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => onEdit(product)}>
                          <Pencil aria-hidden="true" />
                          {t('common.edit')}
                        </DropdownMenuItem>
                        <DropdownMenuItem destructive={product.active} onSelect={() => onToggle(product)}>
                          {product.active ? <PowerOff aria-hidden="true" /> : <Power aria-hidden="true" />}
                          {product.active ? t('product.deactivate') : t('product.activate')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}
