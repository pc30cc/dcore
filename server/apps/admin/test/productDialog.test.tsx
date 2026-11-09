import type { AdminProduct } from '@app/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  formatPrice,
  fromMinor,
  minorDigits,
  newProductForm,
  periodsOf,
  productCreateBody,
  productFormOf,
  productPatchBody,
  serverProductErrors,
  toMinor,
  validateProductForm,
} from '../src/lib/products';
import { fakeApi, owner, plan, planList, problem, renderPanel, resetPanel, signInAs } from './panel';

const free = plan('free');
const plus = plan('plus', { rank: 1 });
const legacy = plan('legacy', { rank: 2, active: false, archivedAt: '2026-11-01T00:00:00.000Z' });
const plans = [free, plus, legacy];

function product(overrides: Partial<AdminProduct> = {}): AdminProduct {
  return {
    id: '41',
    store: 'play',
    kind: 'subscription',
    productId: 'sub.plus',
    basePlanId: 'm1',
    plan: 'plus',
    period: 'P1M',
    item: null,
    quantity: null,
    badge: null,
    sort: 10,
    active: true,
    listPrice: { amountMinor: 499, currency: 'USD' },
    hasPurchases: false,
    updatedAt: '2026-11-09T12:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  resetPanel();
  signInAs(owner);
});

describe('the store rules', () => {
  const play = { store: 'play' as const, mode: 'create' as const, plans };
  const bazaar = { store: 'bazaar' as const, mode: 'create' as const, plans };
  const subscription = { ...newProductForm('subscription'), productId: 'sub.plus', plan: 'plus', period: 'P1M' as const };

  it('needs a base plan on Google Play and refuses one on Cafe Bazaar', () => {
    expect(validateProductForm(subscription, play).basePlanId).toBe('product.error.basePlanRequired');
    expect(validateProductForm({ ...subscription, basePlanId: 'M1!' }, play).basePlanId).toBe('product.error.basePlanId');
    expect(validateProductForm({ ...subscription, basePlanId: 'm1' }, play)).toEqual({});
    expect(validateProductForm(subscription, bazaar)).toEqual({});
    expect(validateProductForm({ ...subscription, basePlanId: 'm1' }, bazaar).basePlanId).toBe('product.error.bazaarBasePlan');
  });

  it('sells no weekly period on Cafe Bazaar', () => {
    expect(periodsOf('play')).toContain('P1W');
    expect(periodsOf('bazaar')).not.toContain('P1W');
    expect(validateProductForm({ ...subscription, period: 'P1W' }, bazaar).period).toBe('product.error.bazaarWeekly');
  });

  it('sells neither the free plan nor an archived one (a row keeps its own archived plan)', () => {
    expect(validateProductForm({ ...subscription, basePlanId: 'm1', plan: 'free' }, play).plan).toBe('product.error.freePlan');
    expect(validateProductForm({ ...subscription, basePlanId: 'm1', plan: 'legacy' }, play).plan).toBe('product.error.archivedPlan');
    expect(validateProductForm({ ...subscription, basePlanId: 'm1', plan: 'gone' }, play).plan).toBe('product.error.plan');
    const own = product({ plan: 'legacy' });
    expect(validateProductForm(productFormOf(own), { store: 'play', mode: 'edit', product: own, plans }).plan).toBeUndefined();
  });

  it('checks product ids, packs and list prices', () => {
    expect(validateProductForm({ ...subscription, productId: 'Sub Plus' }, bazaar).productId).toBe('product.error.productId');
    const pack = { ...newProductForm('consumable'), productId: 'cons.boost.5', item: 'boost' as const, quantity: '0' };
    expect(validateProductForm(pack, play).quantity).toBe('product.error.quantity');
    expect(validateProductForm({ ...pack, quantity: '1001' }, play).quantity).toBe('product.error.quantity');
    expect(validateProductForm({ ...pack, quantity: '۵' }, play)).toEqual({});
    expect(validateProductForm({ ...pack, quantity: '5', price: '4.999', currency: 'USD' }, play).price).toBe('product.error.price');
    expect(validateProductForm({ ...pack, quantity: '5', price: '4.99', currency: 'usd1' }, play).currency).toBe('product.error.currency');
    expect(validateProductForm({ ...pack, quantity: '5', price: '', currency: 'USD' }, play).price).toBe('form.required');
  });

  it('converts list prices to and from ISO 4217 minor units', () => {
    expect(minorDigits('USD')).toBe(2);
    expect(minorDigits('JPY')).toBe(0);
    expect(minorDigits('KWD')).toBe(3);
    expect(toMinor('4.99', 'USD')).toBe(499);
    expect(toMinor('12', 'USD')).toBe(1200);
    expect(toMinor('۹۹٬۰۰۰', 'IRR')).toBe(9_900_000);
    expect(toMinor('1.5', 'JPY')).toBeNull();
    expect(fromMinor(499, 'USD')).toBe('4.99');
    expect(fromMinor(5, 'USD')).toBe('0.05');
    expect(fromMinor(1200, 'JPY')).toBe('1200');
    expect(formatPrice({ amountMinor: 499, currency: 'USD' }, 'en')).toBe('$4.99');
    expect(formatPrice({ amountMinor: 9_900_000, currency: 'IRR' }, 'en')).not.toContain('.00');
  });

  it('builds bodies: Play with its base plan, Bazaar without; edits send only changes', () => {
    expect(productCreateBody({ ...subscription, basePlanId: 'm1', price: '4.99', currency: 'usd' }, 'play')).toEqual({
      kind: 'subscription',
      store: 'play',
      productId: 'sub.plus',
      basePlanId: 'm1',
      plan: 'plus',
      period: 'P1M',
      active: false,
      listPrice: { amountMinor: 499, currency: 'USD' },
    });
    expect(productCreateBody(subscription, 'bazaar')).not.toHaveProperty('basePlanId');
    const row = product();
    expect(productPatchBody(productFormOf(row), row)).toBeNull();
    expect(productPatchBody({ ...productFormOf(row), badge: 'popular', price: '' }, row)).toEqual({ badge: 'popular', listPrice: null });
    // A purchase fixes what the row grants: only badge, order, price and on/off go.
    const sold = product({ hasPurchases: true });
    expect(productPatchBody({ ...productFormOf(sold), productId: 'sub.other', period: 'P3M', sort: '12' }, sold)).toEqual({ sort: 12 });
  });

  it('maps the API’s store codes to fields', () => {
    expect(serverProductErrors([{ in: 'body', pointer: '/basePlanId', code: 'bazaar_base_plan', message: 'x' }]).errors).toEqual({ basePlanId: 'product.error.bazaarBasePlan' });
    expect(serverProductErrors([{ in: 'body', pointer: '/productId', code: 'other_kind', message: 'x' }]).errors).toEqual({ productId: 'product.error.otherKind' });
  });
});

describe('the product dialog', () => {
  it('has no base plan field and no weekly period on Cafe Bazaar', async () => {
    const api = fakeApi({
      'GET /v1/admin/plans': () => planList(plans),
      'GET /v1/admin/store-products': () => ({ items: [] }),
      'POST /v1/admin/store-products': (call) => [201, product({ ...(call.body as object), id: '50', store: 'bazaar', basePlanId: null })],
    });
    const user = userEvent.setup();
    renderPanel('/revenue/products?store=bazaar', api);
    await user.click(await screen.findByRole('button', { name: 'New product' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByLabelText('Base plan ID')).toBeNull();
    expect(within(dialog).getByText('Cafe Bazaar has no base plans.')).toBeTruthy();
    const periods = within(within(dialog).getByLabelText('Period')).getAllByRole('option').map((option) => option.getAttribute('value'));
    expect(periods).toEqual(['', 'P1M', 'P3M', 'P6M', 'P12M']);
    // Free and archived plans are not offered.
    const offered = within(within(dialog).getByLabelText(/^Plan/)).getAllByRole('option').map((option) => option.getAttribute('value'));
    expect(offered).toEqual(['', 'plus']);

    await user.type(within(dialog).getByLabelText(/^Product ID/), 'plus_monthly');
    await user.selectOptions(within(dialog).getByLabelText(/^Plan/), 'plus');
    await user.selectOptions(within(dialog).getByLabelText('Period'), 'P1M');
    await user.click(within(dialog).getByRole('switch', { name: 'Listed in the app' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create product' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.of('POST /v1/admin/store-products')[0]?.body).toEqual({ kind: 'subscription', store: 'bazaar', productId: 'plus_monthly', plan: 'plus', period: 'P1M', active: true });
  });

  it('asks Google Play subscriptions for their base plan before sending', async () => {
    const api = fakeApi({
      'GET /v1/admin/plans': () => planList(plans),
      'GET /v1/admin/store-products': () => ({ items: [] }),
    });
    const user = userEvent.setup();
    renderPanel('/revenue/products', api);
    await user.click(await screen.findByRole('button', { name: 'New product' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/^Product ID/), 'sub.plus');
    await user.selectOptions(within(dialog).getByLabelText(/^Plan/), 'plus');
    await user.selectOptions(within(dialog).getByLabelText('Period'), 'P1W');
    await user.click(within(dialog).getByRole('button', { name: 'Create product' }));
    expect(await within(dialog).findByText('A Google Play subscription needs its base plan ID.')).toBeTruthy();
    expect(api.of('POST /v1/admin/store-products')).toHaveLength(0);
  });

  it('switches to a pack: item and quantity instead of plan and period', async () => {
    const api = fakeApi({
      'GET /v1/admin/plans': () => planList(plans),
      'GET /v1/admin/store-products': () => ({ items: [] }),
      'POST /v1/admin/store-products': () => problem(422, 'field_invalid', { errors: [{ in: 'body', pointer: '/productId', code: 'other_kind', message: 'x' }] }),
    });
    const user = userEvent.setup();
    renderPanel('/revenue/products', api);
    await user.click(await screen.findByRole('button', { name: 'New product' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('radio', { name: 'Pack' }));
    expect(within(dialog).queryByLabelText('Period')).toBeNull();
    await user.type(within(dialog).getByLabelText(/^Product ID/), 'sub.plus');
    await user.selectOptions(within(dialog).getByLabelText('Item'), 'boost');
    await user.type(within(dialog).getByLabelText(/^Quantity/), '5');
    await user.click(within(dialog).getByRole('button', { name: 'Create product' }));
    expect(await within(dialog).findByText('This product ID is already used for the other product type in this store.')).toBeTruthy();
    expect(api.of('POST /v1/admin/store-products')[0]?.body).toEqual({ kind: 'consumable', store: 'play', productId: 'sub.plus', item: 'boost', quantity: 5, active: false });
  });

  it('locks what a purchased product grants and saves the rest', async () => {
    const sold = product({ hasPurchases: true });
    const api = fakeApi({
      'GET /v1/admin/plans': () => planList(plans),
      'GET /v1/admin/store-products': () => ({ items: [sold] }),
      'PATCH /v1/admin/store-products/41': () => ({ ...sold, badge: 'popular', updatedAt: '2026-11-09T13:00:00.000Z' }),
    });
    const user = userEvent.setup();
    renderPanel('/revenue/products', api);
    await user.click(await screen.findByRole('button', { name: 'Actions for sub.plus' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/A purchase names this product/)).toBeTruthy();
    for (const label of [/^Product ID/, 'Base plan ID', /^Plan/, 'Period']) {
      expect(within(dialog).getByLabelText<HTMLInputElement>(label).disabled).toBe(true);
    }
    await user.selectOptions(within(dialog).getByLabelText('Badge'), 'popular');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.of('PATCH /v1/admin/store-products/41')[0]?.body).toEqual({ badge: 'popular' });
  });

  it('asks before turning a product off', async () => {
    const api = fakeApi({
      'GET /v1/admin/plans': () => planList(plans),
      'GET /v1/admin/store-products': () => ({ items: [product()] }),
      'POST /v1/admin/store-products/41/deactivate': () => product({ active: false }),
    });
    const user = userEvent.setup();
    renderPanel('/revenue/products', api);
    await user.click(await screen.findByRole('button', { name: 'Actions for sub.plus' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Turn off' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(api.of('POST /v1/admin/store-products/41/deactivate')).toHaveLength(0);
    await user.click(within(confirm).getByRole('button', { name: 'Turn off' }));
    await screen.findByText('Product sub.plus is off.');
    expect(api.of('POST /v1/admin/store-products/41/deactivate')).toHaveLength(1);
  });
});
