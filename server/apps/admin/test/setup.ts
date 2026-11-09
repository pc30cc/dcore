import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// Pages load lazily: the first import of a page can take a moment in the test runner.
configure({ asyncUtilTimeout: 5_000 });

// What jsdom lacks and the panel's components use.
if (typeof window !== 'undefined') {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe = (): void => undefined;
    unobserve = (): void => undefined;
    disconnect = (): void => undefined;
  };
  Element.prototype.scrollIntoView ??= () => undefined;
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => undefined;
}

afterEach(() => {
  cleanup();
  try {
    window.localStorage.clear();
  } catch {
    // No storage: nothing to clear.
  }
});
