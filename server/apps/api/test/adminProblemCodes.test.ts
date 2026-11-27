import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminConflictReasons, adminFieldCodes, adminForbiddenReasons, problem, problemSchemaFor } from '@app/shared';
import { describe, expect, it } from 'vitest';

/**
 * The admin API names every refusal with a machine word the panel words
 * (shared `adminProblems.ts`): read from the sources, so a new refusal
 * without one, or with a word the catalogue lacks, fails here.
 */

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const files = [
  ...readdirSync(join(SRC, 'routes'))
    .filter((name) => name.startsWith('admin') && name.endsWith('.ts'))
    .map((name) => join(SRC, 'routes', name)),
  ...readdirSync(join(SRC, 'admin'))
    .filter((name) => name.endsWith('.ts') && name !== 'problems.ts')
    .map((name) => join(SRC, 'admin', name)),
  join(SRC, 'plugins/adminAuth.ts'),
  join(SRC, 'services/bannedTerms.ts'),
];
const sources = files.map((file) => ({ file: file.slice(SRC.length + 1), text: readFileSync(file, 'utf8') }));

describe('the admin API\'s refusals', () => {
  it('reads several sources', () => {
    expect(sources.length).toBeGreaterThan(15);
  });

  it('names a reason on every 409 and 403 (through adminConflict and adminForbidden)', () => {
    const raw = sources.flatMap(({ file, text }) =>
      [...text.matchAll(/new HttpProblem\('(conflict|forbidden)'/g)].map((match) => `${file}: ${match[0]}`),
    );
    expect(raw).toEqual([]);
    const used = sources.flatMap(({ text }) => [...text.matchAll(/adminConflict\('([a-z_]+)'/g)].map((match) => match[1]!));
    expect(used.length).toBeGreaterThan(20);
    for (const reason of used) expect(adminConflictReasons, reason).toContain(reason);
    const refused = sources.flatMap(({ text }) => [...text.matchAll(/adminForbidden\('([a-z_]+)'/g)].map((match) => match[1]!));
    for (const reason of refused) expect(adminForbiddenReasons, reason).toContain(reason);
    // Every reason of the catalogue is sent somewhere (none is left over).
    expect(new Set(used)).toEqual(new Set(adminConflictReasons));
    expect(new Set(refused)).toEqual(new Set(adminForbiddenReasons));
  });

  it('writes only catalogue codes in field issues', () => {
    const codes = sources.flatMap(({ file, text }) => [
      // A field issue, or a check's refusal: `code: '…', message`.
      ...[...text.matchAll(/\bcode: '([a-z_]+)',\s*message/g)].map((match) => [file, match[1]!] as const),
      ...[...text.matchAll(/fieldInvalid\([^,]+, '([a-z_]+)'/g)].map((match) => [file, match[1]!] as const),
    ]);
    expect(codes.length).toBeGreaterThan(30);
    const unknown = codes.filter(([, code]) => !(adminFieldCodes as readonly string[]).includes(code));
    expect(unknown).toEqual([]);
  });

  it('carries the reason (and the permissions) as extension members', () => {
    const conflict = problem('conflict', { detail: 'Already decided.', extensions: { reason: 'already_decided' } });
    expect(problemSchemaFor('conflict').parse(conflict)).toMatchObject({ reason: 'already_decided' });
    const forbidden = problem('forbidden', { detail: 'x', extensions: { reason: 'beyond_grants', permissions: ['users.chats'] } });
    expect(problemSchemaFor('forbidden').parse(forbidden)).toMatchObject({ reason: 'beyond_grants', permissions: ['users.chats'] });
  });
});
