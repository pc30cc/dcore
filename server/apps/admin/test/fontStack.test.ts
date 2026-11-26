// @vitest-environment node
/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { compile } from 'tailwindcss';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The panel's font stack as Tailwind compiles index.css: every rule that sets
 * the UI font reads one custom property, which the lang rules set in the base
 * layer, so the Persian stack (and a run-time --font-persian) reaches the
 * page. An inline theme value would be copied into each rule as a literal and
 * leave the lang rules without effect.
 */

const SRC = path.resolve(import.meta.dirname, '../src');
const source = readFileSync(path.join(SRC, 'index.css'), 'utf8');
const require = createRequire(import.meta.url);

async function compiled(): Promise<string> {
  const compiler = await compile(source, {
    base: SRC,
    loadStylesheet: async (id, base) => {
      if (id === 'tailwindcss') {
        const file = require.resolve('tailwindcss/index.css');
        return { path: file, base: path.dirname(file), content: readFileSync(file, 'utf8') };
      }
      // Animations only; the package exports a "style" condition alone.
      if (id === 'tw-animate-css') return { path: id, base, content: '' };
      const file = path.resolve(base, id);
      return { path: file, base: path.dirname(file), content: readFileSync(file, 'utf8') };
    },
  });
  return compiler.build(['font-sans', 'font-mono']);
}

/** Every `selector { body }` at any depth, with the @-rules (layers) around it. */
function rules(css: string): { selector: string; body: string; within: string[] }[] {
  const found: { selector: string; body: string; within: string[] }[] = [];
  const stack: string[] = [];
  let start = 0;
  for (let i = 0; i < css.length; i += 1) {
    const c = css[i];
    if (c === '{') {
      stack.push(css.slice(start, i).trim());
      start = i + 1;
    } else if (c === '}') {
      const selector = stack.pop() ?? '';
      const body = css.slice(start, i);
      if (!selector.startsWith('@') && !body.includes('{')) found.push({ selector, body, within: stack.filter((s) => s.startsWith('@')) });
      start = i + 1;
    } else if (c === ';' && stack.length > 0 && css.lastIndexOf('{', i) < css.lastIndexOf('}', i)) {
      // A declaration after a nested block: the next selector starts after it.
      start = i + 1;
    }
  }
  return found;
}

function declarations(body: string, property: string): string[] {
  return [...body.matchAll(new RegExp(`(?:^|[;{\\s])${property.replace(/[-]/g, '\\-')}\\s*:\\s*([^;]+)`, 'g'))].map((m) => m[1]!.trim());
}

const SINGLE_VAR = /^var\(\s*(--[A-Za-z0-9-]+)\s*\)$/;

describe('the font stack of the panel', () => {
  let css = '';
  let all: ReturnType<typeof rules> = [];
  let property = '';

  beforeAll(async () => {
    css = await compiled();
    all = rules(css);
    const body = all.find((r) => r.selector === 'body');
    const family = declarations(body?.body ?? '', 'font-family')[0] ?? '';
    property = SINGLE_VAR.exec(family)?.[1] ?? '';
  });

  it('sets the body, .font-sans and the default family from one custom property', () => {
    expect(property, 'body font-family is one var()').toMatch(/^--[a-z-]+$/);
    const sans = all.find((r) => r.selector === '.font-sans');
    expect(declarations(sans?.body ?? '', 'font-family')).toEqual([`var(${property})`]);
    const defaults = all.flatMap((r) => declarations(r.body, '--default-font-family'));
    expect(defaults.length).toBeGreaterThan(0);
    for (const value of defaults) expect(value).toBe(`var(${property})`);
  });

  it('sets that property per language in the base layer: Latin by default, Persian for fa', () => {
    const setters = all.filter((r) => declarations(r.body, property).length > 0);
    expect(setters.length).toBeGreaterThan(0);
    for (const rule of setters) expect(rule.within.some((at) => /^@layer\s+base\b/.test(at)), rule.selector).toBe(true);
    const fa = setters.find((r) => /\[lang\|="?fa"?\]|html\[lang="?fa"?\]/.test(r.selector));
    const [persian] = declarations(fa?.body ?? '', property);
    expect(persian).toMatch(/^var\(--font-persian\)/);
    expect(persian).toContain('Tahoma');
    const root = setters.find((r) => r.selector.split(',').map((s) => s.trim()).includes(':root'));
    expect(declarations(root?.body ?? '', property)[0]).toMatch(/^var\(--font-latin\)/);
  });

  it('never copies a brand family into a font-family directly', () => {
    for (const rule of all) {
      for (const value of declarations(rule.body, 'font-family')) {
        expect(value, rule.selector).not.toContain('var(--font-latin)');
        expect(value, rule.selector).not.toContain('var(--font-persian)');
      }
    }
  });

  it('leaves the mono stack to its own theme variable', () => {
    const mono = all.find((r) => r.selector === '.font-mono');
    expect(declarations(mono?.body ?? '', 'font-family')).toEqual(['var(--font-mono)']);
    const themeRoot = all.find((r) => /:root,\s*:host/.test(r.selector) && declarations(r.body, '--font-mono').length > 0);
    expect(themeRoot).toBeDefined();
  });

  it('declares inline theme variables nowhere else, and no script overrides one', () => {
    const inline = /@theme\s+inline\s*\{([^}]*)\}/.exec(source)?.[1] ?? '';
    const names = [...inline.matchAll(/(--[A-Za-z0-9-]+)\s*:/g)].map((m) => m[1]!);
    expect(names).toContain('--font-sans');
    const outside = source.replace(/@theme\s+inline\s*\{[^}]*\}/, '');
    for (const name of names) expect(outside, name).not.toMatch(new RegExp(`${name}\\s*:`));
    const scripts = files(SRC).filter((file) => /\.(ts|tsx)$/.test(file));
    expect(scripts.length).toBeGreaterThan(0);
    for (const file of scripts) {
      const text = readFileSync(file, 'utf8');
      for (const name of names) expect(text, `${path.relative(SRC, file)} sets ${name}`).not.toContain(`setProperty('${name}'`);
    }
  });
});

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}
