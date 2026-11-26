import { bannedTermMatch, bannedTermScope, type BannedTermMatch, type BannedTermScope } from '@app/shared';
import { RE2JS } from 're2js';
import { foldLetters, foldName } from './cities.js';

/**
 * Banned terms (table banned_terms), held in memory and refreshed with the
 * rest of the configuration.
 *
 * match_kind: 1 substring, 2 whole word, 3 regular expression. A substring or
 * a word is matched on the folded text ({@link foldName}: case, marks,
 * Arabic letter forms, every run of punctuation and spaces one space), so
 * `Ali` and `ali`, `ي` and `ی` match the same term. A regular expression is
 * RE2 syntax, run by a linear-time engine (re2js: no backtracking, so no
 * pattern can take more than a bounded time per character); it sees the text
 * with its letters folded the same way but its punctuation kept
 * ({@link patternText}), and its own literal letters are folded alike, so
 * `^foo\s+bar$`, `t\.me/` or `علي` match what they say.
 * severity: 1 ask, 2 allow and flag for review, 3 refuse.
 * locale: a term of one language is meant for texts in that language. A term
 * written in a script other than Latin (Persian in Arabic script) applies to
 * every text with letters of that script, whatever language the app is set
 * to: the text says what it is, so a header cannot skip the term. A term of
 * Latin letters only (where the text cannot tell English from Turkish)
 * applies to people writing in its language: the app's language of the
 * request, or the person's own (an admin's rename). A term without a
 * language applies to everyone.
 */

export type TermScope = BannedTermScope;

export interface BannedTermRow {
  id: number;
  matchKind: number;
  severity: number;
  scope: number;
  /** null (or absent): every language. */
  locale?: string | null;
  term: string;
}

interface CompiledTerm {
  id: number;
  severity: number;
  scope: number;
  locale: string | null;
  /** The non-Latin scripts the term's letters are in: a text with letters of one of them is checked whatever its language. */
  scripts: readonly Script[];
  regex: boolean;
  /** Tested on ` ${foldName(text)} ` for a substring or a word, on {@link patternText} for a pattern. */
  test: (text: string) => boolean;
}

/** Longest text checked: profile texts are far shorter, and messages stop at 4,000 characters. */
const MAX_CHECKED = 4_000;
/**
 * Largest compiled pattern (RE2 instructions). The engine's time per
 * character grows with the program; at this size a 4,000-character text
 * takes at most a few milliseconds whatever the pattern. A list of words is
 * split into several terms.
 */
export const MAX_PATTERN_INSTRUCTIONS = 100;

export type TermProblemCode = 'term_empty' | 'regex_invalid' | 'regex_unsupported' | 'regex_word_boundary' | 'regex_too_large' | 'regex_too_broad';
export type TermCheck = { ok: true } | { ok: false; code: TermProblemCode; message: string };

/** Scripts whose letters say which texts a language-bound term is for (Latin cannot tell en from tr). */
const SCRIPTS = ['Arabic', 'Cyrillic', 'Greek', 'Hebrew', 'Armenian', 'Georgian', 'Devanagari', 'Thai', 'Han', 'Hangul', 'Hiragana', 'Katakana'] as const;
type Script = (typeof SCRIPTS)[number];
const SCRIPT_LETTER: Readonly<Record<Script, RegExp>> = Object.fromEntries(SCRIPTS.map((name) => [name, new RegExp(`\\p{Script=${name}}`, 'u')])) as Record<
  Script,
  RegExp
>;

function scriptsOf(text: string): Script[] {
  return SCRIPTS.filter((name) => SCRIPT_LETTER[name].test(text));
}

const PERSIAN_DIGITS = /[۰-۹]/g;
const ARABIC_DIGITS = /[٠-٩]/g;

/** Persian and Arabic-Indic digits as ASCII ones (so `0912` and `\d` match `۰۹۱۲`). */
function asciiDigits(value: string): string {
  return value.replace(PERSIAN_DIGITS, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(ARABIC_DIGITS, (d) => String(d.charCodeAt(0) - 0x0660));
}

/**
 * The text a pattern is tested on: letters folded as for words (case, marks,
 * Arabic forms, digits as ASCII), the zero-width non-joiner a space, other
 * invisible format characters (direction marks, zero-width space) dropped,
 * every run of white space one space, trimmed. Punctuation stays.
 */
export function patternText(value: string): string {
  return asciiDigits(foldLetters(value))
    .replaceAll('‌', ' ')
    .replace(/\p{Cf}/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** One character of a pattern folded like the text: a code point, nothing (a mark), or several (a ligature). */
function foldChar(ch: string): string {
  if (ch === '‌') return ' ';
  if (/\p{Cf}/u.test(ch)) return '';
  return asciiDigits(foldLetters(ch));
}

type Folded = { ok: true; source: string } | { ok: false; code: TermProblemCode; message: string };

const UNSUPPORTED_GROUP = 'Only plain and non-capturing groups are supported (no lookaround, named or flagged groups).';

/**
 * The pattern with its literal characters folded like the text, and refused
 * where it leaves what is supported: lookaround, named and flagged groups,
 * backreferences, `\Q…\E` (its text would not be folded), and `\b`/`\B` in a
 * pattern holding other than Latin letters (RE2's word boundary knows ASCII
 * letters only, so it never matches next to a Persian one). Escapes are kept
 * as written. Whether the rest is valid RE2 is the compiler's to say.
 */
function foldPattern(pattern: string): Folded {
  let out = '';
  let inClass = false;
  let boundary = false;
  let wide = false;
  const chars = Array.from(pattern);
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!;
    if (ch === '\\') {
      const next = chars[i + 1];
      if (next === undefined) {
        out += ch;
        continue;
      }
      if (!inClass && /[1-9]/.test(next)) return { ok: false, code: 'regex_unsupported', message: 'Backreferences are not supported.' };
      if (next === 'k' && chars[i + 2] === '<') return { ok: false, code: 'regex_unsupported', message: 'Backreferences are not supported.' };
      if (next === 'Q') return { ok: false, code: 'regex_unsupported', message: 'Quote with \\ instead of \\Q…\\E.' };
      if (!inClass && (next === 'b' || next === 'B')) boundary = true;
      // A Unicode class (\pL, \p{Arabic}) reaches past Latin letters too.
      if (next === 'p' || next === 'P') wide = true;
      out += ch + next;
      i += 1;
      // \p{Greek}, \x{0627}: the braces are part of the escape.
      if ((next === 'p' || next === 'P' || next === 'x') && chars[i + 1] === '{') {
        const close = chars.indexOf('}', i + 1);
        const end = close === -1 ? chars.length - 1 : close;
        out += chars.slice(i + 1, end + 1).join('');
        i = end;
      }
      continue;
    }
    if (inClass) {
      if (ch === ']') {
        inClass = false;
        out += ch;
        continue;
      }
      if (ch === '[' && chars[i + 1] === ':') {
        // A POSIX class, [:alpha:].
        const close = chars.indexOf(']', i + 2);
        const end = close === -1 ? chars.length - 1 : close;
        out += chars.slice(i, end + 1).join('');
        i = end;
        continue;
      }
      if (ch.codePointAt(0)! < 0x80) {
        out += ch;
        continue;
      }
      wide = true;
      const folded = foldChar(ch);
      if (Array.from(folded).length > 1) return { ok: false, code: 'regex_unsupported', message: `Write "${ch}" as separate letters.` };
      out += folded;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      out += ch;
      // A `]` first (after an optional `^`) is a member, not the end.
      if (chars[i + 1] === '^') {
        out += '^';
        i += 1;
      }
      if (chars[i + 1] === ']') {
        out += ']';
        i += 1;
      }
      continue;
    }
    if (ch === '(' && chars[i + 1] === '?') {
      if (chars[i + 2] !== ':') return { ok: false, code: 'regex_unsupported', message: UNSUPPORTED_GROUP };
      out += '(?:';
      i += 2;
      continue;
    }
    if (ch.codePointAt(0)! < 0x80) {
      out += ch;
      continue;
    }
    wide = true;
    const folded = foldChar(ch);
    // A ligature becomes its letters, kept together under a quantifier that follows.
    out += Array.from(folded).length > 1 ? `(?:${folded})` : folded;
  }
  if (boundary && wide) {
    return { ok: false, code: 'regex_word_boundary', message: '\\b knows Latin letters only; use the whole-word match for other scripts.' };
  }
  return { ok: true, source: out };
}

type Compiled = { ok: true; pattern: RE2JS } | { ok: false; code: TermProblemCode; message: string };

/** A stored pattern compiled for the engine, or why it cannot be. */
function compilePattern(term: string): Compiled {
  const folded = foldPattern(term);
  if (!folded.ok) return folded;
  let pattern: RE2JS;
  try {
    pattern = RE2JS.compile(folded.source, RE2JS.CASE_INSENSITIVE);
  } catch {
    return { ok: false, code: 'regex_invalid', message: 'The pattern is not a valid regular expression (RE2 syntax).' };
  }
  if (pattern.re2().numberOfInstructions() > MAX_PATTERN_INSTRUCTIONS) {
    return { ok: false, code: 'regex_too_large', message: 'The pattern is too large; split it into several terms.' };
  }
  if (pattern.test('') || pattern.test(' ')) return { ok: false, code: 'regex_too_broad', message: 'The pattern matches every text.' };
  return { ok: true, pattern };
}

/**
 * Whether `term` can be stored as a term of `match`: a substring or a word
 * must keep something after folding; a pattern must be valid RE2 inside the
 * supported subset ({@link foldPattern}), compile to at most
 * {@link MAX_PATTERN_INSTRUCTIONS} instructions and not match a blank text.
 */
export function checkTerm(term: string, match: BannedTermMatch): TermCheck {
  if (match !== 'regex') {
    return foldName(term) ? { ok: true } : { ok: false, code: 'term_empty', message: 'Nothing is left of the term once case, marks and punctuation are set aside.' };
  }
  const compiled = compilePattern(term);
  return compiled.ok ? { ok: true } : compiled;
}

export class BannedTerms {
  readonly invalid: number[] = [];
  private readonly terms: CompiledTerm[] = [];

  constructor(rows: readonly BannedTermRow[]) {
    for (const row of rows) {
      const compiled = this.compile(row);
      if (compiled) this.terms.push(compiled);
      else this.invalid.push(row.id);
    }
  }

  get size(): number {
    return this.terms.length;
  }

  /**
   * The highest severity among the terms of `scope` the text contains (0
   * when none). `locales` are the writer's languages (the request's, the
   * person's own; null entries ignored): a term of another language is
   * skipped, unless its letters are of a non-Latin script the text also
   * has letters of.
   */
  severity(text: string, scope: TermScope, locales: string | null | readonly (string | null)[]): number {
    const checked = text.slice(0, MAX_CHECKED);
    const bit = bannedTermScope.code(scope);
    const writer = typeof locales === 'string' || locales === null ? [locales] : locales;
    const seenScripts = new Map<Script, boolean>();
    const textHas = (script: Script) => {
      let has = seenScripts.get(script);
      if (has === undefined) {
        has = SCRIPT_LETTER[script].test(checked);
        seenScripts.set(script, has);
      }
      return has;
    };
    let words: string | undefined;
    let plain: string | undefined;
    let worst = 0;
    for (const term of this.terms) {
      if ((term.scope & bit) === 0 || term.severity <= worst) continue;
      if (term.locale !== null && !writer.includes(term.locale) && !term.scripts.some(textHas)) continue;
      const seen = term.regex ? (plain ??= patternText(checked)) : (words ??= ` ${asciiDigits(foldName(checked))} `);
      if (term.test(seen)) worst = term.severity;
    }
    return worst;
  }

  private compile(row: BannedTermRow): CompiledTerm | undefined {
    const base = { id: row.id, severity: row.severity, scope: row.scope, locale: row.locale ?? null, scripts: scriptsOf(row.term) };
    const match = bannedTermMatch.nameOrUndefined(row.matchKind);
    if (match === undefined) return undefined;
    if (match === 'regex') {
      const compiled = compilePattern(row.term);
      if (!compiled.ok) return undefined;
      const { pattern } = compiled;
      return { ...base, regex: true, test: (text) => pattern.test(text) };
    }
    const term = asciiDigits(foldName(row.term));
    if (!term) return undefined;
    if (match === 'word') {
      const word = ` ${term} `;
      return { ...base, regex: false, test: (folded) => folded.includes(word) };
    }
    return { ...base, regex: false, test: (folded) => folded.includes(term) };
  }
}
