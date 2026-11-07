import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { envVariables } from '../src/config.js';

/**
 * .env.example is the operator's list of what the API reads: every variable
 * of the schema is in it (set, or commented out as `# NAME=`), and nothing
 * in it is a variable the API no longer reads.
 */

const EXAMPLE = fileURLToPath(new URL('../.env.example', import.meta.url));

function exampleVariables(text: string): string[] {
  const names = new Set<string>();
  for (const line of text.split('\n')) {
    const match = /^\s*(?:#\s*)?([A-Z][A-Z0-9_]*)=/.exec(line);
    if (match?.[1]) names.add(match[1]);
  }
  return [...names];
}

describe('.env.example', () => {
  const listed = exampleVariables(readFileSync(EXAMPLE, 'utf8'));

  it('lists every variable the API reads', () => {
    expect(envVariables.length).toBeGreaterThan(40);
    expect(envVariables.filter((name) => !listed.includes(name))).toEqual([]);
  });

  it('lists nothing the API does not read', () => {
    expect(listed.filter((name) => !envVariables.includes(name))).toEqual([]);
  });

  it('sets no secret', () => {
    const secrets = /(KEY|SECRET|PEPPERS|KEYS|PASSWORD|TOKEN)$/;
    for (const line of readFileSync(EXAMPLE, 'utf8').split('\n')) {
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (match?.[1] && secrets.test(match[1]) && !match[1].endsWith('_KID')) expect(match[2], match[1]).toBe('');
    }
  });
});
