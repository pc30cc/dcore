import {
  FREE_PLAN_KEY,
  adminProductCreateSchema,
  adminProductUpdateSchema,
  basePlanIdSchema,
  billingPeriodSchema,
  productIdSchema,
  type AdminPlan,
  type AdminProduct,
  type AdminProductCreate,
  type AdminProductUpdate,
  type AppStore,
  type FieldIssue,
  type WalletItem,
} from '@app/shared';
import type { MessageKey } from '@/i18n/messages';
import { asciiDigits, SORT_MAX, SORT_MIN, type PlanBadge } from './plans';

/**
 * The store-product dialogs' form, with the store rules the API holds:
 *
 * - a Google Play subscription names its base plan; a Cafe Bazaar row never
 *   has one (one product id per period), and Cafe Bazaar sells no weekly
 *   subscription;
 * - a subscription sells a plan that is not free and not archived;
 * - a consumable grants a wallet item × a quantity (1-1,000);
 * - once a purchase names a product, what it grants (product id, base plan,
 *   plan, period, item, quantity) is fixed: only the badge, the order, the
 *   list price and on/off change.
 *
 * The list price is typed in the currency's main unit and sent in ISO 4217
 * minor units (revenue reports only; apps always show the store's price).
 */

export type BillingPeriod = (typeof billingPeriodSchema.options)[number];
export const billingPeriods: readonly BillingPeriod[] = billingPeriodSchema.options;
export const walletItems: readonly WalletItem[] = ['superlike', 'boost', 'spotlight', 'dm'];
export type ProductKind = AdminProduct['kind'];

/** The periods a store sells. */
export function periodsOf(store: AppStore): readonly BillingPeriod[] {
  return store === 'bazaar' ? billingPeriods.filter((period) => period !== 'P1W') : billingPeriods;
}

export interface ProductForm {
  kind: ProductKind;
  productId: string;
  basePlanId: string;
  plan: string;
  period: BillingPeriod | '';
  item: WalletItem | '';
  quantity: string;
  badge: PlanBadge | '';
  sort: string;
  active: boolean;
  /** In the currency's main unit, as typed; empty: no list price. */
  price: string;
  currency: string;
}

export type ProductErrors = Partial<Record<keyof ProductForm, MessageKey>>;

export function newProductForm(kind: ProductKind = 'subscription'): ProductForm {
  return { kind, productId: '', basePlanId: '', plan: '', period: '', item: '', quantity: '', badge: '', sort: '', active: false, price: '', currency: '' };
}

/** ISO 4217 minor-unit exponents that are not 2. */
const MINOR_DIGITS: Readonly<Record<string, number>> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0, RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  CLF: 4, UYW: 4,
};

export function minorDigits(currency: string): number {
  return MINOR_DIGITS[currency.toUpperCase()] ?? 2;
}

/** `12.5` USD → 1250; null when the text is not an amount with at most the currency's decimals. */
export function toMinor(amount: string, currency: string): number | null {
  const text = asciiDigits(amount.trim()).replace(/[٫]/g, '.').replace(/[,٬\s]/g, '');
  const digits = minorDigits(currency);
  const match = /^(\d+)(?:\.(\d*))?$/.exec(text);
  if (!match) return null;
  const fraction = match[2] ?? '';
  if (fraction.length > digits) return null;
  const value = Number(match[1]) * 10 ** digits + Number(fraction.padEnd(digits, '0') || '0');
  return Number.isSafeInteger(value) ? value : null;
}

/** 1250 USD → "12.50" (no grouping, for the input). */
export function fromMinor(amountMinor: number, currency: string): string {
  const digits = minorDigits(currency);
  if (digits === 0) return String(amountMinor);
  const text = String(amountMinor).padStart(digits + 1, '0');
  return `${text.slice(0, -digits)}.${text.slice(-digits)}`;
}

/** A list price for people: "$12.50", "۱۲٫۵۰ US$". */
export function formatPrice(price: NonNullable<AdminProduct['listPrice']>, locale: string): string {
  const digits = minorDigits(price.currency);
  try {
    // Decimals as the currency is usually written (none for the rial), more only when the amount has them.
    const usual = new Intl.NumberFormat(locale, { style: 'currency', currency: price.currency }).resolvedOptions().minimumFractionDigits ?? digits;
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: price.currency,
      minimumFractionDigits: Math.min(usual, digits),
      maximumFractionDigits: digits,
    }).format(price.amountMinor / 10 ** digits);
  } catch {
    return `${fromMinor(price.amountMinor, price.currency)} ${price.currency}`;
  }
}

export function productFormOf(product: AdminProduct): ProductForm {
  return {
    kind: product.kind,
    productId: product.productId,
    basePlanId: product.basePlanId ?? '',
    plan: product.plan ?? '',
    period: (billingPeriods as readonly string[]).includes(product.period ?? '') ? (product.period as BillingPeriod) : '',
    item: product.item ?? '',
    quantity: product.quantity === null ? '' : String(product.quantity),
    badge: product.badge ?? '',
    sort: String(product.sort),
    active: product.active,
    price: product.listPrice ? fromMinor(product.listPrice.amountMinor, product.listPrice.currency) : '',
    currency: product.listPrice?.currency ?? '',
  };
}

/** Plans a subscription may sell: not free, not archived. */
export function sellablePlans(plans: readonly AdminPlan[]): AdminPlan[] {
  return plans.filter((plan) => plan.key !== FREE_PLAN_KEY && plan.archivedAt === null).sort((a, b) => a.rank - b.rank);
}

export interface ProductContext {
  store: AppStore;
  mode: 'create' | 'edit';
  /** The row being edited. */
  product?: AdminProduct | undefined;
  plans: readonly AdminPlan[];
}

const INTEGER = /^-?\d+$/;

function integer(value: string): number | null {
  const text = asciiDigits(value.trim());
  return INTEGER.test(text) ? Number(text) : null;
}

/** The fields a purchase fixes once it names the product. */
export const grantingFields = ['productId', 'basePlanId', 'plan', 'period', 'item', 'quantity'] as const;

export function validateProductForm(form: ProductForm, context: ProductContext): ProductErrors {
  const errors: ProductErrors = {};
  const { store } = context;
  if (form.productId.trim() === '') errors.productId = 'form.required';
  else if (!productIdSchema.safeParse(form.productId.trim()).success) errors.productId = 'product.error.productId';

  if (form.kind === 'subscription') {
    const basePlan = form.basePlanId.trim();
    if (store === 'play') {
      if (basePlan === '') errors.basePlanId = 'product.error.basePlanRequired';
      else if (!basePlanIdSchema.safeParse(basePlan).success) errors.basePlanId = 'product.error.basePlanId';
    } else if (basePlan !== '') {
      errors.basePlanId = 'product.error.bazaarBasePlan';
    }
    const plan = context.plans.find((candidate) => candidate.key === form.plan);
    const keepsOwnPlan = context.mode === 'edit' && context.product?.plan === form.plan;
    if (form.plan === '') errors.plan = 'form.required';
    else if (!plan) errors.plan = 'product.error.plan';
    else if (plan.key === FREE_PLAN_KEY) errors.plan = 'product.error.freePlan';
    else if (plan.archivedAt !== null && !keepsOwnPlan) errors.plan = 'product.error.archivedPlan';
    if (form.period === '') errors.period = 'form.required';
    else if (!periodsOf(store).includes(form.period)) errors.period = 'product.error.bazaarWeekly';
  } else {
    if (form.item === '') errors.item = 'form.required';
    const quantity = integer(form.quantity);
    if (quantity === null || quantity < 1 || quantity > 1_000) errors.quantity = 'product.error.quantity';
  }

  if (form.sort.trim() !== '' || context.mode === 'edit') {
    const sort = integer(form.sort);
    if (sort === null || sort < SORT_MIN || sort > SORT_MAX) errors.sort = 'plan.error.sort';
  }

  const price = form.price.trim();
  const currency = form.currency.trim().toUpperCase();
  if (price !== '' || currency !== '') {
    if (!/^[A-Z]{3}$/.test(currency)) errors.currency = 'product.error.currency';
    if (price === '') errors.price = 'form.required';
    else if (toMinor(price, /^[A-Z]{3}$/.test(currency) ? currency : 'XXX') === null) errors.price = 'product.error.price';
  }
  return errors;
}

function listPriceOf(form: ProductForm): { amountMinor: number; currency: string } | null {
  const currency = form.currency.trim().toUpperCase();
  if (form.price.trim() === '') return null;
  const amountMinor = toMinor(form.price, currency);
  return amountMinor === null ? null : { amountMinor, currency };
}

/** `POST /v1/admin/store-products` for a valid form. */
export function productCreateBody(form: ProductForm, store: AppStore): AdminProductCreate {
  const sort = integer(form.sort);
  const listPrice = listPriceOf(form);
  const common = {
    store,
    productId: form.productId.trim(),
    active: form.active,
    ...(form.badge === '' ? {} : { badge: form.badge }),
    ...(sort === null ? {} : { sort }),
    ...(listPrice ? { listPrice } : {}),
  };
  const body =
    form.kind === 'subscription'
      ? { kind: 'subscription' as const, ...common, plan: form.plan, period: form.period, ...(store === 'play' ? { basePlanId: form.basePlanId.trim() } : {}) }
      : { kind: 'consumable' as const, ...common, item: form.item, quantity: integer(form.quantity) ?? 0 };
  return adminProductCreateSchema.parse(body);
}

/** `PATCH /v1/admin/store-products/:id` for a valid form: what differs from `product`; null when nothing does. */
export function productPatchBody(form: ProductForm, product: AdminProduct): AdminProductUpdate | null {
  const body: AdminProductUpdate = {};
  const locked = product.hasPurchases;
  if (!locked) {
    const productId = form.productId.trim();
    if (productId !== product.productId) body.productId = productId;
    if (product.kind === 'subscription') {
      if (product.store === 'play') {
        const basePlanId = form.basePlanId.trim();
        if (basePlanId !== (product.basePlanId ?? '')) body.basePlanId = basePlanId;
      }
      if (form.plan !== (product.plan ?? '')) body.plan = form.plan;
      if (form.period !== '' && form.period !== product.period) body.period = form.period;
    } else {
      if (form.item !== '' && form.item !== product.item) body.item = form.item;
      const quantity = integer(form.quantity);
      if (quantity !== null && quantity !== product.quantity) body.quantity = quantity;
    }
  }
  const badge = form.badge === '' ? null : form.badge;
  if (badge !== product.badge) body.badge = badge;
  const sort = integer(form.sort);
  if (sort !== null && sort !== product.sort) body.sort = sort;
  if (form.active !== product.active) body.active = form.active;
  const listPrice = listPriceOf(form);
  const before = product.listPrice;
  if ((listPrice === null) !== (before === null) || (listPrice && before && (listPrice.amountMinor !== before.amountMinor || listPrice.currency !== before.currency))) {
    body.listPrice = listPrice;
  }
  return Object.keys(body).length === 0 ? null : adminProductUpdateSchema.parse(body);
}

const SERVER_CODES: Readonly<Record<string, [keyof ProductForm, MessageKey]>> = {
  bazaar_base_plan: ['basePlanId', 'product.error.bazaarBasePlan'],
  base_plan_required: ['basePlanId', 'product.error.basePlanRequired'],
  bazaar_period: ['period', 'product.error.bazaarWeekly'],
  unknown_plan: ['plan', 'product.error.plan'],
  free_plan: ['plan', 'product.error.freePlan'],
  other_kind: ['productId', 'product.error.otherKind'],
  other_plan: ['plan', 'product.error.otherPlan'],
  not_a_consumable: ['item', 'product.error.notConsumable'],
  not_a_subscription: ['plan', 'product.error.notSubscription'],
};

/** The API's field problems as form fields with the panel's words; the rest is left for the dialog's notice. */
export function serverProductErrors(issues: readonly FieldIssue[]): { errors: ProductErrors; rest: FieldIssue[] } {
  const errors: ProductErrors = {};
  const rest: FieldIssue[] = [];
  for (const issue of issues) {
    const known = SERVER_CODES[issue.code];
    if (known) errors[known[0]] = known[1];
    else rest.push(issue);
  }
  return { errors, rest };
}
