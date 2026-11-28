// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  adminConflictReasons,
  adminFieldCodes,
  adminForbiddenReasons,
  adminReportViews,
  adminUserFilters,
  appealStatus,
  auditActions,
  auditTarget,
  automaticBanReasons,
  bannedTermMatch,
  bannedTermScope,
  bannedTermSeverity,
  billingPeriodSchema,
  callOutcome,
  consentKind,
  deviceBanKind,
  errorCodes,
  evidenceRoleSchema,
  filingAuthority,
  gender,
  grantStateSchema,
  integrity,
  intention,
  ledgerReason,
  legalHoldKind,
  locales,
  matchState,
  messageFlags,
  messageKind,
  moderationKind,
  moderationReason,
  permissions,
  photoModFlags,
  photoRejectReason,
  photoStatus,
  planFlagKeys,
  planQuotaKeys,
  platform,
  productKind,
  purchaseMatchSchema,
  purchaseOutcomeSchema,
  purchaseState,
  reportContext,
  reportReason,
  reportResolution,
  reportStatus,
  requestStatus,
  revokeReason,
  store,
  storeEventKind,
  storeEventSource,
  subscriptionStatus,
  textRejectReason,
  textState,
  walletItem,
  accountStatus,
  type Locale,
} from '@app/shared';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { messages, type MessageKey } from '../src/i18n/messages';
import { CONFLICT_TEXT, FIELD_TEXT, FORBIDDEN_TEXT, WORDED_CODES } from '../src/lib/problemText';

/**
 * Guards of the panel's languages. They fail when a change adds text the
 * panel shows in one language only: a key missing in a language, a Persian
 * or Turkish value left in English, a literal in a page, or a server value
 * (a permission, a role, an audit action, a problem code, an enum) without
 * words. The lists are read from their sources (the shared catalogues, the
 * API's routes, the migrations), never copied.
 */

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const has = (locale: Locale, key: string) => typeof (messages[locale] as Record<string, string>)[key] === 'string' && (messages[locale] as Record<string, string>)[key]!.trim() !== '';

function expectWords(prefix: string, codes: readonly string[]): void {
  expect(codes.length, prefix).toBeGreaterThan(0);
  const missing = locales.flatMap((locale) => codes.filter((code) => !has(locale, `${prefix}${code}`)).map((code) => `${locale}:${prefix}${code}`));
  expect(missing, prefix).toEqual([]);
}

/**
 * The keys an SQL file seeds into admin_roles: for each INSERT, the value
 * under its `key` column in every row of its VALUES list. An insert whose
 * keys cannot be read (no key column, no VALUES rows, a key that is not a
 * plain string) fails the test, so a new form of seed is never skipped.
 */
function seededRoleKeys(sql: string, file: string): string[] {
  const keys: string[] = [];
  for (const insert of sql.matchAll(/INSERT INTO admin_roles\s*\(([^)]*)\)\s*/gi)) {
    const columns = insert[1]!.split(',').map((column) => column.trim().toLowerCase());
    const at = columns.indexOf('key');
    if (at < 0) throw new Error(`${file}: an INSERT INTO admin_roles with no key column`);
    let i = insert.index + insert[0].length;
    if (!/^VALUES\b/i.test(sql.slice(i))) throw new Error(`${file}: an INSERT INTO admin_roles with no rows to read`);
    i += 'VALUES'.length;
    const rows: string[][] = [];
    for (;;) {
      while (/\s/.test(sql[i] ?? '')) i += 1;
      if (sql[i] !== '(') break;
      // One row: its top-level values, quotes ('' inside them) and brackets kept whole.
      const values: string[] = [];
      let value = '';
      let depth = 0;
      let quoted = false;
      for (i += 1; i < sql.length; i += 1) {
        const c = sql[i]!;
        if (quoted) {
          value += c;
          if (c === "'" && sql[i + 1] === "'") value += sql[++i];
          else if (c === "'") quoted = false;
        } else if (c === "'") {
          quoted = true;
          value += c;
        } else if (c === '(') {
          depth += 1;
          value += c;
        } else if (c === ')' && depth > 0) {
          depth -= 1;
          value += c;
        } else if (c === ')' || (c === ',' && depth === 0)) {
          values.push(value.trim());
          value = '';
          if (c === ')') break;
        } else value += c;
      }
      i += 1;
      rows.push(values);
      while (/\s/.test(sql[i] ?? '')) i += 1;
      if (sql[i] !== ',') break;
      i += 1;
    }
    if (rows.length === 0) throw new Error(`${file}: an INSERT INTO admin_roles with no rows to read`);
    for (const row of rows) {
      const key = /^'([a-z][a-z0-9_]*)'$/.exec(row[at] ?? '')?.[1];
      if (!key) throw new Error(`${file}: an admin_roles row whose key is not a plain string: ${row[at]}`);
      keys.push(key);
    }
  }
  return keys;
}

/**
 * The job queues of the shared catalogue (`queueNames`, in its Node-only
 * part, which the panel never imports), read from their source.
 */
function sharedQueueNames(): string[] {
  const source = readFileSync(join(ROOT, 'packages/shared/src/server/queues.ts'), 'utf8');
  const list = /export const queueNames = \[([^\]]*)\] as const/.exec(source)?.[1];
  if (!list) throw new Error('queues.ts: no queueNames list to read');
  return [...list.matchAll(/'([a-z][a-z0-9_-]*)'/g)].map((match) => match[1]!);
}

describe('server values the panel shows have words in every language', () => {
  it('every permission, with its sentence', () => {
    expectWords('permission.', permissions);
    expectWords('permission.', permissions.map((permission) => `${permission}.hint`));
  });

  it('every role the migrations seed', () => {
    const dir = join(ROOT, 'packages/db/migrations');
    const keys = readdirSync(dir)
      .filter((name) => name.endsWith('.sql'))
      .flatMap((name) => seededRoleKeys(readFileSync(join(dir, name), 'utf8'), name));
    expect(keys).toContain('superadmin');
    expectWords('role.', [...new Set(keys)]);
  });

  it('reads a seeded role’s key wherever its column is, and fails on an insert it cannot read', () => {
    expect(seededRoleKeys(`INSERT INTO admin_roles (key, names) VALUES ('ops', '{"en": "Ops, (night)"}'), ('audit_only', '{}') ON CONFLICT DO NOTHING;`, 'probe')).toEqual(['ops', 'audit_only']);
    expect(seededRoleKeys(`INSERT INTO admin_roles (id, key, names) VALUES (9, 'night', '{"en": "it''s late"}');`, 'probe')).toEqual(['night']);
    expect(() => seededRoleKeys(`INSERT INTO admin_roles (id, names) VALUES (9, '{}');`, 'probe')).toThrow(/no key column/);
    expect(() => seededRoleKeys(`INSERT INTO admin_roles (key, names) SELECT k, '{}' FROM x;`, 'probe')).toThrow(/no rows/);
  });

  it('every audit action and target kind', () => {
    expectWords('auditAction.', auditActions);
    expectWords('auditTarget.', auditTarget.names);
  });

  it('every reason, code and kind of the shared code tables the pages show', () => {
    const tables: [string, readonly string[]][] = [
      ['status.account.', accountStatus.names],
      ['gender.', gender.names],
      ['intention.', intention.names],
      ['textState.', textState.names],
      ['photoStatus.', photoStatus.names],
      ['modFlag.', photoModFlags.names],
      ['kind.action.', moderationKind.names],
      ['reason.moderation.', moderationReason.names],
      ['reason.photo.', photoRejectReason.names],
      ['reason.text.', textRejectReason.names],
      ['appealStatus.', appealStatus.names],
      ['reportReason.', reportReason.names],
      ['reportContext.', reportContext.names],
      ['reportStatus.', reportStatus.names],
      ['requestStatus.', requestStatus.names],
      ['resolution.', reportResolution.names],
      ['authority.', filingAuthority.names],
      ['holdKind.', legalHoldKind.names],
      ['subscriptionStatus.', subscriptionStatus.names],
      ['purchaseState.', purchaseState.names],
      ['productKind.', productKind.names],
      ['walletItem.', walletItem.names],
      ['ledgerReason.', ledgerReason.names],
      ['integrity.', integrity.names],
      ['revokeReason.', revokeReason.names],
      ['consentKind.', consentKind.names],
      ['devices.', platform.names],
      ['store.', [...store.names, 'admin']],
      ['messageKind.', [...messageKind.names, 'request']],
      ['messageFlag.', messageFlags.names],
      ['chats.state.', matchState.names],
      ['chats.call.', callOutcome.names.filter((outcome) => outcome !== 'completed')],
      ['users.filter.', adminUserFilters],
      ['reports.view.', adminReportViews],
      ['evidence.from.', evidenceRoleSchema.options],
      ['banKind.', deviceBanKind.names],
      ['termMatch.', bannedTermMatch.names],
      ['termSeverity.', bannedTermSeverity.names],
      ['termScope.', bannedTermScope.names],
      ['period.', billingPeriodSchema.options],
      ['plan.flag.', planFlagKeys],
      ['plan.quota.', planQuotaKeys],
      ['deviceBans.reason.', automaticBanReasons],

      // dashboard
      ['dashboard.queue.', sharedQueueNames()],

      // content

      // revenue
      ['storeEvent.', storeEventKind.names],
      ['storeEventSource.', storeEventSource.names],
      ['grants.state.', grantStateSchema.options],
      ['purchases.matched.', purchaseMatchSchema.options],
      ['purchase.done.', purchaseOutcomeSchema.options],

      // growth

      // app

      // support

      // system
    ];
    for (const [prefix, codes] of tables) expectWords(prefix, codes);
  });

  it('every reason and field code of the admin API’s refusals, worded by the panel’s own tables', () => {
    expect(Object.keys(CONFLICT_TEXT).sort()).toEqual([...adminConflictReasons].sort());
    expect(Object.keys(FORBIDDEN_TEXT).sort()).toEqual([...adminForbiddenReasons].sort());
    expect(Object.keys(FIELD_TEXT).sort()).toEqual([...new Set(adminFieldCodes)].sort());
    const keys = [...Object.values(CONFLICT_TEXT), ...Object.values(FORBIDDEN_TEXT), ...Object.values(FIELD_TEXT)];
    for (const locale of locales) expect(keys.filter((key) => !has(locale, key)), locale).toEqual([]);
  });

  it('every problem code is worded, or one the admin API never sends (the apps’ own, treated by status)', () => {
    // The apps' codes: no admin route throws them (checked below from the routes' sources).
    const appOnly = errorCodes.filter((code) => !WORDED_CODES.includes(code));
    const api = join(ROOT, 'apps/api/src');
    const sources = [
      ...readdirSync(join(api, 'routes'))
        .filter((name) => name.startsWith('admin') && name.endsWith('.ts'))
        .map((name) => join(api, 'routes', name)),
      // The areas' admin routes (each area's plugin and the files beside it).
      ...readdirSync(join(api, 'routes/areas'))
        .filter((name) => name.endsWith('.ts'))
        .map((name) => join(api, 'routes/areas', name)),
      ...readdirSync(join(api, 'admin')).map((name) => join(api, 'admin', name)),
      join(api, 'plugins/adminAuth.ts'),
      // Services whose refusals an admin route passes on as they are.
      join(api, 'services/bannedTerms.ts'),
    ];
    const thrown = new Set(sources.flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/new HttpProblem\('([a-z_]+)'/g)].map((match) => match[1]!)));
    expect(thrown.size).toBeGreaterThan(5);
    expect([...thrown].filter((code) => appOnly.includes(code as (typeof errorCodes)[number]))).toEqual([]);
    expect([...thrown].filter((code) => !(errorCodes as readonly string[]).includes(code))).toEqual([]);
  });
});

/**
 * Persian and Turkish values that may equal the English one: codes, brands,
 * abbreviations and words those languages share. Any other equal value is
 * text someone forgot to translate.
 */
const SAME_AS_ENGLISH: Readonly<Record<'fa' | 'tr', readonly MessageKey[]>> = {
  fa: ['hosts.role.api', 'hosts.role.cdn', 'devices.ios', 'authority.ncmec', 'messageKind.gif', 'audit.col.ip'],
  tr: [
    'hosts.role.api',
    'hosts.role.cdn',
    'devices.ios',
    'devices.android',
    'authority.ncmec',
    'messageKind.gif',
    'audit.col.ip',
    'store.play',
    'store.bazaar',
    'store.app_store',
    'user.signIn.google',
    'plans.col.plan',
    'plan.section.identity',
    'product.plan',
    'auditTarget.plan',
    'purchases.col.plan',
    'purchases.test',
    'reportReason.spam',
    'reason.moderation.spam',
  ],
};

/** A value with no letters (placeholders, digits, punctuation) is the same in every language. */
const hasLetters = (value: string) => /\p{L}/u.test(value.replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, ''));

describe('the Persian and Turkish strings', () => {
  const keys = Object.keys(messages.en) as MessageKey[];

  it('differ from English, but for a short list of codes and brands', () => {
    for (const locale of ['fa', 'tr'] as const) {
      const same = keys.filter((key) => hasLetters(messages.en[key]) && messages[locale][key] === messages.en[key]);
      expect(same.filter((key) => !SAME_AS_ENGLISH[locale].includes(key)), locale).toEqual([]);
      // The list holds only what is still the same (none left over).
      expect(SAME_AS_ENGLISH[locale].filter((key) => !same.includes(key)), `${locale} allowlist`).toEqual([]);
    }
  });

  it('write Persian ی and ک, «» quotes and no Latin digits outside codes', () => {
    const fa = keys.map((key) => [key, messages.fa[key]] as const);
    expect(fa.filter(([, value]) => /[يك]/.test(value)).map(([key]) => key)).toEqual([]);
    expect(fa.filter(([, value]) => /["“”]/.test(value)).map(([key]) => key)).toEqual([]);
    // Digits are written by translate() and Intl; literal ones only inside codes and examples of what to type.
    const latinDigits = fa.filter(([, value]) => /\d/.test(value.replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, '').replace(/[⁦-⁩‎‏][^⁦-⁩‎‏]*[⁦-⁩‎‏]/g, '')));
    expect(latinDigits.map(([key]) => key)).toEqual(LATIN_DIGITS_FA);
  });
});

/** Words the panel replaced with one term each (refund, inactivity, address, matches, enter, deleted). */
const AVOIDED_FA: readonly (readonly [RegExp, string])[] = [
  [/بازپرداخت/, 'بازگشت وجه'],
  [/بی‌کاری/, 'بی‌فعالیتی'],
  [/(^|[\s«(])جور(\s|$)/, 'مطابقت / سازگار'],
  [/(^|[\s«(])نشانی/, 'آدرس'],
  [/بزنید/, 'وارد کنید'],
];

/** Values that name the API as a setting or a host role; everywhere else a Persian or Turkish admin reads «server». */
const NAMES_THE_API: readonly MessageKey[] = [
  'common.error.notConfigured',
  'login.error.origin',
  'hosts.intro',
  'hosts.status.noKey',
  'hosts.form.help',
  'hosts.role.api',
  'hosts.issue.api_required',
];

describe('the glossary', () => {
  const keys = Object.keys(messages.en) as MessageKey[];

  it('holds in Persian: one word per idea', () => {
    const found = keys.flatMap((key) => AVOIDED_FA.filter(([word]) => word.test(messages.fa[key])).map(([, instead]) => `${key}: ${instead}`));
    expect(found).toEqual([]);
    // A store refund and a product turned on or off read the same on every page and in the audit log.
    expect(messages.fa['auditAction.product.activate']).toContain('روشن');
    expect(messages.fa['auditAction.product.deactivate']).toContain('خاموش');
    expect(messages.fa['permission.billing.refund']).toBe(messages.fa['ledgerReason.refund']);
    // «نگه‌داری» is the legal hold and nothing else (the maint job queue is «نگه‌داشت»).
    expect(keys.filter((key) => messages.fa[key].includes('نگه‌داری') && !/hold|held/i.test(`${key} ${messages.en[key]}`))).toEqual([]);
  });

  it('says the server, not the API, but where the API itself is meant', () => {
    for (const locale of ['fa', 'tr'] as const) {
      expect(keys.filter((key) => /\bAPI/.test(messages[locale][key]) && !NAMES_THE_API.includes(key)), locale).toEqual([]);
    }
    // Turkish says «temel plan»; Play Console's own English name only as a gloss after a colon.
    expect(keys.filter((key) => /(?<!: )\bbase plan/i.test(messages.tr[key])), 'tr').toEqual([]);
  });
});

/** Persian values with Latin digits on purpose: the names of standards and codes as they are written (ISO 4217). */
const LATIN_DIGITS_FA: readonly MessageKey[] = ['product.listPrice.currency'];

// ─── No literal text in the pages ─────────────────────────────────────────

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'locales' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/**
 * Attributes that never hold words a person reads or hears: names, codes,
 * styles, references and switches. Every other attribute with a string is
 * read (a new prop of a component included).
 */
const CODE_ATTRIBUTES = new Set([
  'className', 'id', 'key', 'type', 'variant', 'size', 'dir', 'lang', 'href', 'to', 'role', 'htmlFor', 'name', 'value', 'defaultValue',
  'autoComplete', 'inputMode', 'enterKeyHint', 'pattern', 'accept', 'method', 'target', 'rel', 'src', 'srcSet', 'sizes', 'loading', 'decoding',
  'titleId', 'options', 'kind', 'permission', 'labelKey', 'level', 'bgColor', 'fgColor', 'side', 'align', 'orientation', 'mode', 'tone', 'icon', 'form', 'viewBox', 'fill', 'stroke',
  'd', 'xmlns', 'width', 'height', 'step', 'min', 'max', 'minLength', 'maxLength', 'spellCheck', 'tabIndex', 'download', 'crossOrigin', 'referrerPolicy',
  'aria-hidden', 'aria-live', 'aria-describedby', 'aria-labelledby', 'aria-controls', 'aria-current', 'aria-expanded', 'aria-haspopup', 'aria-invalid',
  'aria-pressed', 'aria-selected', 'aria-sort', 'aria-busy', 'aria-atomic', 'aria-relevant', 'aria-orientation', 'aria-modal', 'aria-owns', 'aria-activedescendant',
]);
const readAttribute = (name: string) => !CODE_ATTRIBUTES.has(name) && !name.startsWith('data-');

/** Calls whose string arguments are keys, field names or ISO times, never shown as they are (t('users.title'), err('key')). */
const KEY_CALLS = new Set(['t', 'translate', 'say', 'cn', 'err', 'formatDate', 'formatDateTime']);

/**
 * Literals that are not words of a language: codes typed as they are (a
 * plan key, a product id, a currency), symbols, the names of the languages
 * in their own language, and the key caps of the queues' shortcuts.
 */
const ALLOWED_LITERALS = new Set(['gold', 'sub.gold', 'cons.boost.5', 'm1', 'USD', '∞', 'A', 'R', '—', '·', '×', 'English', 'فارسی', 'Türkçe']);

interface Literal {
  where: string;
  text: string;
}

function literalsIn(file: string, text = readFileSync(file, 'utf8')): Literal[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: Literal[] = [];
  const add = (node: ts.Node, value: string) => {
    const trimmed = value.replace(/\s+/g, ' ').trim();
    if (!/\p{L}/u.test(trimmed) || ALLOWED_LITERALS.has(trimmed)) return;
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    found.push({ where: `${relative(SRC, file)}:${line + 1}`, text: trimmed });
  };
  /** A string or template literal (its text parts); null for any other expression. */
  const literal = (node: ts.Expression): string | null => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ');
    return null;
  };
  /**
   * The literals an expression in JSX can show: itself, both branches of a
   * condition, a fallback, both sides of a `+`, the items of an array and
   * the arguments of a call (but a key's: t('…')), a method's object
   * (['Open', 'Closed'].join(', ')).
   */
  const shown = (node: ts.Expression, at: ts.Node): void => {
    const value = literal(node);
    if (value !== null) add(at, value);
    else if (ts.isConditionalExpression(node)) {
      shown(node.whenTrue, at);
      shown(node.whenFalse, at);
    } else if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(node.operatorToken.kind)) {
      shown(node.right, at);
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      shown(node.left, at);
      shown(node.right, at);
    } else if (ts.isArrayLiteralExpression(node)) {
      for (const item of node.elements) if (!ts.isSpreadElement(item) && !ts.isOmittedExpression(item)) shown(item, at);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
      if (ts.isPropertyAccessExpression(callee)) shown(callee.expression, at);
      if (!KEY_CALLS.has(name)) for (const argument of node.arguments) shown(argument, at);
    } else if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) shown(node.expression, at);
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) add(node, node.text);
    else if (ts.isJsxAttribute(node) && node.initializer && readAttribute(node.name.getText(source))) {
      if (ts.isStringLiteral(node.initializer)) add(node, node.initializer.text);
      else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) shown(node.initializer.expression, node);
    } else if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) shown(node.expression, node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('the pages', () => {
  it('show no literal text: every word comes from the locale files', () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(50);
    expect(files.flatMap((file) => literalsIn(file))).toEqual([]);
  });

  it('would catch a literal (the scan itself)', () => {
    // Parsed from a string: no file is written.
    const scan = (code: string) => literalsIn(join(SRC, '__probe__.tsx'), code).map((found) => found.text);
    expect(scan('const a = <p>Save changes</p>;')).toEqual(['Save changes']);
    expect(scan('const a = <input placeholder="Search" aria-label={`Copy ${id}`} />;')).toEqual(['Search', 'Copy']);
    expect(scan('const a = <p>{busy ? "Saving…" : t("common.save")}</p>;')).toEqual(['Saving…']);
    expect(scan('const a = <p>{name ?? "No name"}</p>;')).toEqual(['No name']);
    expect(scan('const a = <p>{t("common.save")} {formatNumber(2, locale)} ·</p>;')).toEqual([]);
    expect(scan('const a = <code>{"USD"}</code>;')).toEqual([]);
    // Built from parts, in an array or a call, in any prop of a component.
    expect(scan("const a = <p>{'Saved ' + count}</p>;")).toEqual(['Saved']);
    expect(scan("const a = <input aria-label={'Copy ' + id} />;")).toEqual(['Copy']);
    expect(scan('const a = <EmptyState heading="Nothing here" body="Try again later" />;')).toEqual(['Nothing here', 'Try again later']);
    expect(scan("const a = <p>{['Open', 'Closed'].join(', ')}</p>;")).toEqual(['Open', 'Closed']);
    expect(scan("const a = <p>{format('Done at', when)}</p>;")).toEqual(['Done at']);
    // Keys, codes and styles are not words.
    expect(scan("const a = <Badge variant=\"outline\" className=\"text-xs\" data-state=\"open\" permission=\"users.read\">{t('common.save')}</Badge>;")).toEqual([]);
  });
});
