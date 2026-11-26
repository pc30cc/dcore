import { locales, placeholders } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { messages, type MessageKey } from '../src/i18n/messages';
import { translate } from '../src/i18n/translate';

describe('admin strings', () => {
  const keys = Object.keys(messages.en) as MessageKey[];

  it('has every string in every locale, with the same placeholders', () => {
    for (const locale of locales) {
      expect(Object.keys(messages[locale]).sort()).toEqual([...keys].sort());
      for (const key of keys) {
        expect(messages[locale][key].trim(), `${locale}:${key}`).not.toBe('');
        expect(placeholders(messages[locale][key]).sort(), `${locale}:${key}`).toEqual(placeholders(messages.en[key]).sort());
      }
    }
  });

  it('fills the brand name and values', () => {
    expect(translate('en', 'app.title', {}, 'Acme')).toBe('Acme Admin');
    expect(translate('fa', 'section.pending.body', { section: 3 })).toContain('بخش ۳');
    expect(translate('en', 'section.pending.body', { section: 3 })).toContain('3');
  });

  it('writes a number placeholder in the language’s digits, without grouping', () => {
    expect(translate('fa', 'form.counter', { count: 53, max: 1000 })).toBe('۵۳/۱۰۰۰');
    expect(translate('en', 'form.counter', { count: 53, max: 1000 })).toBe('53/1000');
    expect(translate('fa', 'texts.part.prompt', { n: 2 })).toBe('پرسش ۲');
  });
});
