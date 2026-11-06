import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseHtml, type Element } from './html';

/** A built site on disk, read the way a static host serves it. */
export class BuiltSite {
  constructor(
    readonly dist: string,
    readonly origin: string,
  ) {}

  /** The file a static host answers for `urlPath` (a directory path serves its index.html), or undefined. */
  file(urlPath: string): string | undefined {
    const clean = decodeURIComponent(urlPath.split(/[?#]/)[0] ?? '');
    if (!clean.startsWith('/') || clean.includes('..')) return undefined;
    const candidate = clean.endsWith('/') ? path.join(this.dist, clean, 'index.html') : path.join(this.dist, clean);
    return existsSync(candidate) && statSync(candidate).isFile() ? candidate : undefined;
  }

  has(urlPath: string): boolean {
    return this.file(urlPath) !== undefined;
  }

  text(urlPath: string): string {
    const file = this.file(urlPath);
    if (file === undefined) throw new Error(`no page at ${urlPath} in ${this.dist}`);
    return readFileSync(file, 'utf8');
  }

  page(urlPath: string): Element {
    return parseHtml(this.text(urlPath));
  }

  /** The site path of a URL on this site, or undefined for another origin. */
  localPath(url: string): string | undefined {
    if (url.startsWith('/') && !url.startsWith('//')) return url;
    if (!/^https?:\/\//.test(url)) return undefined;
    const parsed = new URL(url);
    return parsed.origin === this.origin ? `${parsed.pathname}${parsed.search}${parsed.hash}` : undefined;
  }

  /** Every HTML page, by its URL path. */
  htmlPages(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.html')) {
          const rel = `/${path.relative(this.dist, full).split(path.sep).join('/')}`;
          out.push(rel.endsWith('/index.html') ? rel.slice(0, -'index.html'.length) : rel);
        }
      }
    };
    walk(this.dist);
    return out.sort();
  }
}
