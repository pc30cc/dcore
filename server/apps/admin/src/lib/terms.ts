import { bannedTermMatch, bannedTermScope, bannedTermSeverity, type AdminBannedTerm, type BannedTermMatch, type BannedTermScope, type BannedTermSeverity, type Locale } from '@app/shared';
import type { MessageKey } from '@/i18n/messages';

/** Banned terms in the panel: the choices of the form and the words the API's refusals map to. */

export const termMatches: readonly BannedTermMatch[] = bannedTermMatch.names;
export const termSeverities: readonly BannedTermSeverity[] = bannedTermSeverity.names;
export const termScopes: readonly BannedTermScope[] = bannedTermScope.names;
export const termLocales: readonly Locale[] = ['fa', 'en', 'tr'];

export const severityTone: Readonly<Record<BannedTermSeverity, 'secondary' | 'warning' | 'destructive'>> = {
  ask: 'secondary',
  flag: 'warning',
  refuse: 'destructive',
};

export interface TermForm {
  term: string;
  match: BannedTermMatch;
  severity: BannedTermSeverity;
  scope: BannedTermScope[];
  locale: Locale | '';
  active: boolean;
}

export function termFormOf(term: AdminBannedTerm | null): TermForm {
  return term
    ? { term: term.term, match: term.match, severity: term.severity, scope: [...term.scope], locale: term.locale ?? '', active: term.active }
    : { term: '', match: 'word', severity: 'refuse', scope: ['name', 'about', 'prompts', 'messages', 'job'], locale: '', active: true };
}

/** The body of a create, or of an edit: only the fields that changed. */
export function termBody(form: TermForm, before: AdminBannedTerm | null): Record<string, unknown> {
  const full = { term: form.term, match: form.match, severity: form.severity, scope: termScopes.filter((s) => form.scope.includes(s)), locale: form.locale === '' ? null : form.locale, active: form.active };
  if (!before) return full;
  const was = { term: before.term, match: before.match, severity: before.severity, scope: before.scope, locale: before.locale, active: before.active };
  return Object.fromEntries(Object.entries(full).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(was[key as keyof typeof was])));
}

/** The field code of a refused term, as words. */
export const termProblems: Readonly<Record<string, MessageKey>> = {
  term_empty: 'terms.error.empty',
  regex_invalid: 'terms.error.regexInvalid',
  regex_unsupported: 'terms.error.regexUnsupported',
  regex_word_boundary: 'terms.error.regexWordBoundary',
  regex_too_large: 'terms.error.regexTooLarge',
  regex_too_broad: 'terms.error.regexTooBroad',
};
