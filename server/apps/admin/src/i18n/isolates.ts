import { createElement, Fragment, type ReactNode } from 'react';

/** The isolate initiators (LRI, RLI, FSI) and the direction each gives its content; FSI's is a <bdi>'s own (first strong). */
const INITIATORS = new Map<string, 'ltr' | 'rtl' | undefined>([
  ['\u2066', 'ltr'],
  ['\u2067', 'rtl'],
  ['\u2068', undefined],
]);
const PDI = '\u2069';
const ANY = /[\u2066-\u2069]/;

interface Open {
  dir: 'ltr' | 'rtl' | undefined;
  parts: ReactNode[];
}

/**
 * `text` as React nodes, each isolate (U+2066, U+2067 or U+2068 ...
 * U+2069) a <bdi> of the same direction, nested as the isolates are. The
 * layout is the same (a <bdi> isolates its content, and takes the
 * direction of its first strong character unless `dir` says otherwise),
 * but the page's text holds no isolate characters: none come along when
 * it is copied, and none are in its accessible name. A U+2069 that closes
 * nothing is dropped (it does nothing in UAX #9 either); an isolate left
 * open ends with the text.
 */
export function isolatedNodes(text: string): ReactNode {
  if (!ANY.test(text)) return text;
  const stack: Open[] = [{ dir: undefined, parts: [] }];
  let run = '';
  const top = () => stack[stack.length - 1]!;
  const flush = () => {
    if (run === '') return;
    top().parts.push(run);
    run = '';
  };
  const close = () => {
    flush();
    const done = stack.pop()!;
    top().parts.push(createElement('bdi', done.dir ? { dir: done.dir } : null, ...done.parts));
  };
  for (const char of text) {
    if (INITIATORS.has(char)) {
      flush();
      stack.push({ dir: INITIATORS.get(char), parts: [] });
    } else if (char === PDI) {
      if (stack.length > 1) close();
    } else run += char;
  }
  while (stack.length > 1) close();
  flush();
  return createElement(Fragment, null, ...stack[0]!.parts);
}
