import type { en } from './en';

/** The support area's Turkish strings (the same keys and placeholders as English). */
export const tr = {
  'auditTarget.support_reply': 'Hazır yanıt',
  'auditTarget.support_tag': 'Destek etiketi',
} satisfies Record<keyof typeof en, string>;
