import type { AdminPlan, AdminProduct, AppStore } from '@app/shared';
import { Lock, TriangleAlert } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Field } from '@/components/form/Field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n/useI18n';
import { apiRequest } from '@/lib/api';
import { asApiError } from '@/lib/http';
import { localized } from '@/lib/format';
import { hasErrors, planBadges } from '@/lib/plans';
import {
  minorDigits,
  newProductForm,
  periodsOf,
  productCreateBody,
  productFormOf,
  productPatchBody,
  sellablePlans,
  serverProductErrors,
  validateProductForm,
  walletItems,
  type ProductErrors,
  type ProductForm,
  type ProductKind,
} from '@/lib/products';
import { problemText } from '@/lib/problemText';
import { storeProduct } from '@/lib/queries';
import { showToast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { badgeText } from '../plans/planText';
import { itemText, periodText, storeText } from './productText';

/**
 * Makes or changes one store product. The fields follow the store: a Google
 * Play subscription names its base plan, a Cafe Bazaar row has none and no
 * weekly period. Once a purchase names the product, what it grants is shown
 * but locked.
 */
export function ProductDialog({
  open,
  onOpenChange,
  store,
  plans,
  product,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  store: AppStore;
  plans: readonly AdminPlan[];
  /** The row to change; absent: a new one. */
  product?: AdminProduct;
}) {
  const { t, locale } = useI18n();
  const baseId = useId();
  const mode = product ? 'edit' : 'create';
  const [form, setForm] = useState<ProductForm>(() => (product ? productFormOf(product) : newProductForm()));
  const [attempted, setAttempted] = useState(false);
  const [serverErrors, setServerErrors] = useState<ProductErrors>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const context = { store, mode, product, plans } as const;
  const errors: ProductErrors = { ...(attempted ? validateProductForm(form, context) : {}), ...serverErrors };
  const locked = product?.hasPurchases === true;
  const subscription = form.kind === 'subscription';
  const sellable = sellablePlans(plans);
  const ownPlan = product?.plan ? plans.find((plan) => plan.key === product.plan) : undefined;
  // A row keeps showing its own plan even once that plan is archived.
  const choices = ownPlan && !sellable.includes(ownPlan) ? [...sellable, ownPlan] : sellable;
  const err = (field: keyof ProductForm) => {
    const key = errors[field];
    return key ? t(key, { digits: minorDigits(form.currency || 'USD') }) : undefined;
  };

  function update(patch: Partial<ProductForm>) {
    setForm((current) => ({ ...current, ...patch }));
    setServerErrors({});
    setNotice(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setAttempted(true);
    if (hasErrors(validateProductForm(form, context))) {
      setNotice(t('form.fixMarked'));
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      let saved: AdminProduct;
      if (product) {
        const body = productPatchBody(form, product);
        if (!body) {
          onOpenChange(false);
          return;
        }
        saved = await apiRequest<AdminProduct>(`/v1/admin/store-products/${product.id}`, { method: 'PATCH', body });
      } else {
        saved = await apiRequest<AdminProduct>('/v1/admin/store-products', { method: 'POST', body: productCreateBody(form, store) });
      }
      storeProduct(saved);
      showToast(product ? t('product.saved') : t('product.created', { id: saved.productId }));
      onOpenChange(false);
    } catch (error) {
      const failure = asApiError(error);
      if (failure.code === 'field_invalid' || failure.code === 'validation_failed') {
        const mapped = serverProductErrors(failure.errors);
        setServerErrors(mapped.errors);
        setNotice(mapped.rest.length > 0 ? t('common.error.invalid', { detail: mapped.rest.map((issue) => issue.message).join('; ') }) : t('form.fixMarked'));
      } else if (failure.code === 'conflict') {
        setNotice(locked ? t('product.error.lockedConflict') : t('product.error.conflict'));
      } else {
        setNotice(problemText(failure, t));
      }
    } finally {
      setSaving(false);
    }
  }

  const kinds: readonly ProductKind[] = ['subscription', 'consumable'];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>{product ? t('product.editTitle', { id: product.productId }) : t('product.newTitle', { store: t(storeText[store]) })}</DialogTitle>
          <DialogDescription>{store === 'play' ? t('product.intro.play') : t('product.intro.bazaar')}</DialogDescription>
        </DialogHeader>

        <form className="grid gap-5" noValidate onSubmit={(event) => void submit(event)}>
          {!product && (
            <div role="radiogroup" aria-label={t('product.kind')} className="grid grid-cols-2 gap-2 rounded-lg bg-muted p-1">
              {kinds.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  role="radio"
                  aria-checked={form.kind === kind}
                  onClick={() => update({ ...newProductForm(kind), productId: form.productId, badge: form.badge, sort: form.sort, active: form.active, price: form.price, currency: form.currency })}
                  className={cn(
                    'rounded-md px-3 py-2 text-sm font-medium text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                    form.kind === kind && 'bg-background text-foreground shadow-sm',
                  )}
                >
                  {t(kind === 'subscription' ? 'product.kind.subscription' : 'product.kind.consumable')}
                </button>
              ))}
            </div>
          )}

          {locked && (
            <Alert variant="warning">
              <Lock aria-hidden="true" />
              <AlertDescription>{t('product.locked')}</AlertDescription>
            </Alert>
          )}

          <fieldset disabled={saving} className="grid min-w-0 gap-5">
            <div className="grid gap-5 sm:grid-cols-2">
              <Field id={`${baseId}-pid`} label={t('product.productId')} hint={store === 'play' ? t('product.productId.hintPlay') : t('product.productId.hintBazaar')} error={err('productId')}>
                {(control) => (
                  <Input
                    {...control}
                    dir="ltr"
                    className="font-mono"
                    spellCheck={false}
                    autoComplete="off"
                    disabled={locked}
                    placeholder={subscription ? 'sub.gold' : 'cons.boost.5'}
                    value={form.productId}
                    onChange={(event) => update({ productId: event.target.value })}
                  />
                )}
              </Field>
              {subscription && store === 'play' && (
                <Field id={`${baseId}-base`} label={t('product.basePlanId')} hint={t('product.basePlanId.hint')} error={err('basePlanId')}>
                  {(control) => (
                    <Input
                      {...control}
                      dir="ltr"
                      className="font-mono"
                      spellCheck={false}
                      autoComplete="off"
                      disabled={locked}
                      placeholder="m1"
                      value={form.basePlanId}
                      onChange={(event) => update({ basePlanId: event.target.value })}
                    />
                  )}
                </Field>
              )}
              {subscription && store === 'bazaar' && (
                <div className="grid content-start gap-2">
                  <span className="text-sm font-medium">{t('product.basePlanId')}</span>
                  <p className="flex min-h-9 items-center rounded-md border border-dashed px-3 text-sm text-muted-foreground">{t('product.basePlanId.bazaar')}</p>
                  {errors.basePlanId && <p className="text-sm text-destructive">{t(errors.basePlanId)}</p>}
                </div>
              )}
            </div>

            {subscription ? (
              <div className="grid gap-5 sm:grid-cols-2">
                <Field id={`${baseId}-plan`} label={t('product.plan')} hint={t('product.plan.hint')} error={err('plan')}>
                  {(control) => (
                    <NativeSelect {...control} disabled={locked} value={form.plan} onChange={(event) => update({ plan: event.target.value })}>
                      <option value="">{t('form.choose')}</option>
                      {choices.map((plan) => (
                        <option key={plan.key} value={plan.key}>
                          {localized(plan.names, locale, plan.key)} ({plan.key})
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </Field>
                <Field id={`${baseId}-period`} label={t('product.period')} hint={store === 'bazaar' ? t('product.period.bazaar') : undefined} error={err('period')}>
                  {(control) => (
                    <NativeSelect {...control} disabled={locked} value={form.period} onChange={(event) => update({ period: event.target.value as ProductForm['period'] })}>
                      <option value="">{t('form.choose')}</option>
                      {periodsOf(store).map((period) => (
                        <option key={period} value={period}>
                          {t(periodText[period])}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </Field>
              </div>
            ) : (
              <div className="grid gap-5 sm:grid-cols-2">
                <Field id={`${baseId}-item`} label={t('product.item')} error={err('item')}>
                  {(control) => (
                    <NativeSelect {...control} disabled={locked} value={form.item} onChange={(event) => update({ item: event.target.value as ProductForm['item'] })}>
                      <option value="">{t('form.choose')}</option>
                      {walletItems.map((item) => (
                        <option key={item} value={item}>
                          {t(itemText[item])}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </Field>
                <Field id={`${baseId}-qty`} label={t('product.quantity')} hint={t('product.quantity.hint')} error={err('quantity')}>
                  {(control) => <Input {...control} dir="ltr" inputMode="numeric" disabled={locked} value={form.quantity} onChange={(event) => update({ quantity: event.target.value })} />}
                </Field>
              </div>
            )}

            <div className="grid gap-5 sm:grid-cols-3">
              <Field id={`${baseId}-badge`} label={t('plan.badge')}>
                {(control) => (
                  <NativeSelect {...control} value={form.badge} onChange={(event) => update({ badge: event.target.value as ProductForm['badge'] })}>
                    <option value="">{t('badge.none')}</option>
                    {planBadges.map((badge) => (
                      <option key={badge} value={badge}>
                        {t(badgeText[badge])}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              <Field id={`${baseId}-sort`} label={t('plan.sort')} error={err('sort')} {...(product ? {} : { optional: t('form.optional') })}>
                {(control) => <Input {...control} dir="ltr" inputMode="numeric" placeholder="0" value={form.sort} onChange={(event) => update({ sort: event.target.value })} />}
              </Field>
              <div className="grid content-start gap-2">
                <span className="text-sm font-medium">
                  {t('product.listPrice')} <span className="text-xs font-normal text-muted-foreground">{t('form.optional')}</span>
                </span>
                <div className="flex gap-2">
                  <Input
                    id={`${baseId}-price`}
                    dir="ltr"
                    inputMode="decimal"
                    className="min-w-0 flex-1 tabular-nums"
                    placeholder="4.99"
                    aria-label={t('product.listPrice.amount')}
                    aria-invalid={Boolean(errors.price)}
                    value={form.price}
                    onChange={(event) => update({ price: event.target.value })}
                  />
                  <Input
                    id={`${baseId}-currency`}
                    dir="ltr"
                    className="w-20 font-mono uppercase"
                    maxLength={3}
                    placeholder="USD"
                    aria-label={t('product.listPrice.currency')}
                    aria-invalid={Boolean(errors.currency)}
                    value={form.currency}
                    onChange={(event) => update({ currency: event.target.value.toUpperCase() })}
                  />
                </div>
                {(errors.price ?? errors.currency) ? (
                  <p className="text-sm text-destructive">{err('price') ?? err('currency')}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">{t('product.listPrice.hint')}</p>
                )}
              </div>
            </div>

            <label className="flex items-start justify-between gap-4 rounded-lg border p-4">
              <span className="grid gap-0.5">
                <span className="text-sm font-medium">{t('product.active')}</span>
                <span className="text-xs text-muted-foreground">{t('product.active.help')}</span>
              </span>
              <Switch checked={form.active} onCheckedChange={(active) => update({ active })} aria-label={t('product.active')} />
            </label>
          </fieldset>

          {notice && (
            <Alert variant="destructive">
              <TriangleAlert aria-hidden="true" />
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? t('common.saving') : product ? t('form.save') : t('product.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
