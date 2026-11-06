import { describe, expect, it } from 'vitest';
import { interpolate, isLocale, isRtl, placeholders, textDirection } from '../src/index.js';

describe('locales', () => {
  it('knows the right-to-left locales', () => {
    expect(isRtl('fa')).toBe(true);
    expect(isRtl('en')).toBe(false);
    expect(textDirection('fa')).toBe('rtl');
    expect(textDirection('tr')).toBe('ltr');
    expect(isLocale('tr')).toBe(true);
    expect(isLocale('de')).toBe(false);
  });

  it('interpolates placeholders and keeps unknown ones visible', () => {
    expect(interpolate('Welcome to {appName}', { appName: 'X' })).toBe('Welcome to X');
    expect(interpolate('{appName} and {missing}', { appName: 'X' })).toBe('X and {missing}');
    expect(interpolate('{toString}', {})).toBe('{toString}');
    expect(placeholders('{appName} · {supportEmail}')).toEqual(['appName', 'supportEmail']);
  });
});
