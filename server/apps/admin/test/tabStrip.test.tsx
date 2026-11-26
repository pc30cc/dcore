import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { inlineScrollDelta } from '../src/lib/useSelectedInView';
import { moderator, page } from './moderationFixtures';
import { fakeApi, renderPanel, resetPanel, signInAs } from './panel';
import { detail, fullAdmin, SARA } from './userFixtures';

/**
 * A tab strip wider than its column keeps the selected tab in view: on a deep
 * link, on a navigation and on a click, in both directions, moving only the
 * strip's own scroll offset. jsdom has no layout, so the strip is a 390 px
 * box with 16 px padding and every tab is 100 px wide, placed from the
 * strip's start edge (the right one in RTL) and moved by its scrollLeft.
 */

const VIEW = 390;
const PAD = 16;
const TAB = 100;
/** Every tab's width now: a web font that finishes loading changes it. */
let tabWidth = TAB;

function rect(left: number, width: number): DOMRect {
  return { left, right: left + width, width, x: left, top: 0, bottom: 40, y: 0, height: 40, toJSON: () => ({}) };
}

const rtl = (el: Element) => el.closest('[dir]')?.getAttribute('dir') === 'rtl';
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

let scrollBy: Mock<(this: HTMLElement, options: ScrollToOptions) => void>;
let windowScroll: ReturnType<typeof vi.spyOn>;
let intoView: ReturnType<typeof vi.spyOn>;
const media = window.matchMedia;

beforeEach(() => {
  resetPanel();
  tabWidth = TAB;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.matches('[data-slot="tabs-scroller"]')) return rect(0, VIEW);
    const strip = this.closest<HTMLElement>('[data-slot="tabs-scroller"]');
    if (strip && this.getAttribute('role') === 'tab') {
      const index = [...(this.parentElement?.children ?? [])].indexOf(this);
      const start = PAD + index * tabWidth;
      const x0 = rtl(this) ? VIEW - start - tabWidth : start;
      return rect(x0 - strip.scrollLeft, tabWidth);
    }
    return rect(0, 0);
  });
  scrollBy = vi.fn(function (this: HTMLElement, options: ScrollToOptions) {
    const count = this.querySelectorAll('[role="tab"]').length;
    const max = Math.max(0, 2 * PAD + count * tabWidth - VIEW);
    const next = this.scrollLeft + (options.left ?? 0);
    const tab = this.querySelector('[role="tab"]');
    this.scrollLeft = tab && rtl(tab) ? clamp(next, -max, 0) : clamp(next, 0, max);
  });
  Object.defineProperty(Element.prototype, 'scrollBy', { configurable: true, writable: true, value: scrollBy });
  windowScroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  intoView = vi.spyOn(Element.prototype, 'scrollIntoView');
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (Element.prototype as { scrollBy?: unknown }).scrollBy;
  window.matchMedia = media;
});

function stripOf(tab: HTMLElement): HTMLElement {
  const strip = tab.closest<HTMLElement>('[data-slot="tabs-scroller"]');
  if (!strip) throw new Error('the tab is not in a scrolling strip');
  return strip;
}

function expectInStrip(tab: HTMLElement): void {
  const box = tab.getBoundingClientRect();
  expect(box.left, 'left edge').toBeGreaterThanOrEqual(0);
  expect(box.right, 'right edge').toBeLessThanOrEqual(VIEW);
}

function lastScroll(): ScrollToOptions | undefined {
  return scrollBy.mock.calls.at(-1)?.[0];
}

function userApi() {
  return fakeApi({
    [`GET /v1/admin/users/${SARA}`]: () => detail(),
    [`GET /v1/admin/users/${SARA}/photos`]: () => ({ items: [] }),
    [`GET /v1/admin/users/${SARA}/devices`]: () => ({ items: [] }),
    [`GET /v1/admin/users/${SARA}/sessions`]: () => ({ items: [] }),
    [`GET /v1/admin/users/${SARA}/consents`]: () => ({ items: [] }),
    [`GET /v1/admin/users/${SARA}/audit`]: () => ({ items: [], nextCursor: null }),
  });
}

describe('the user page tab strip', () => {
  it.each([
    ['devices', 'Devices', 'دستگاه‌ها'],
    ['sessions', 'Sessions', 'نشست‌ها'],
    ['consents', 'Consents', 'رضایت‌ها'],
    ['audit', 'Audit log', 'لاگ ممیزی'],
  ])('brings ?tab=%s into view on a deep link, in both directions, without scrolling the page', async (id, en, fa) => {
    signInAs(fullAdmin);
    for (const [locale, name] of [
      ['en', en],
      ['fa', fa],
    ] as const) {
      scrollBy.mockClear();
      const view = renderPanel(`/users/${SARA}?tab=${id}`, userApi(), { locale });
      const tab = await screen.findByRole('tab', { name, selected: true });
      await waitFor(() => expectInStrip(tab));
      const strip = stripOf(tab);
      if (locale === 'en') expect(strip.scrollLeft).toBeGreaterThan(0);
      else expect(strip.scrollLeft).toBeLessThan(0);
      expect(lastScroll()?.behavior).toBe('auto');
      expect(lastScroll()).not.toHaveProperty('top');
      expect(windowScroll).not.toHaveBeenCalled();
      expect(intoView).not.toHaveBeenCalled();
      view.unmount();
    }
  });

  it('leaves a visible tab alone and brings a tab opened by navigation in smoothly', async () => {
    signInAs(fullAdmin);
    const { router } = renderPanel(`/users/${SARA}`, userApi());
    await screen.findByRole('tab', { name: 'Profile', selected: true });
    expect(scrollBy).not.toHaveBeenCalled();
    await act(async () => {
      await router.navigate(`/users/${SARA}?tab=consents`);
    });
    const tab = await screen.findByRole('tab', { name: 'Consents', selected: true });
    await waitFor(() => expectInStrip(tab));
    expect(lastScroll()?.behavior).toBe('smooth');
    expect(windowScroll).not.toHaveBeenCalled();
  });

  it('jumps instead of animating under reduced motion', async () => {
    window.matchMedia = (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    });
    signInAs(fullAdmin);
    const user = userEvent.setup();
    const { router } = renderPanel(`/users/${SARA}`, userApi());
    await user.click(await screen.findByRole('tab', { name: 'Sessions' }));
    const tab = await screen.findByRole('tab', { name: 'Sessions', selected: true });
    await waitFor(() => expectInStrip(tab));
    expect(lastScroll()?.behavior).toBe('auto');
    expect(router.state.location.search).toBe('?tab=sessions');
  });
});

describe('the tab strip after a change of language or font', () => {
  it('measures a language switch in the new direction and language, and keeps the tab in view', async () => {
    signInAs(fullAdmin);
    const user = userEvent.setup();
    renderPanel(`/users/${SARA}?tab=audit`, userApi());
    const before = await screen.findByRole('tab', { name: 'Audit log', selected: true });
    await waitFor(() => expectInStrip(before));
    expect(stripOf(before).scrollLeft).toBeGreaterThan(0);
    // What <html> says each time the strip moves: the font stack follows its lang.
    const seen: string[] = [];
    scrollBy.mockClear();
    const move = scrollBy.getMockImplementation()!;
    scrollBy.mockImplementation(function (this: HTMLElement, options: ScrollToOptions) {
      seen.push(`${document.documentElement.lang}/${document.documentElement.dir}`);
      move.call(this, options);
    });
    await user.selectOptions(screen.getAllByLabelText('Language')[0]!, 'fa');
    const tab = await screen.findByRole('tab', { name: 'لاگ ممیزی', selected: true });
    await waitFor(() => expectInStrip(tab));
    expect(stripOf(tab).scrollLeft).toBeLessThan(0);
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(['fa/rtl']));
    expect(windowScroll).not.toHaveBeenCalled();
  });

  it('brings the tab back once a web font finishes loading and the tabs grow', async () => {
    const fonts = Object.assign(new EventTarget(), { status: 'loaded', ready: Promise.resolve() });
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
    try {
      signInAs(fullAdmin);
      renderPanel(`/users/${SARA}?tab=consents`, userApi());
      const tab = await screen.findByRole('tab', { name: 'Consents', selected: true });
      await waitFor(() => expectInStrip(tab));
      // The face arrives: every tab is wider, the selected one now past the end edge.
      tabWidth = 160;
      expect(tab.getBoundingClientRect().right).toBeGreaterThan(VIEW);
      act(() => {
        fonts.dispatchEvent(new Event('loadingdone'));
      });
      await waitFor(() => expectInStrip(tab));
      expect(lastScroll()?.behavior).toBe('auto');
    } finally {
      delete (document as { fonts?: unknown }).fonts;
    }
  });
});

describe('the reports page tab strip', () => {
  it.each([
    ['tr', 'Kapatılan'],
    ['fa', 'بسته‌شده'],
  ] as const)('keeps the closed view in view in %s', async (locale, name) => {
    signInAs(moderator);
    renderPanel('/moderation/reports?view=resolved', fakeApi({ 'GET /v1/admin/reports': () => page([]) }), { locale });
    const tab = await screen.findByRole('tab', { name, selected: true });
    await waitFor(() => expectInStrip(tab));
    const strip = stripOf(tab);
    if (locale === 'tr') expect(strip.scrollLeft).toBeGreaterThan(0);
    else expect(strip.scrollLeft).toBeLessThan(0);
  });
});

describe('inlineScrollDelta', () => {
  const box = { left: 0, right: 390 };

  it('is 0 for an item fully inside', () => {
    expect(inlineScrollDelta(box, { left: 16, right: 116 })).toBe(0);
    expect(inlineScrollDelta(box, { left: 290, right: 390 })).toBe(0);
  });

  it('centres an item past the end edge (positive) or the start edge in RTL (negative)', () => {
    expect(inlineScrollDelta(box, { left: 816, right: 916 })).toBe(866 - 195);
    expect(inlineScrollDelta(box, { left: -526, right: -426 })).toBe(-476 - 195);
  });

  it('moves an item clipped by a single pixel', () => {
    expect(inlineScrollDelta(box, { left: 291, right: 391 })).not.toBe(0);
    expect(inlineScrollDelta(box, { left: -1, right: 99 })).not.toBe(0);
  });
});
