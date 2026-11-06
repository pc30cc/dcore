import type { Locale } from '@app/shared';

export type Localized<T> = Readonly<Record<Locale, T>>;

export interface ContentSection {
  heading: string;
  /** Paragraphs. `{appName}`, `{supportEmail}` and the other brand values are filled at build time. */
  body: readonly string[];
  /** An optional list after the paragraphs; `ordered` for steps. */
  list?: readonly string[];
  ordered?: boolean;
}

export interface PageContent {
  title: string;
  /** For <meta name="description"> and the page's lead paragraph. */
  description: string;
  sections: readonly ContentSection[];
}

export interface SitePage {
  /**
   * A draft is shown with a notice that it is not in force yet. Legal texts
   * stay drafts until counsel has reviewed them.
   */
  draft: boolean;
  content: Localized<PageContent>;
}
