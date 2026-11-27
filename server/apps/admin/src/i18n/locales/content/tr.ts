import type { en } from './en';

/** The content area's Turkish strings (the same keys and placeholders as English). */
export const tr = {
  'auditTarget.profile_field': 'Profil alanı',
  'auditTarget.prompt': 'Soru',
} satisfies Record<keyof typeof en, string>;
