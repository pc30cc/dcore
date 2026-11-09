import { describe, expect, it } from 'vitest';
import { applyRuntimeFont } from '../src/lib/fonts';

describe('the run-time Persian font', () => {
  it('adds its stylesheet once and puts its family first for Persian', () => {
    const font = { cssUrl: 'https://fonts.example.com/kit/fa.css', family: 'Brand Sans' };
    applyRuntimeFont(font);
    applyRuntimeFont(font);
    const links = document.head.querySelectorAll('link[data-runtime-font]');
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toBe(font.cssUrl);
    expect(document.documentElement.style.getPropertyValue('--font-persian')).toBe('"Brand Sans"');
  });

  it('does nothing without one (no font file is part of the build)', () => {
    document.head.querySelectorAll('link[data-runtime-font]').forEach((link) => link.remove());
    applyRuntimeFont(null);
    expect(document.head.querySelectorAll('link')).toHaveLength(0);
  });
});
