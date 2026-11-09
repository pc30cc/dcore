import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { asciiDigits, moveInOrder, newPlanForm, planCreateBody, planFormOf, planPatchBody, rankOrder, serverPlanErrors, validatePlanForm } from '../src/lib/plans';
import { fakeApi, owner, plan, planList, problem, renderPanel, resetPanel, signInAs } from './panel';

const free = plan('free', { names: { en: 'Free', fa: 'رایگان' } });
const plus = plan('plus', { rank: 1, sort: 1, names: { en: 'Plus', fa: 'پلاس' } });
const premium = plan('premium', { rank: 2, sort: 2, names: { en: 'Premium' }, features: { ...plus.features, see_likes: true, rewind: true }, quotas: { ...plus.quotas, daily_likes: -1 } });
const archived = plan('legacy', { rank: 3, active: false, archivedAt: '2026-11-01T00:00:00.000Z' });
const all = [free, plus, premium, archived];

beforeEach(() => {
  resetPanel();
  signInAs(owner);
});

describe('the plan form rules', () => {
  const create = { mode: 'create' as const, plans: all };

  it('needs a new, well-formed key and a Persian or English name', () => {
    const form = newPlanForm();
    expect(validatePlanForm(form, create)).toMatchObject({ key: 'form.required', names: 'plan.error.nameRequired' });
    expect(validatePlanForm({ ...form, key: 'Gold' }, create).key).toBe('plan.error.key');
    expect(validatePlanForm({ ...form, key: 'g' }, create).key).toBe('plan.error.key');
    // Archived plans keep their keys: never reused.
    expect(validatePlanForm({ ...form, key: 'legacy' }, create).key).toBe('plan.error.keyTaken');
    const named = { ...form, key: 'gold', names: { fa: '', en: '', tr: 'Altın' } };
    expect(validatePlanForm(named, create).names).toBe('plan.error.nameRequired');
    expect(validatePlanForm({ ...named, names: { ...named.names, en: 'Gold' } }, create)).toEqual({});
  });

  it('limits names, descriptions and control characters', () => {
    const form = { ...newPlanForm(), key: 'gold', names: { fa: 'ط'.repeat(41), en: 'Gold\u0007', tr: '' }, descriptions: { fa: '', en: 'x'.repeat(201), tr: '' } };
    expect(validatePlanForm(form, create)).toMatchObject({
      'names.fa': 'plan.error.nameLong',
      'names.en': 'form.controlChars',
      'descriptions.en': 'plan.error.descriptionLong',
    });
  });

  it('checks ranks (1-9,999, not another plan’s), order and quotas', () => {
    const form = { ...newPlanForm(), key: 'gold', names: { fa: '', en: 'Gold', tr: '' } };
    expect(validatePlanForm({ ...form, rank: '0' }, create).rank).toBe('plan.error.rank');
    expect(validatePlanForm({ ...form, rank: '10000' }, create).rank).toBe('plan.error.rank');
    expect(validatePlanForm({ ...form, rank: '2' }, create).rank).toBe('plan.error.rankTaken');
    expect(validatePlanForm({ ...form, rank: '۴' }, create).rank).toBeUndefined();
    expect(validatePlanForm({ ...form, sort: '40000' }, create).sort).toBe('plan.error.sort');
    const quotas = { ...form.quotas, daily_likes: { unlimited: false, value: '1000001' }, daily_dm: { unlimited: false, value: '-1' }, monthly_boosts: { unlimited: true, value: 'x' } };
    const errors = validatePlanForm({ ...form, quotas }, create);
    expect(errors['quotas.daily_likes']).toBe('plan.error.quota');
    expect(errors['quotas.daily_dm']).toBe('plan.error.quota');
    expect(errors['quotas.monthly_boosts']).toBeUndefined();
  });

  it('keeps the free plan’s rank out of the checks and its own rank is not a clash', () => {
    expect(validatePlanForm(planFormOf(free), { mode: 'edit', plan: free, plans: all })).toEqual({});
    expect(validatePlanForm(planFormOf(plus), { mode: 'edit', plan: plus, plans: all })).toEqual({});
  });

  it('builds a create body with every switch and quota (-1 for unlimited)', () => {
    const form = { ...newPlanForm(), key: 'gold', names: { fa: ' طلایی ', en: 'Gold', tr: '' }, rank: '', sort: '5', badge: 'best_value' as const, copyFrom: 'premium' };
    form.quotas = { ...form.quotas, daily_likes: { unlimited: true, value: '' }, monthly_boosts: { unlimited: false, value: '۱۰' } };
    const body = planCreateBody(form);
    expect(body).toMatchObject({ key: 'gold', names: { fa: 'طلایی', en: 'Gold' }, sort: 5, badge: 'best_value', copyFrom: 'premium', active: true });
    expect(body.rank).toBeUndefined();
    expect(body.quotas).toMatchObject({ daily_likes: -1, monthly_boosts: 10 });
    expect(Object.keys(body.features ?? {})).toHaveLength(11);
  });

  it('sends only what changed, whole maps for texts and key by key for switches and quotas', () => {
    expect(planPatchBody(planFormOf(plus), plus)).toBeNull();
    const form = planFormOf(plus);
    form.names = { ...form.names, tr: 'Artı' };
    form.features = { ...form.features, rewind: true };
    form.quotas = { ...form.quotas, daily_likes: { unlimited: true, value: '' } };
    form.badge = 'popular';
    expect(planPatchBody(form, plus)).toEqual({ names: { en: 'Plus', fa: 'پلاس', tr: 'Artı' }, badge: 'popular', features: { rewind: true }, quotas: { daily_likes: -1 } });
    // The free plan never sends a rank or "off sale".
    const freeForm = { ...planFormOf(free), rank: '3', active: false };
    expect(planPatchBody(freeForm, free)).toBeNull();
  });

  it('maps the API’s field problems to the fields', () => {
    const { errors, rest } = serverPlanErrors([
      { in: 'body', pointer: '/rank', code: 'free_plan', message: 'x' },
      { in: 'body', pointer: '/copyFrom', code: 'unknown_plan', message: 'y' },
      { in: 'body', pointer: '/names', code: 'custom', message: 'z' },
    ]);
    expect(errors).toEqual({ rank: 'plan.error.freePlan', copyFrom: 'plan.error.unknownPlan' });
    expect(rest).toHaveLength(1);
  });

  it('moves plans in the upgrade order', () => {
    expect(rankOrder(all).map((item) => item.key)).toEqual(['plus', 'premium', 'legacy']);
    expect(moveInOrder(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveInOrder(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
    expect(asciiDigits('۱۲٣')).toBe('123');
  });
});

describe('the plan editor', () => {
  it('lists plans with their state, and hides archived ones until asked', async () => {
    const api = fakeApi({ 'GET /v1/admin/plans': () => planList(all) });
    const user = userEvent.setup();
    renderPanel('/revenue/plans', api);
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Free baseline')).toBeTruthy();
    expect(within(table).getAllByText('On sale')).toHaveLength(2);
    expect(within(table).queryByText('legacy')).toBeNull();
    await user.click(screen.getByRole('switch', { name: 'Show archived' }));
    expect(within(table).getByText('legacy')).toBeTruthy();
  });

  it('shows what is wrong next to each field and sends nothing until it is fixed', async () => {
    const api = fakeApi({ 'GET /v1/admin/plans': () => planList(all) });
    const user = userEvent.setup();
    renderPanel('/revenue/plans/new', api);
    await screen.findByRole('heading', { name: 'New plan' });
    await user.type(screen.getByLabelText('Key'), 'plus');
    await user.click(screen.getByRole('button', { name: 'Create plan' }));
    expect(await screen.findByText('A plan with this key exists (keys are never reused).')).toBeTruthy();
    expect(screen.getByText('Give the plan a Persian or an English name.')).toBeTruthy();
    expect(screen.getByText('Fix the marked fields and try again.')).toBeTruthy();
    const likes = screen.getByLabelText('Likes per day');
    await user.clear(likes);
    await user.type(likes, '12x');
    expect(await screen.findByText('A whole number from 0 to 1,000,000, or unlimited.')).toBeTruthy();
    expect(likes.getAttribute('aria-invalid')).toBe('true');
    expect(api.of('POST /v1/admin/plans')).toHaveLength(0);
  });

  it('creates a plan from a copy, with switches and quotas, then opens it', async () => {
    let created: unknown;
    const api = fakeApi({
      'GET /v1/admin/plans': () => planList(all),
      'POST /v1/admin/plans': (call) => {
        created = call.body;
        return [201, plan('gold', { rank: 4, names: { en: 'Gold', fa: 'طلایی' }, badge: 'best_value', features: premium.features, quotas: { ...premium.quotas, monthly_boosts: 10 } })];
      },
    });
    const user = userEvent.setup();
    const { router } = renderPanel('/revenue/plans/new', api);
    await screen.findByRole('heading', { name: 'New plan' });
    await user.type(screen.getByLabelText('Key'), 'gold');
    await user.selectOptions(screen.getByLabelText(/Start from/), 'premium');
    // The copy fills the switches and quotas.
    expect(screen.getByRole('switch', { name: 'See who liked you' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByLabelText<HTMLInputElement>('Likes per day').disabled).toBe(true);
    const [faName, enName] = screen.getAllByLabelText('Name');
    await user.type(faName!, 'طلایی');
    await user.type(enName!, 'Gold');
    await user.selectOptions(screen.getByLabelText('Badge'), 'best_value');
    const boosts = screen.getByLabelText('Boosts per month');
    await user.clear(boosts);
    await user.type(boosts, '10');
    await user.click(screen.getByRole('switch', { name: 'Video calls' }));
    await user.click(screen.getByRole('button', { name: 'Create plan' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/revenue/plans/gold'));
    expect(created).toMatchObject({
      key: 'gold',
      names: { fa: 'طلایی', en: 'Gold' },
      badge: 'best_value',
      copyFrom: 'premium',
      active: true,
      features: { see_likes: true, rewind: true, video_calls: false },
      quotas: { daily_likes: -1, monthly_boosts: 10 },
    });
    expect(created).not.toHaveProperty('rank');
  });

  it('edits a plan: sends only the changes, and keeps the free plan’s rank and sale fixed', async () => {
    let patched: unknown;
    const api = fakeApi({
      'GET /v1/admin/plans': () => planList(all),
      'PATCH /v1/admin/plans/plus': (call) => {
        patched = call.body;
        return { ...plus, descriptions: { en: 'More likes.' }, quotas: { ...plus.quotas, weekly_superlikes: -1 }, updatedAt: '2026-11-09T13:00:00.000Z' };
      },
    });
    const user = userEvent.setup();
    const { router } = renderPanel('/revenue/plans/plus', api);
    await screen.findByRole('heading', { name: 'Plus' });
    const save = screen.getByRole('button', { name: 'Save changes' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getAllByLabelText(/Short description/)[1]!, 'More likes.');
    await user.click(screen.getByRole('switch', { name: 'Unlimited: Super likes per week' }));
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    await user.click(save);
    await screen.findByText('Saved. The app shows it within seconds.');
    expect(patched).toEqual({ descriptions: { en: 'More likes.' }, quotas: { weekly_superlikes: -1 } });

    await router.navigate('/revenue/plans/free');
    await screen.findByRole('heading', { name: 'Free' });
    expect(screen.getByLabelText<HTMLInputElement>('Upgrade order').disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('switch', { name: 'On sale' }).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Archive plan' })).toBeNull();
  });

  it('asks before archiving, and says people keep the plan', async () => {
    const held = { ...premium, hasLiveSubscriptions: true };
    const api = fakeApi({
      'GET /v1/admin/plans': () => planList([free, plus, held]),
      'POST /v1/admin/plans/premium/archive': () => ({ ...held, active: false, onSale: false, archivedAt: '2026-11-09T14:00:00.000Z', updatedAt: '2026-11-09T14:00:00.000Z' }),
    });
    const user = userEvent.setup();
    renderPanel('/revenue/plans/premium', api);
    await user.click(await screen.findByRole('button', { name: 'Archive plan' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('People hold this plan now: they keep it until their subscription ends.')).toBeTruthy();
    expect(api.of('POST /v1/admin/plans/premium/archive')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Archive plan' }));
    await screen.findByText(/Archived on/);
    expect(api.of('POST /v1/admin/plans/premium/archive')).toHaveLength(1);
  });

  it('turns the API’s refusals into the panel’s words', async () => {
    const api = fakeApi({
      'GET /v1/admin/plans': () => planList(all),
      'PATCH /v1/admin/plans/plus': () => problem(409, 'conflict', { detail: 'Another plan holds this rank.' }),
    });
    const user = userEvent.setup();
    renderPanel('/revenue/plans/plus', api);
    const sort = await screen.findByLabelText('Display order');
    await user.clear(sort);
    await user.type(sort, '7');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('It could not be saved: Another plan holds this rank.');
  });

  it('keeps a read-only role out of every change', async () => {
    signInAs({ ...owner, roles: ['analyst'], permissions: ['billing.read'] });
    const api = fakeApi({ 'GET /v1/admin/plans': () => planList(all) });
    renderPanel('/revenue/plans/plus', api);
    await screen.findByText('Your role can see plans but not change them.');
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    // Every field sits in a disabled fieldset.
    expect(screen.getByLabelText('Display order').matches(':disabled')).toBe(true);
  });
});

describe('the plan editor in Persian', () => {
  it('lays out right to left with the Persian texts', async () => {
    const api = fakeApi({ 'GET /v1/admin/plans': () => planList(all) });
    renderPanel('/revenue/plans/plus', api, { locale: 'fa' });
    await screen.findByRole('heading', { name: 'پلاس' });
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByText('امکانات')).toBeTruthy();
    expect(screen.getAllByLabelText('نام')[0]!.getAttribute('dir')).toBe('rtl');
  });
});
