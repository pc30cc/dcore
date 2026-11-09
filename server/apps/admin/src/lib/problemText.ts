import type { MessageKey } from '@/i18n/messages';
import type { TranslateValues } from '@/i18n/translate';
import type { ApiError } from './http';

/** A failed admin call in the panel's words; the API's own text only for what the panel has no words for. */
export function problemText(error: ApiError, t: (key: MessageKey, values?: TranslateValues) => string): string {
  switch (error.code) {
    case 'unreachable':
      return t('common.error.unreachable');
    case 'not_configured':
      return t('common.error.notConfigured');
    case 'forbidden':
      return t('access.denied.body');
    case 'unauthorized':
    case 'session_expired':
      return t('login.expired.body');
    case 'not_found':
      return t('common.error.notFound');
    case 'conflict':
      return t('common.error.conflict', { detail: error.message });
    case 'rate_limited':
      return t('common.error.rateLimited');
    case 'service_unavailable':
      return t('common.error.unavailable');
    case 'validation_failed':
    case 'field_invalid':
      return t('common.error.invalid', { detail: error.errors.map((issue) => issue.message).join('; ') || error.message });
    default:
      return error.status >= 500 ? t('common.error.server') : t('common.error.unexpected');
  }
}
