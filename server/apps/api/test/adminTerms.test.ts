import { adminBannedTermPageSchema, adminBannedTermResultSchema, problemSchemaFor } from '@app/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BannedTerms, checkTerm } from '../src/services/bannedTerms.js';
import { call, json, migratedDatabase, row, seedUser, startHarness, statements, type Harness, type TestDatabase } from './accountSupport.js';
import { admin, adminAs, auditRows, installAuditFailure, refuseAudit, startAdminHarness, type AdminHarness, type AdminSession } from './adminSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * Banned terms in the admin panel: the pattern subset a term may use, the
 * list and its search, a term added, changed and removed with its audit row
 * (rolled back with a refused one), and what a person meets once it is
 * saved: the API processes load the terms again on `cfg:changed`.
 */

const TERM_TARGET = 17;

describe('checkTerm', () => {
  it.each([
    ['substring', 'scam', true, undefined],
    ['substring', '  !!  ', false, 'term_empty'],
    ['word', '***', false, 'term_empty'],
    ['word', 'Ali', true, undefined],
    ['regex', '^foo\\s+bar$', true, undefined],
    ['regex', 'a+b+', true, undefined],
    ['regex', '(?:ab)+', true, undefined],
    ['regex', '(a{2,3})+', true, undefined],
    ['regex', '[(+]+x', true, undefined],
    ['regex', '\\(a+\\)+', true, undefined],
    // A linear-time engine: what backtracks without end elsewhere is only a pattern here.
    ['regex', '(a+)+', true, undefined],
    ['regex', '(?:\\d[\\s-]*){10}', true, undefined],
    ['regex', '(\\w|a)+z', true, undefined],
    ['regex', '(a|aa)+b', true, undefined],
    ['regex', '\\w*\\w*\\w*z', true, undefined],
    ['regex', '\\bsex\\b', true, undefined],
    // RE2 reads a brace that opens no repeat as a letter.
    ['regex', 'a{', true, undefined],
    ['regex', '(abc', false, 'regex_invalid'],
    ['regex', '[z-a]', false, 'regex_invalid'],
    ['regex', '*a', false, 'regex_invalid'],
    ['regex', 'a{1001}', false, 'regex_invalid'],
    ['regex', 'foo(?=bar)', false, 'regex_unsupported'],
    ['regex', 'foo(?!bar)', false, 'regex_unsupported'],
    ['regex', '(?<=a)b', false, 'regex_unsupported'],
    ['regex', '(?<name>a)b', false, 'regex_unsupported'],
    ['regex', '(?P<name>a)b', false, 'regex_unsupported'],
    ['regex', '(?i)abc', false, 'regex_unsupported'],
    ['regex', '(a)\\1', false, 'regex_unsupported'],
    ['regex', '(?<n>a)\\k<n>', false, 'regex_unsupported'],
    ['regex', '\\Qa.b\\E', false, 'regex_unsupported'],
    ['regex', '\\bعلی\\b', false, 'regex_word_boundary'],
    ['regex', '\\b\\p{Arabic}+', false, 'regex_word_boundary'],
    ['regex', '[\\p{L}\\p{N}]{200}', false, 'regex_too_large'],
    ['regex', 'a*', false, 'regex_too_broad'],
    ['regex', '\\s', false, 'regex_too_broad'],
  ] as const)('%s %s', (match, term, ok, code) => {
    const result = checkTerm(term, match);
    expect(result.ok).toBe(ok);
    if (!result.ok) expect(result.code).toBe(code);
  });
});

describe('BannedTerms', () => {
  const terms = (term: string, matchKind = 3, locale: string | null = null) => new BannedTerms([{ id: 1, matchKind, severity: 3, scope: 31, locale, term }]);

  // Each accepted pattern matches the text it was written for (letters folded, punctuation kept), and not a near miss.
  it.each([
    ['^foo\\s+bar$', 'foo bar', 'foo bar baz'],
    ['^foo\\s+bar$', '  Foo \n BAR ', 'foobar'],
    ['@[a-z0-9_]+', 'find me @someone', 'find me at someone'],
    ['https?://', 'see https://example.org', 'see http:/example'],
    ['t\\.me/', 'join t.me/channel', 'join tme channel'],
    ['t\\.me/', 'join t\u200e.me/channel', 'join t me/channel'],
    ['\\d{3}-\\d{4}', 'call 555-1234', 'call 555 1234'],
    ['\\d{3}-\\d{4}', 'call ۵۵۵-۱۲۳۴', 'call ۵۵-۱۲۳۴'],
    ['(?:\\+98|0)9\\d{9}', 'شماره ۰۹۱۲۱۲۳۴۵۶۷', 'شماره ۰۹۱۲'],
    ['علي', 'من علی هستم', 'من عل هستم'],
    ['^علي$', 'علي', 'علي رضا'],
    ['ÇOK', 'çok güzel', 'cog guzel'],
    ['\\bsex\\b', 'no sex here', 'sussex'],
  ])('%s matches %j, not %j', (pattern, text, miss) => {
    expect(checkTerm(pattern, 'regex').ok).toBe(true);
    const compiled = terms(pattern);
    expect(compiled.size).toBe(1);
    expect(compiled.severity(text, 'messages', null)).toBe(3);
    expect(compiled.severity(miss, 'messages', null)).toBe(0);
  });

  it('runs every accepted pattern in linear time, on the longest message', () => {
    const evil = new BannedTerms(
      ['(\\w|a)+z', '(a|aa)+b', '\\w*\\w*\\w*z', '(a+)+$x', '\\S{20,40}(?:\\s*)+\\d+\\d?\\w{10}a{10}', '[\\p{L}]+[\\p{L}\\p{N}]{50}'].map((term, i) => ({ id: i + 1, matchKind: 3, severity: 3, scope: 31, term })),
    );
    expect(evil.size).toBe(6);
    for (const text of ['a'.repeat(4_000), 'ab'.repeat(2_000), 'سلام ۰۹۱۲ '.repeat(400), ' '.repeat(4_000)]) {
      const started = performance.now();
      evil.severity(text, 'messages', null);
      // Measured at about a millisecond; a backtracking engine took 19 s on 30 letters for the first one.
      expect(performance.now() - started).toBeLessThan(250);
    }
  });

  it('applies a term of one language to people writing in it only', () => {
    const tr = terms('kelime', 2, 'tr');
    expect(tr.severity('bir kelime', 'name', 'tr')).toBe(3);
    expect(tr.severity('bir kelime', 'name', 'fa')).toBe(0);
    expect(tr.severity('bir kelime', 'name', null)).toBe(0);
    const any = terms('kelime', 2, null);
    expect(any.severity('bir kelime', 'name', 'fa')).toBe(3);
    expect(any.severity('bir kelime', 'name', null)).toBe(3);
  });

  it('folds digits for words too, and skips a stored pattern that no longer compiles', () => {
    expect(terms('0912', 1).severity('call ۰۹۱۲ now', 'messages', null)).toBe(3);
    const stored = new BannedTerms([
      { id: 7, matchKind: 3, severity: 3, scope: 31, term: '(?=x)' },
      { id: 8, matchKind: 3, severity: 3, scope: 31, term: 'ok' },
    ]);
    expect(stored.invalid).toEqual([7]);
    expect(stored.size).toBe(1);
  });
});

describe.skipIf(!hasInfrastructure)('admin: banned terms', () => {
  let db: TestDatabase;
  let h: AdminHarness;
  const admins = new Map<string, AdminSession>();

  beforeAll(async () => {
    db = await migratedDatabase();
    await installAuditFailure(db);
    h = await startAdminHarness(db);
    for (const role of ['admin', 'moderator', 'support', 'analyst']) admins.set(role, await adminAs(h, role));
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    await db?.drop();
  });

  beforeEach(async () => {
    await refuseAudit(db);
  });

  async function as(role: string, url: string, body?: unknown, method?: 'POST' | 'PATCH' | 'DELETE'): Promise<LightMyRequestResponse> {
    return admin(h, url, body, { token: admins.get(role)!.accessToken, ...(method ? { method } : {}) });
  }

  const issue = (res: LightMyRequestResponse): unknown => {
    problemSchemaFor('field_invalid').parse(res.json());
    return (json(res)['errors'] as unknown[])[0];
  };

  async function loaded(app: Harness['app'], check: (size: number) => boolean): Promise<void> {
    for (let i = 0; i < 300; i += 1) {
      const terms = app.cfg.peek()?.bannedTerms;
      if (terms && check(terms.size)) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('the banned terms were not loaded');
  }

  async function editAbout(target: Harness, token: string, about: string): Promise<LightMyRequestResponse> {
    return call(target, '/v1/me/profile', { method: 'PATCH', token, body: { about } });
  }

  it('adds a term (two statements, 201, its audit row) and every API process refuses a text holding it', async () => {
    const other = await startHarness(db, { REDIS_KEY_PREFIX: h.prefix });
    try {
      const here = await seedUser(h, { name: 'Here' });
      const there = await seedUser(other, { name: 'There' });
      expect((await editAbout(h, here.token, 'I sell zorblax cheap')).statusCode).toBe(200);
      const before = h.app.cfg.peek()!.bannedTerms.size;

      const res = await as('moderator', '/v1/admin/banned-terms', { term: 'Zorblax', match: 'word', severity: 'refuse', scope: ['about', 'messages'], locale: null });
      expect(res.statusCode, res.body).toBe(201);
      expect(statements(res)).toBe(2);
      const { term, sideEffects } = adminBannedTermResultSchema.parse(res.json());
      expect(sideEffects).toBe('done');
      expect(term).toMatchObject({ term: 'Zorblax', match: 'word', severity: 'refuse', scope: ['about', 'messages'], locale: null, active: true });
      expect(term.createdBy?.id).toBe(String(admins.get('moderator')!.account.id));
      expect((await row<{ scope: number }>(db, 'SELECT scope FROM banned_terms WHERE id = $1', [term.id])).scope).toBe(2 + 8);
      const audits = await auditRows(db, { action: 'banned_term.create', targetType: TERM_TARGET, targetId: term.id });
      expect(audits.map((a) => a.detail)).toEqual([{ after: { term: 'Zorblax', match: 'word', severity: 'refuse', scope: ['about', 'messages'], locale: null, active: true } }]);
      expect(audits[0]).toMatchObject({ admin_id: admins.get('moderator')!.account.id, session_id: admins.get('moderator')!.sessionId });

      // This process, and another one through cfg:changed.
      await loaded(h.app, (size) => size === before + 1);
      await loaded(other.app, (size) => size === before + 1);
      const refused = await editAbout(h, here.token, 'Still selling ZORBLAX');
      expect(refused.statusCode).toBe(422);
      expect(json(refused)['code']).toBe('text_refused');
      const refusedThere = await editAbout(other, there.token, 'zorblax for you');
      expect(refusedThere.statusCode).toBe(422);
      // A name is another scope: not refused.
      expect((await call(h, '/v1/me/profile', { method: 'PATCH', token: here.token, body: { displayName: 'Zorblax' } })).statusCode).toBe(200);
    } finally {
      // Not other.close(): the two share a key prefix, and its clean-up would empty this harness's keys too.
      await other.app.close();
      await other.redis.quit();
    }
  });

  it('refuses a term twice, an empty one and a pattern outside the subset', async () => {
    const body = { term: 'dupterm', match: 'substring', severity: 'flag', scope: ['name'] };
    expect((await as('admin', '/v1/admin/banned-terms', body)).statusCode).toBe(201);
    const again = await as('admin', '/v1/admin/banned-terms', body);
    expect(again.statusCode).toBe(409);
    expect(problemSchemaFor('conflict').parse(again.json()).detail).toBe('This term exists.');
    // The same text in one language is another term.
    expect((await as('admin', '/v1/admin/banned-terms', { ...body, locale: 'fa' })).statusCode).toBe(201);
    expect(issue(await as('admin', '/v1/admin/banned-terms', { ...body, term: '...' }))).toMatchObject({ pointer: '/term', code: 'term_empty' });
    expect(issue(await as('admin', '/v1/admin/banned-terms', { ...body, term: '(x', match: 'regex' }))).toMatchObject({ pointer: '/term', code: 'regex_invalid' });
    expect(issue(await as('admin', '/v1/admin/banned-terms', { ...body, term: 'x(?=a)', match: 'regex' }))).toMatchObject({ pointer: '/term', code: 'regex_unsupported' });
    expect(issue(await as('admin', '/v1/admin/banned-terms', { ...body, term: '\\bعلی\\b', match: 'regex' }))).toMatchObject({ pointer: '/term', code: 'regex_word_boundary' });
    expect(issue(await as('admin', '/v1/admin/banned-terms', { ...body, term: '.{60}.{60}', match: 'regex' }))).toMatchObject({ pointer: '/term', code: 'regex_too_large' });
    expect((await as('admin', '/v1/admin/banned-terms', { ...body, scope: [] })).statusCode).toBe(400);
    expect((await as('admin', '/v1/admin/banned-terms', { ...body, scope: ['name', 'name'] })).statusCode).toBe(400);
    expect((await row<{ n: number }>(db, `SELECT count(*)::integer AS n FROM banned_terms WHERE term = 'dupterm'`)).n).toBe(2);
  });

  it('applies a term of one language to people writing in it (the app language of the request)', async () => {
    const user = await seedUser(h, { name: 'Lang' });
    expect((await as('admin', '/v1/admin/banned-terms', { term: 'zuplek', match: 'word', severity: 'refuse', scope: ['about'], locale: 'tr' })).statusCode).toBe(201);
    await loaded(h.app, () => h.app.cfg.peek()!.bannedTerms.severity('zuplek', 'about', 'tr') === 3);
    const about = (language: string) => call(h, '/v1/me/profile', { method: 'PATCH', token: user.token, body: { about: 'my zuplek' }, headers: { 'accept-language': language } });
    expect((await about('fa')).statusCode).toBe(200);
    const refused = await about('tr');
    expect(refused.statusCode).toBe(422);
    expect(json(refused)['code']).toBe('text_refused');
  });

  it('applies a term in Persian letters to every Persian text, whatever language the app asks in', async () => {
    const user = await seedUser(h, { name: 'Script' });
    expect((await as('admin', '/v1/admin/banned-terms', { term: 'تلگرامم', match: 'word', severity: 'refuse', scope: ['about'], locale: 'fa' })).statusCode).toBe(201);
    await loaded(h.app, () => h.app.cfg.peek()!.bannedTerms.severity('تلگرامم', 'about', 'fa') === 3);
    const about = (text: string, language: string) => call(h, '/v1/me/profile', { method: 'PATCH', token: user.token, body: { about: text }, headers: { 'accept-language': language } });
    // The header is the client's choice: Persian text is checked against the Persian term in English and Turkish too.
    for (const language of ['en', 'tr', 'fa']) {
      const refused = await about('آیدی تلگرامم رو بگیر', language);
      expect(refused.statusCode, language).toBe(422);
      expect(json(refused)['code']).toBe('text_refused');
    }
    // A text without Persian letters is not, outside Persian.
    expect((await about('no persian here', 'en')).statusCode).toBe(200);
  });

  it('lists newest first with its search and cursor, in one statement, for the moderation roles only', async () => {
    for (const term of ['listalpha', 'listbeta', 'listgamma']) {
      expect((await as('admin', '/v1/admin/banned-terms', { term, match: 'substring', severity: 'ask', scope: ['messages'] })).statusCode).toBe(201);
    }
    const first = await as('moderator', '/v1/admin/banned-terms?q=list&limit=2');
    expect(first.statusCode).toBe(200);
    expect(statements(first)).toBe(1);
    const page = adminBannedTermPageSchema.parse(first.json());
    expect(page.items.map((t) => t.term)).toEqual(['listgamma', 'listbeta']);
    const next = adminBannedTermPageSchema.parse((await as('moderator', `/v1/admin/banned-terms?q=list&limit=2&cursor=${page.nextCursor}`)).json());
    expect(next.items.map((t) => t.term)).toEqual(['listalpha']);
    expect(next.nextCursor).toBeNull();
    // `%` and `_` are taken literally.
    expect(adminBannedTermPageSchema.parse((await as('moderator', '/v1/admin/banned-terms?q=list_')).json()).items).toEqual([]);
    expect((await as('moderator', '/v1/admin/banned-terms?cursor=bm9wZQ')).statusCode).toBe(400);
    expect((await as('support', '/v1/admin/banned-terms')).statusCode).toBe(403);
    expect((await as('analyst', '/v1/admin/banned-terms')).statusCode).toBe(403);
    expect((await admin(h, '/v1/admin/banned-terms')).statusCode).toBe(401);
    expect((await as('support', '/v1/admin/banned-terms', { term: 'x', match: 'substring', severity: 'ask', scope: ['name'] })).statusCode).toBe(403);
  });

  it('changes a term (the audit row names what changed), leaves an unchanged one alone, and checks the term as it then reads', async () => {
    const created = adminBannedTermResultSchema.parse((await as('admin', '/v1/admin/banned-terms', { term: 'edit(me', match: 'substring', severity: 'ask', scope: ['about'] })).json()).term;
    const res = await as('admin', `/v1/admin/banned-terms/${created.id}`, { severity: 'refuse', scope: ['about', 'job'] }, 'PATCH');
    expect(res.statusCode, res.body).toBe(200);
    expect(statements(res)).toBe(2);
    expect(adminBannedTermResultSchema.parse(res.json()).term).toMatchObject({ severity: 'refuse', scope: ['about', 'job'] });
    const audit = await auditRows(db, { action: 'banned_term.update', targetType: TERM_TARGET, targetId: created.id });
    expect(audit.map((a) => a.detail?.['changed'])).toEqual([['severity', 'scope']]);
    expect(audit[0]?.detail).toMatchObject({ before: { severity: 'ask', scope: ['about'] }, after: { severity: 'refuse', scope: ['about', 'job'] } });

    const same = await as('admin', `/v1/admin/banned-terms/${created.id}`, { severity: 'refuse' }, 'PATCH');
    expect(same.statusCode).toBe(200);
    expect(statements(same)).toBe(1);
    expect(await auditRows(db, { action: 'banned_term.update', targetType: TERM_TARGET, targetId: created.id })).toHaveLength(1);

    // A regular expression of the old text does not compile: refused at the match, the row as it was.
    expect(issue(await as('admin', `/v1/admin/banned-terms/${created.id}`, { match: 'regex' }, 'PATCH'))).toMatchObject({ pointer: '/match', code: 'regex_invalid' });
    expect((await row<{ match_kind: number }>(db, 'SELECT match_kind FROM banned_terms WHERE id = $1', [created.id])).match_kind).toBe(1);

    // Onto another term's key: 409.
    const other = adminBannedTermResultSchema.parse((await as('admin', '/v1/admin/banned-terms', { term: 'othertaken', match: 'substring', severity: 'ask', scope: ['about'] })).json()).term;
    const clash = await as('admin', `/v1/admin/banned-terms/${created.id}`, { term: 'othertaken' }, 'PATCH');
    expect(clash.statusCode).toBe(409);
    expect((await as('admin', `/v1/admin/banned-terms/${other.id}`, { active: false }, 'PATCH')).statusCode).toBe(200);
    expect((await as('admin', '/v1/admin/banned-terms/99999999', { active: false }, 'PATCH')).statusCode).toBe(404);
    expect((await as('admin', `/v1/admin/banned-terms/${created.id}`, {}, 'PATCH')).statusCode).toBe(400);
  });

  it('removes a term: 204, its audit row, and texts holding it pass again', async () => {
    const user = await seedUser(h, { name: 'Gone' });
    const created = adminBannedTermResultSchema.parse((await as('admin', '/v1/admin/banned-terms', { term: 'qwxzterm', match: 'word', severity: 'refuse', scope: ['about'] })).json()).term;
    await loaded(h.app, () => h.app.cfg.peek()!.bannedTerms.severity('qwxzterm', 'about', null) === 3);
    expect((await editAbout(h, user.token, 'qwxzterm')).statusCode).toBe(422);
    const res = await as('admin', `/v1/admin/banned-terms/${created.id}`, undefined, 'DELETE');
    expect(res.statusCode).toBe(204);
    expect(statements(res)).toBe(2);
    expect((await auditRows(db, { action: 'banned_term.delete', targetType: TERM_TARGET, targetId: created.id })).map((a) => a.detail)).toEqual([
      { before: { term: 'qwxzterm', match: 'word', severity: 'refuse', scope: ['about'], locale: null, active: true } },
    ]);
    await loaded(h.app, () => h.app.cfg.peek()!.bannedTerms.severity('qwxzterm', 'about', null) === 0);
    expect((await editAbout(h, user.token, 'qwxzterm')).statusCode).toBe(200);
    expect((await as('admin', `/v1/admin/banned-terms/${created.id}`, undefined, 'DELETE')).statusCode).toBe(404);
  });

  it('rolls every write back with a refused audit row, and nothing is announced', async () => {
    await refuseAudit(db, 'banned_term.create', 'banned_term.update', 'banned_term.delete');
    const version = h.app.cfg.peek()!.version;
    expect((await as('admin', '/v1/admin/banned-terms', { term: 'refusedterm', match: 'substring', severity: 'ask', scope: ['name'] })).statusCode).toBe(500);
    expect((await row<{ n: number }>(db, `SELECT count(*)::integer AS n FROM banned_terms WHERE term = 'refusedterm'`)).n).toBe(0);
    await refuseAudit(db);
    const created = adminBannedTermResultSchema.parse((await as('admin', '/v1/admin/banned-terms', { term: 'refusedterm', match: 'substring', severity: 'ask', scope: ['name'] })).json()).term;
    await loaded(h.app, () => h.app.cfg.peek()!.bannedTerms.severity('refusedterm', 'name', null) === 1);
    await refuseAudit(db, 'banned_term.update', 'banned_term.delete');
    const afterCreate = h.app.cfg.peek()!.version;
    expect(afterCreate).toBeGreaterThan(version);
    expect((await as('admin', `/v1/admin/banned-terms/${created.id}`, { severity: 'refuse' }, 'PATCH')).statusCode).toBe(500);
    expect((await as('admin', `/v1/admin/banned-terms/${created.id}`, undefined, 'DELETE')).statusCode).toBe(500);
    expect(await row(db, 'SELECT severity, is_active FROM banned_terms WHERE id = $1', [created.id])).toEqual({ severity: 1, is_active: true });
    expect(h.app.cfg.peek()!.version).toBe(afterCreate);
  });
});
