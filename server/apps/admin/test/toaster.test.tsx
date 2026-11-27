import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { Preferences } from '../src/components/layout/Preferences';
import { Toaster } from '../src/components/layout/Toaster';
import { I18nProvider } from '../src/i18n/I18nProvider';
import { messages } from '../src/i18n/messages';
import { ApiError } from '../src/lib/http';
import { problemText } from '../src/lib/problemText';
import { ThemeProvider } from '../src/lib/theme';
import { resetToastsForTests, showToast } from '../src/lib/toast';
import { fakeApi, owner, plan, planList, renderPanel, resetPanel, signInAs } from './panel';

/**
 * A notice is worded when it is drawn, in the panel's language of that
 * moment: its sentence takes the panel's direction (no `unicode-bidi:
 * plaintext`, which would let a value at its start, a Latin name or "API",
 * turn a Persian sentence around), and each value in it sits in its own
 * first-strong isolate (U+2068 ... U+2069), so a value in the other script
 * keeps its own order without moving the sentence's punctuation. A notice
 * on screen during a language switch, and one pushed by a request sent
 * before the switch, are in the new language.
 */

const FSI = '⁨';
const PDI = '⁩';

afterEach(() => {
  act(() => resetToastsForTests());
});

function renderToaster(): void {
  render(
    <ThemeProvider>
      <I18nProvider>
        <Preferences />
        <Toaster />
      </I18nProvider>
    </ThemeProvider>,
  );
}

const pick = (label: string, locale: string) => fireEvent.change(screen.getByLabelText(label), { target: { value: locale } });

/** The text element of each notice on screen. */
function notices(): HTMLElement[] {
  return Array.from(screen.getByRole('status').children, (toast) => toast.querySelector<HTMLElement>(':scope > span')!);
}

function expectPanelDirection(text: HTMLElement): void {
  expect(text.className).not.toContain('bidi-plain');
  // No element between the notice and <html> sets a direction of its own.
  expect(text.closest('[dir]')).toBe(document.documentElement);
}

describe('the toaster', () => {
  it('lays a Persian notice out right to left, with a Latin name or an API detail isolated', () => {
    renderToaster();
    pick(messages.en['language.label'], 'fa');
    expect(document.documentElement.dir).toBe('rtl');

    act(() => showToast((t) => t('admins.saved', { name: 'Sara' })));
    const invalid = new ApiError(400, 'validation_failed', 'Invalid request', [{ in: 'body', pointer: '/name', code: 'too_small', message: 'name is required.' }]);
    act(() => showToast((t) => problemText(invalid, t), 'error'));

    const [saved, refused] = notices();
    expect(saved!.textContent).toBe(`${FSI}Sara${PDI} ذخیره شد.`);
    expect(refused!.textContent).toBe(`API نپذیرفت: ${FSI}name is required.${PDI}`);
    expectPanelDirection(saved!);
    expectPanelDirection(refused!);
  });

  it('lays an English notice out left to right, with a Persian name isolated', () => {
    renderToaster();
    expect(document.documentElement.dir).toBe('ltr');
    act(() => showToast((t) => t('admins.saved', { name: 'سارا' })));
    const [saved] = notices();
    expect(saved!.textContent).toBe(`${FSI}سارا${PDI} saved.`);
    expectPanelDirection(saved!);
  });

  it('words a notice on screen again when the language changes', () => {
    renderToaster();
    pick(messages.en['language.label'], 'fa');
    act(() => showToast((t) => t('common.saved')));
    expect(notices().map((text) => text.textContent)).toEqual([messages.fa['common.saved']]);

    pick(messages.fa['language.label'], 'en');
    expect(document.documentElement.dir).toBe('ltr');
    expect(notices().map((text) => text.textContent)).toEqual([messages.en['common.saved']]);
  });
});

describe('a notice from a request sent before a language switch', () => {
  it('is in the language chosen meanwhile', async () => {
    resetPanel();
    signInAs(owner);
    const plus = plan('plus', { rank: 1, sort: 1, names: { en: 'Plus', fa: 'پلاس' } });
    let answer: ((body: unknown) => void) | undefined;
    const api = fakeApi({
      'GET /v1/admin/plans': () => planList([plan('free'), plus]),
      'PATCH /v1/admin/plans/plus': () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    const user = userEvent.setup();
    renderPanel('/revenue/plans/plus', api, { locale: 'fa' });
    const sort = await screen.findByLabelText(messages.fa['plan.sort']);
    await user.clear(sort);
    await user.type(sort, '7');
    await user.click(screen.getByRole('button', { name: messages.fa['form.save'] }));
    await expect.poll(() => answer).toBeDefined();

    // The save is on its way; the admin switches to English before the answer.
    pick(messages.fa['language.label'], 'en');
    expect(document.documentElement.dir).toBe('ltr');
    act(() => answer!({ ...plus, sort: 7, updatedAt: '2026-11-09T13:00:00.000Z' }));

    await waitFor(() => expect(notices()).toHaveLength(1));
    expect(notices().map((text) => text.textContent)).toEqual([messages.en['plan.saved']]);
  });
});
