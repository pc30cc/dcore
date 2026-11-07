import { foldName } from './cities.js';

/**
 * Banned terms (table banned_terms), held in memory and refreshed with the
 * rest of the configuration. Matching is done on folded text (case,
 * diacritics, Arabic letter forms), so `Ali` and `ali`, `ي` and `ی` match
 * the same term.
 *
 * match_kind: 1 substring, 2 whole word, 3 regular expression. The panel
 * stores RE2 syntax; the API compiles it as a JavaScript Unicode regular
 * expression and skips (and reports) a pattern that does not compile.
 * severity: 1 ask, 2 allow and flag for review, 3 refuse.
 */

export const termScope = { name: 1, about: 2, prompts: 4, messages: 8, job: 16 } as const;
export type TermScope = keyof typeof termScope;

export interface BannedTermRow {
  id: number;
  matchKind: number;
  severity: number;
  scope: number;
  term: string;
}

interface CompiledTerm {
  id: number;
  severity: number;
  scope: number;
  test: (folded: string) => boolean;
}

/** Longest text checked: profile texts are far shorter, and it bounds the work of a regular expression. */
const MAX_CHECKED = 4_000;

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

  /** The highest severity among the terms of `scope` the text contains (0 when none). */
  severity(text: string, scope: TermScope): number {
    const folded = ` ${foldName(text.slice(0, MAX_CHECKED))} `;
    const bit = termScope[scope];
    let worst = 0;
    for (const term of this.terms) {
      if ((term.scope & bit) === 0 || term.severity <= worst) continue;
      if (term.test(folded)) worst = term.severity;
    }
    return worst;
  }

  private compile(row: BannedTermRow): CompiledTerm | undefined {
    const base = { id: row.id, severity: row.severity, scope: row.scope };
    if (row.matchKind === 3) {
      let pattern: RegExp;
      try {
        pattern = new RegExp(row.term, 'iu');
      } catch {
        return undefined;
      }
      return { ...base, test: (folded) => pattern.test(folded) };
    }
    const term = foldName(row.term);
    if (!term) return undefined;
    if (row.matchKind === 2) {
      const word = ` ${term} `;
      return { ...base, test: (folded) => folded.includes(word) };
    }
    return { ...base, test: (folded) => folded.includes(term) };
  }
}
