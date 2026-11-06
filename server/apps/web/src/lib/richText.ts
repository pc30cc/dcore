export type Segment =
  | { kind: 'text'; value: string }
  | { kind: 'email'; value: string }
  | { kind: 'link'; value: string; href: string };

/**
 * Splits a filled-in text into plain parts, e-mail addresses and site paths,
 * so the page can link them without any HTML in the content.
 */
export function segments(text: string, links: { emails: readonly string[]; paths: readonly string[] }): Segment[] {
  const tokens = [...links.emails, ...links.paths].filter((token) => token.length > 0);
  if (tokens.length === 0) return [{ kind: 'text', value: text }];
  const pattern = new RegExp(`(${tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g');
  const out: Segment[] = [];
  for (const part of text.split(pattern)) {
    if (part === '') continue;
    if (links.emails.includes(part)) out.push({ kind: 'email', value: part });
    else if (links.paths.includes(part)) out.push({ kind: 'link', value: part, href: part });
    else out.push({ kind: 'text', value: part });
  }
  return out;
}
