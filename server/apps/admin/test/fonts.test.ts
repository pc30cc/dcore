import { afterEach, describe, expect, it } from 'vitest';
import { applyRuntimeFont } from '../src/lib/fonts';

describe('the run-time Persian font', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('--font-persian');
    document.head.querySelectorAll('link[data-runtime-font]').forEach((link) => link.remove());
  });

  it("adds its stylesheet once and puts its family first for Persian, before the brand's", () => {
    const font = { cssUrl: 'https://fonts.example.com/kit/fa.css', family: 'Brand Sans' };
    applyRuntimeFont(font);
    applyRuntimeFont(font);
    const links = document.head.querySelectorAll('link[data-runtime-font]');
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toBe(font.cssUrl);
    // The test brand's Persian family (vitest.config.ts) follows the run-time one.
    expect(document.documentElement.style.getPropertyValue('--font-persian')).toBe('"Brand Sans", "Vazirmatn"');
  });

  it("names the brand's family once when the run-time font is the same family", () => {
    applyRuntimeFont({ cssUrl: 'https://fonts.example.com/kit/fa.css', family: 'vazirmatn' });
    expect(document.documentElement.style.getPropertyValue('--font-persian')).toBe('"vazirmatn"');
    applyRuntimeFont({ cssUrl: 'https://fonts.example.com/kit/fa.css', family: 'Vazirmatn' });
    expect(document.documentElement.style.getPropertyValue('--font-persian')).toBe('"Vazirmatn"');
  });

  it('does nothing without one (no font file is part of the build)', () => {
    applyRuntimeFont(null);
    expect(document.head.querySelectorAll('link')).toHaveLength(0);
    expect(document.documentElement.style.getPropertyValue('--font-persian')).toBe('');
  });
});
