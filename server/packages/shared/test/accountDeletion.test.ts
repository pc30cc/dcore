import { describe, expect, it } from 'vitest';
import {
  accountDeletionConfirmBody,
  accountDeletionErrorId,
  accountDeletionFormErrors,
  accountDeletionGoogleBody,
  accountDeletionPagePath,
  accountDeletionRedirect,
  accountDeletionStartBody,
  asciiDigits,
} from '../src/index.js';

describe('account deletion redirects', () => {
  it('sends each step to its page in the visitor language', () => {
    expect(accountDeletionPagePath('fa', 'request')).toBe('/fa/delete-account/');
    expect(accountDeletionPagePath('en', 'verify')).toBe('/en/delete-account/verify/');
    expect(accountDeletionRedirect('https://example.com', 'tr', 'done')).toBe('https://example.com/tr/delete-account/done/');
  });

  it('carries the request token and names the error in the query and the fragment', () => {
    expect(accountDeletionRedirect('https://example.com', 'en', 'verify', { requestToken: 'abc_DEF-123' })).toBe(
      'https://example.com/en/delete-account/verify/?r=abc_DEF-123',
    );
    expect(accountDeletionRedirect('https://example.com', 'fa', 'verify', { error: 'otp_invalid' })).toBe(
      'https://example.com/fa/delete-account/verify/?e=otp_invalid#e-otp_invalid',
    );
  });

  it('turns an unknown problem code into the generic error', () => {
    expect(accountDeletionRedirect('https://example.com', 'en', 'request', { error: 'internal' })).toBe(
      'https://example.com/en/delete-account/?e=error#e-error',
    );
    for (const code of accountDeletionFormErrors) expect(accountDeletionErrorId(code)).toMatch(/^e-[a-z_]+$/);
  });
});

describe('account deletion bodies', () => {
  it('reads digits typed on a Persian or Arabic keyboard', () => {
    expect(asciiDigits('۰۹۱۲ ٣٤٥')).toBe('0912 345');
    expect(accountDeletionStartBody.parse({ phone: ' +۹۸ ۹۱۲ ۱۲۳ ۴۵۶۷ ', locale: 'fa' })).toEqual({
      phone: '+98 912 123 4567',
      locale: 'fa',
    });
    expect(accountDeletionConfirmBody.parse({ phone: '+905321234567', code: '۱۲۳ ۴۵۶', locale: 'tr' })).toEqual({
      phone: '+905321234567',
      code: '123456',
      locale: 'tr',
    });
  });

  it('accepts a request token or a phone number with the code', () => {
    expect(accountDeletionConfirmBody.safeParse({ requestToken: 'x'.repeat(32), code: '123456' }).success).toBe(true);
    expect(accountDeletionConfirmBody.safeParse({ code: '123456', locale: 'en' }).success).toBe(false);
  });

  it('refuses what is not a phone number, a code or a locale', () => {
    expect(accountDeletionStartBody.safeParse({ phone: 'call me', locale: 'en' }).success).toBe(false);
    expect(accountDeletionStartBody.safeParse({ phone: '+905321234567', locale: 'de' }).success).toBe(false);
    expect(accountDeletionConfirmBody.safeParse({ phone: '+905321234567', code: '12ab56', locale: 'en' }).success).toBe(false);
    expect(accountDeletionGoogleBody.safeParse({ idToken: '' }).success).toBe(false);
  });
});
