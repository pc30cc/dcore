/**
 * A small HTML reader for the built pages, enough to see them the way a
 * browser without JavaScript does: elements, attributes, text, and the
 * contents of <noscript> as markup. The pages are generated, so a strict
 * reader is fine; it fails on markup it cannot place instead of guessing.
 */
export interface Element {
  tag: string;
  attrs: Map<string, string>;
  children: Node[];
  parent: Element | undefined;
}
export interface Text {
  text: string;
}
export type Node = Element | Text;

const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const rawTextTags = new Set(['script', 'style']);
// End tags HTML lets an author leave out; the reader closes them when their parent ends.
const optionalEnd = new Set(['li', 'p', 'dt', 'dd', 'option', 'tr', 'td', 'th']);

const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#x')) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(parseInt(body.slice(1), 10));
    return named[body] ?? match;
  });
}

const attrPattern = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

export function parseHtml(html: string): Element {
  const root: Element = { tag: '#document', attrs: new Map(), children: [], parent: undefined };
  let current = root;
  let i = 0;
  while (i < html.length) {
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      if (end < 0) throw new Error('unclosed comment');
      i = end + 3;
    } else if (html.startsWith('<!', i)) {
      i = html.indexOf('>', i) + 1;
    } else if (html.startsWith('</', i)) {
      const end = html.indexOf('>', i);
      const tag = html.slice(i + 2, end).trim().toLowerCase();
      let node: Element | undefined = current;
      while (node && node.tag !== tag) node = node.parent;
      if (!node?.parent) throw new Error(`unexpected </${tag}> at ${i}`);
      for (let open: Element | undefined = current; open && open !== node; open = open.parent) {
        if (!optionalEnd.has(open.tag)) throw new Error(`<${open.tag}> closed by </${tag}> at ${i}`);
      }
      current = node.parent;
      i = end + 1;
    } else if (html[i] === '<' && /[a-zA-Z]/.test(html[i + 1] ?? '')) {
      const end = findTagEnd(html, i);
      const source = html.slice(i + 1, end);
      const nameMatch = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(source);
      const tag = (nameMatch?.[0] ?? '').toLowerCase();
      const attrs = new Map<string, string>();
      const rest = source.slice(tag.length).replace(/\/$/, '');
      for (const m of rest.matchAll(attrPattern)) {
        const name = (m[1] ?? '').toLowerCase();
        if (name === '') continue;
        attrs.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''));
      }
      // A new <li> or <p> ends the open one of the same kind.
      if (optionalEnd.has(tag) && current.tag === tag && current.parent) current = current.parent;
      const element: Element = { tag, attrs, children: [], parent: current };
      current.children.push(element);
      i = end + 1;
      if (rawTextTags.has(tag)) {
        // Case-insensitive search without lowercasing the page (that changes lengths: Turkish İ).
        const closing = new RegExp(`</${tag}`, 'ig');
        closing.lastIndex = i;
        const close = closing.exec(html)?.index ?? -1;
        if (close < 0) throw new Error(`unclosed <${tag}>`);
        element.children.push({ text: html.slice(i, close) });
        i = html.indexOf('>', close) + 1;
      } else if (!voidTags.has(tag) && !source.endsWith('/')) {
        current = element;
      }
    } else {
      const next = html.indexOf('<', i + 1);
      const end = next < 0 ? html.length : next;
      current.children.push({ text: decodeEntities(html.slice(i, end)) });
      i = end;
    }
  }
  return root;
}

function findTagEnd(html: string, start: number): number {
  let quote: string | undefined;
  for (let i = start + 1; i < html.length; i++) {
    const c = html[i];
    if (quote) {
      if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i;
    }
  }
  throw new Error(`unclosed tag at ${start}`);
}

export function isElement(node: Node): node is Element {
  return 'tag' in node;
}

export function all(root: Element, test: (element: Element) => boolean): Element[] {
  const out: Element[] = [];
  const walk = (element: Element) => {
    for (const child of element.children) {
      if (!isElement(child)) continue;
      if (test(child)) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

export function byTag(root: Element, tag: string): Element[] {
  return all(root, (element) => element.tag === tag);
}

export function first(root: Element, test: (element: Element) => boolean): Element | undefined {
  return all(root, test)[0];
}

export function attr(element: Element, name: string): string | undefined {
  return element.attrs.get(name);
}

/** The visible text of an element (scripts and styles left out). */
export function textOf(element: Element): string {
  if (rawTextTags.has(element.tag)) return '';
  return element.children.map((child) => (isElement(child) ? textOf(child) : child.text)).join('');
}

/**
 * The fields a browser sends when the form is submitted with its submit
 * button, after the visitor filled in `values` (by field name): every named
 * <input>, <select> and <textarea> that is not disabled, as HTML defines it.
 */
export function formData(form: Element, values: Readonly<Record<string, string>> = {}): URLSearchParams {
  const data = new URLSearchParams();
  for (const field of all(form, (element) => ['input', 'select', 'textarea', 'button'].includes(element.tag))) {
    const name = attr(field, 'name');
    if (name === undefined || name === '' || field.attrs.has('disabled')) continue;
    const type = (attr(field, 'type') ?? (field.tag === 'button' ? 'submit' : 'text')).toLowerCase();
    if (['submit', 'button', 'reset', 'image', 'file'].includes(type)) continue;
    if ((type === 'checkbox' || type === 'radio') && !field.attrs.has('checked')) continue;
    data.append(name, values[name] ?? attr(field, 'value') ?? '');
  }
  return data;
}
