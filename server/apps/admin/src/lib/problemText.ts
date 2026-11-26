import type { MessageKey } from '@/i18n/messages';
import type { TranslateValues } from '@/i18n/translate';
import type { ApiError } from './http';

/** The 409s of the moderation decisions, by what the API said. */
const CONFLICTS: Readonly<Record<string, MessageKey>> = {
  'Already decided.': 'queue.alreadyDecided',
  'Already closed.': 'report.alreadyClosed',
  'Already filed.': 'report.alreadyFiled',
  'Someone else took it.': 'report.taken',
  'The photo is still being processed.': 'photos.processing',
  'The profile changed; reload it.': 'texts.stale',
  'The action was lifted.': 'appeals.lifted',
};

/** The words for a known 409; null for any other answer. */
export function conflictText(error: ApiError, t: (key: MessageKey, values?: TranslateValues) => string): string | null {
  if (error.code !== 'conflict') return null;
  const key = CONFLICTS[error.message];
  return key ? t(key) : null;
}

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
      return conflictText(error, t) ?? t('common.error.conflict', { detail: error.message });
    case 'appeal_open':
      return t('problem.appealOpen');
    case 'not_appealable':
      return t('problem.notAppealable');
    case 'rate_limited':
      return error.retryAfterSeconds !== undefined && error.retryAfterSeconds > 60
        ? t('common.error.rateLimitedFor', { minutes: Math.ceil(error.retryAfterSeconds / 60) })
        : t('common.error.rateLimited');
    case 'service_unavailable':
      return t('common.error.unavailable');
    case 'validation_failed':
    case 'field_invalid':
      return t('common.error.invalid', { detail: error.errors.map((issue) => issue.message).join('; ') || error.message });
    default:
      return error.status >= 500 ? t('common.error.server') : t('common.error.unexpected');
  }
}
