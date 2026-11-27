import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { Preferences } from '../src/components/layout/Preferences';
import { Toaster } from '../src/components/layout/Toaster';
import { I18nProvider } from '../src/i18n/I18nProvider';
import { isolatedNodes } from '../src/i18n/isolates';
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
 * <bdi> (a first-strong isolate), so a value in the other script keeps its
 * own order without moving the sentence's punctuation. The isolates are
 * markup, never characters in the text: copied text and the accessible
 * name carry none. A notice on screen during a language switch, and one
 * pushed by a request sent before the switch, are in the new language.
 */

/** Isolate characters (LRI, RLI, FSI, PDI). */
const ISOLATES = /[\u2066-\u2069]/;

afterEach(() => {
  act(() => resetToastsForTests());
});

function renderToaster(): void {
  // English until a test picks another language (ADMIN_DEFAULT_LOCALE=en).
  resetPanel();
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

/** The text of each <bdi> in a notice, and whether it sets a direction. */
function isolated(text: HTMLElement): { text: string; dir: string | null }[] {
  return Array.from(text.querySelectorAll('bdi'), (bdi) => ({ text: bdi.textContent, dir: bdi.getAttribute('dir') }));
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
    act(() => showToast((t, locale) => problemText(invalid, t, locale), 'error'));

    const [saved, refused] = notices();
    expect(saved!.textContent).toBe('Sara ذخیره شد.');
    expect(isolated(saved!)).toEqual([{ text: 'Sara', dir: null }]);
    // The panel's sentence first; the API's English only on a smaller line of its own, isolated.
    expect(refused!.textContent).toBe(`${messages.fa['common.error.invalid']}جزئیات فنی: /name: name is required.`);
    expect(isolated(refused!)).toEqual([{ text: '/name: name is required.', dir: null }]);
    expectPanelDirection(saved!);
    expectPanelDirection(refused!);
  });

  it('lays an English notice out left to right, with a Persian name isolated', () => {
    renderToaster();
    expect(document.documentElement.dir).toBe('ltr');
    act(() => showToast((t) => t('admins.saved', { name: 'سارا' })));
    const [saved] = notices();
    expect(saved!.textContent).toBe('سارا saved.');
    expect(isolated(saved!)).toEqual([{ text: 'سارا', dir: null }]);
    expectPanelDirection(saved!);
  });

  it('leaves no isolate character in the text people copy or hear', () => {
    renderToaster();
    pick(messages.en['language.label'], 'fa');
    act(() => showToast((t) => t('product.deactivated', { id: 'sub.plus_1' })));
    const [off] = notices();
    expect(isolated(off!)).toEqual([{ text: 'sub.plus_1', dir: null }]);
    // textContent is what a copy of the whole notice and its accessible name are made of.
    expect(off!.textContent).not.toMatch(ISOLATES);
    expect(screen.getByRole('status').textContent).not.toMatch(ISOLATES);
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

describe('isolates as markup', () => {
  const html = (text: string) => render(<p>{isolatedNodes(text)}</p>).container.querySelector('p')!.innerHTML;

  it('draws each isolate as a <bdi> of its direction, nested as the isolates are', () => {
    expect(html('plain text')).toBe('plain text');
    expect(html('a \u2068b\u2069 c')).toBe('a <bdi>b</bdi> c');
    expect(html('\u2066+98 912\u2069 \u2067ب\u2069')).toBe('<bdi dir="ltr">+98 912</bdi> <bdi dir="rtl">ب</bdi>');
    expect(html('x \u2068outer \u2068inner\u2069 tail\u2069 y')).toBe('x <bdi>outer <bdi>inner</bdi> tail</bdi> y');
  });

  it('drops a closing mark that closes nothing and ends an open isolate with the text, as UAX #9 does', () => {
    expect(html('a\u2069 b')).toBe('a b');
    expect(html('a \u2068b')).toBe('a <bdi>b</bdi>');
  });
});
