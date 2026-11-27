import { useLayoutEffect, useRef, type RefObject } from 'react';

interface Span {
  left: number;
  right: number;
}

/** Physical px to scroll a horizontal strip so `item` is centred in `box`; 0 when it is already fully inside. The browser clamps the result. */
export function inlineScrollDelta(box: Span, item: Span): number {
  if (item.left >= box.left - 0.5 && item.right <= box.right + 0.5) return 0;
  return Math.round((item.left + item.right) / 2 - (box.left + box.right) / 2);
}

/** 'smooth', or 'auto' under prefers-reduced-motion. */
export function motionBehavior(): ScrollBehavior {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

/**
 * Keeps the selected [role=tab] inside `strip` in view, on first render and
 * on every change of `value` (and of `layoutKey`, e.g. the locale). Only the
 * strip's own scroll offset moves, never the page (no scrollIntoView).
 * scrollBy with a delta taken from bounding rects is relative, so it is the
 * same in LTR and RTL (where scrollLeft runs negative).
 *
 * After a jump (first render, locale change) the tab widths can still
 * change: styles of a new `lang` settle by the next frame, and web fonts
 * (the new language's face, or a stylesheet that arrives late) finish loading
 * later. The tab is brought back after that frame, once `document.fonts` is
 * ready, and each time a font load completes, until `value` or `layoutKey`
 * change again, or until the strip scrolls to an offset the hook did not
 * leave it at: the person's own scroll of the strip (a drag, a swipe, a
 * wheel, the keyboard) is never undone, while input that does not move the
 * strip (a vertical wheel or page swipe over it, a tap) stops nothing.
 */
export function useSelectedInView(strip: RefObject<HTMLElement | null>, value: string, layoutKey: string): void {
  const shown = useRef<string | null>(null);
  useLayoutEffect(() => {
    const element = strip.current;
    if (!element) return;
    // Animate only a real change; the first render, a StrictMode re-run and a locale change jump.
    const animate = shown.current !== null && shown.current !== value;
    shown.current = value;
    const bring = (behavior: ScrollBehavior) => {
      const item = element.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      if (!item) return;
      const left = inlineScrollDelta(element.getBoundingClientRect(), item.getBoundingClientRect());
      if (left !== 0) element.scrollBy?.({ left, behavior });
    };
    bring(animate ? motionBehavior() : 'auto');
    if (animate) return;
    let alive = true;
    /** The offset the hook last left the strip at (read after its own instant scroll, and after any clamp by layout). */
    let settled = element.scrollLeft;
    const again = () => {
      if (!alive) return;
      bring('auto');
      settled = element.scrollLeft;
    };
    const fonts = (document as { fonts?: FontFaceSet }).fonts;
    const whenFontsReady = () => {
      if (fonts?.status === 'loading') void fonts.ready.then(again);
    };
    // A scroll event is dispatched after the scroll it reports: an offset the hook left is its own scroll.
    const moved = () => {
      if (Math.abs(element.scrollLeft - settled) >= 1) detach();
    };
    const detach = () => {
      alive = false;
      fonts?.removeEventListener?.('loadingdone', again);
      element.removeEventListener('scroll', moved);
    };
    whenFontsReady();
    fonts?.addEventListener?.('loadingdone', again);
    element.addEventListener('scroll', moved, { passive: true });
    const frame = typeof window.requestAnimationFrame === 'function' ? window.requestAnimationFrame(() => {
      again();
      whenFontsReady();
    }) : undefined;
    return () => {
      detach();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [strip, value, layoutKey]);
}
