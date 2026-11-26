import { locales, moderationReason, photoRejectReason, textRejectReason, type AdminReasons, type CodeTable, type Locale } from '@app/shared';
import type { ConfigSnapshot } from '../services/cfg.js';
import { label, moderationReasonLabels, photoRejectLabels, textRejectLabels } from '../services/labels.js';

/**
 * The reasons a moderation record carries and the text a person reads for
 * each: the default labels (`services/labels.ts`), overridden per locale by
 * the panel's strings (`moderation.reason.<code>`, `photo.reject.<code>`,
 * `text.reject.<code>`).
 */

export type ReasonTable = 'moderation' | 'photo' | 'text';

const tables = {
  moderation: { codes: moderationReason as CodeTable<string>, labels: moderationReasonLabels, key: 'moderation.reason', fallback: 99 },
  photo: { codes: photoRejectReason as CodeTable<string>, labels: photoRejectLabels, key: 'photo.reject', fallback: 0 },
  text: { codes: textRejectReason as CodeTable<string>, labels: textRejectLabels, key: 'text.reject', fallback: 6 },
} as const;

/** The text a person reads for `code` in `locale`. */
export function reasonTextFor(cfg: ConfigSnapshot, table: ReasonTable, code: number, locale: Locale): string {
  const t = tables[table];
  const key = Object.hasOwn(t.labels, code) ? code : t.fallback;
  return cfg.strings.get(locale)?.[`${t.key}.${key}`] ?? label(t.labels[key], locale, 'Not approved');
}

/** The English text of a reason: what kinds 6, 7 and 10 and a shadowban store as `reason_text` (an internal record). */
export function englishReason(cfg: ConfigSnapshot, table: ReasonTable, code: number): string {
  return reasonTextFor(cfg, table, code, 'en');
}

export function reasonTexts(cfg: ConfigSnapshot, table: ReasonTable, code: number): Record<Locale, string> {
  return Object.fromEntries(locales.map((locale) => [locale, reasonTextFor(cfg, table, code, locale)])) as Record<Locale, string>;
}

/** `GET /v1/admin/moderation/reasons`: every reason of every table with its texts. */
export function reasonsOf(cfg: ConfigSnapshot): AdminReasons {
  const list = (table: ReasonTable) => tables[table].codes.names.map((name) => ({ reason: name, texts: reasonTexts(cfg, table, tables[table].codes.code(name)) }));
  return { moderation: list('moderation'), photo: list('photo'), text: list('text') };
}
