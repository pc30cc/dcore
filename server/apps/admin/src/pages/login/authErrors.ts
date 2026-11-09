import type { MessageKey } from '@/i18n/messages';
import type { TranslateValues } from '@/i18n/translate';
import type { ApiError } from '@/lib/http';

/** The words for a refused sign-in step, from the API's code (never its English detail). */
export function signInProblem(error: ApiError, step: 'password' | 'code'): { key: MessageKey; values?: TranslateValues } {
  switch (error.code) {
    case 'unauthorized':
      return { key: step === 'password' ? 'login.error.credentials' : 'login.error.ticket' };
    case 'otp_invalid':
      return error.attemptsLeft === undefined ? { key: 'login.error.code' } : { key: 'login.error.codeLeft', values: { count: error.attemptsLeft } };
    case 'otp_locked':
      return { key: 'login.error.locked' };
    case 'rate_limited':
      return { key: 'login.error.rateLimited', values: { minutes: Math.max(1, Math.ceil((error.retryAfterSeconds ?? 60) / 60)) } };
    case 'service_unavailable':
      return { key: 'login.error.unavailable' };
    case 'unreachable':
      return { key: 'common.error.unreachable' };
    case 'not_configured':
      return { key: 'common.error.notConfigured' };
    case 'forbidden':
      return { key: 'login.error.origin' };
    default:
      return { key: 'common.error.unexpected' };
  }
}
