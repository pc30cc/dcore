/// <reference types="node" />
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buttonVariants } from '@/components/ui/button';

/**
 * The filled destructive button keeps white text readable (WCAG AA, 4.5:1
 * for 14 px text) in both themes: the colours are read from index.css and
 * the button's own classes, so a change to either is checked.
 */

const css = readFileSync(path.resolve(import.meta.dirname, '../src/index.css'), 'utf8');

function token(block: ':root' | '.dark', name: string): [number, number, number] {
  const body = new RegExp(`${block.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
  const value = new RegExp(`--${name}:\\s*oklch\\(([^)]*)\\)`).exec(body)?.[1];
  if (!value) throw new Error(`no ${block} --${name}`);
  const [l, c, h] = value.trim().split(/\s+/).map(Number) as [number, number, number];
  return [l, c, h];
}

/** OKLCH to linear sRGB (0-1, clipped). */
function linear([l, c, h]: [number, number, number]): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clip = (x: number) => Math.min(1, Math.max(0, x));
  return [
    clip(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    clip(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    clip(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
  ];
}

const encode = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
const decode = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);

/** `top` at `alpha` over `under`, mixed as the browser does (in sRGB). */
function over(top: [number, number, number], alpha: number, under: [number, number, number]): [number, number, number] {
  return top.map((t, i) => decode(alpha * encode(t) + (1 - alpha) * encode(under[i]!))) as [number, number, number];
}

const luminance = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const contrastWithWhite = (rgb: [number, number, number]) => 1.05 / (luminance(rgb) + 0.05);

describe('the destructive button', () => {
  const classes = buttonVariants({ variant: 'destructive' }).split(/\s+/);

  it('has white text on a red that reads in light mode', () => {
    expect(classes).toContain('text-white');
    expect(contrastWithWhite(linear(token(':root', 'destructive')))).toBeGreaterThanOrEqual(4.5);
  });

  it('dims its red in dark mode so the white text still reads, on the page and in a dialog', () => {
    const dark = classes.find((c) => /^dark:bg-destructive\/\d+$/.test(c));
    expect(dark, 'a dark fill of its own').toBeDefined();
    const alpha = Number(dark!.split('/')[1]) / 100;
    const red = linear(token('.dark', 'destructive'));
    // The full red alone does not (the reason for the dark fill).
    expect(contrastWithWhite(red)).toBeLessThan(4.5);
    for (const surface of ['background', 'popover', 'card'] as const) {
      expect(contrastWithWhite(over(red, alpha, linear(token('.dark', surface)))), surface).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('the chart colours', () => {
  const contrast = (a: [number, number, number], b: [number, number, number]) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };

  it('stand out from the card (3:1, graphics) in both themes', () => {
    for (const block of [':root', '.dark'] as const) {
      const card = linear(token(block, 'card'));
      for (const slot of [1, 2, 3, 4, 5]) expect(contrast(linear(token(block, `chart-${slot}`)), card), `${block} --chart-${slot}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('are told apart from each other in a chart of three (slots 1-3, normal vision)', () => {
    for (const block of [':root', '.dark'] as const) {
      const [a, b, c] = [1, 2, 3].map((slot) => token(block, `chart-${slot}`));
      // Hue angles at least 60° apart, so the three read as different colours.
      for (const [x, y] of [[a!, b!], [b!, c!], [a!, c!]] as const) {
        const apart = Math.abs(x[2] - y[2]) % 360;
        expect(Math.min(apart, 360 - apart), block).toBeGreaterThanOrEqual(60);
      }
    }
  });
});
