import { ORIGINS_BOOTSTRAP_MAX, ORIGINS_PER_ROLE_MAX } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { messages, type MessageKey } from '../src/i18n/messages';
import { translate, type Translate } from '../src/i18n/translate';
import { auditActionLabel, auditTargetLabel } from '../src/lib/audit';
import { problemError } from '../src/lib/http';
import { fieldText, problemText } from '../src/lib/problemText';

/** A failed call in the panel's words: the API's English never leads, and is only ever a line of its own. */

const say = (locale: 'en' | 'fa' | 'tr'): Translate => (key, values) => translate(locale, key, values);
const refusal = (status: number, body: Record<string, unknown>) => problemError(status, JSON.stringify({ type: 'urn:x', title: 'x', status, ...body }));

describe('problemText', () => {
  it('words a 409 by its reason, never by its English detail', () => {
    const error = refusal(409, { code: 'conflict', detail: 'Already decided.', reason: 'already_decided' });
    expect(problemText(error, say('fa'), 'fa')).toBe(messages.fa['queue.alreadyDecided']);
    // The same English without a reason the panel knows: its general words, the detail on a line of its own.
    const unknown = refusal(409, { code: 'conflict', detail: 'Already decided.', reason: 'brand_new' });
    expect(problemText(unknown, say('fa'), 'fa')).toBe(`${messages.fa['common.error.conflict']}\nجزئیات فنی: Already decided.`);
  });

  it('names the permissions a role change would give beyond the caller’s, in the panel’s words', () => {
    const error = refusal(403, { code: 'forbidden', detail: 'x', reason: 'beyond_grants', permissions: ['users.chats', 'config.providers'] });
    expect(problemText(error, say('fa'), 'fa')).toBe(
      translate('fa', 'admins.error.beyondGrants', { permissions: `${messages.fa['permission.users.chats']} و ${messages.fa['permission.config.providers']}` }),
    );
    expect(problemText(refusal(403, { code: 'forbidden' }), say('en'), 'en')).toBe(messages.en['access.denied.body']);
  });

  it('words every field code the API writes, with the numbers its sentence names', () => {
    const issue = (code: string) => refusal(422, { code: 'field_invalid', detail: 'x', errors: [{ in: 'body', pointer: '/x', code, message: 'English.' }] });
    expect(problemText(issue('too_short'), say('fa'), 'fa')).toBe(translate('fa', 'admins.error.passwordShort', { min: 12 }));
    expect(problemText(issue('ends_too_far'), say('fa'), 'fa')).toBe(translate('fa', 'action.error.untilFar', { years: 10 }));
    expect(problemText(issue('regex_group'), say('tr'), 'tr')).toBe(messages.tr['terms.error.regexGroup']);
    // Too many hosts: the limit of the list the issue names (a role's, or the published copies').
    expect(fieldText('too_many', say('en'), '/hosts/api')).toBe(translate('en', 'hosts.issue.too_many', { max: ORIGINS_PER_ROLE_MAX }));
    expect(fieldText('too_many', say('en'), '/bootstrap')).toBe(translate('en', 'hosts.issue.too_many', { max: ORIGINS_BOOTSTRAP_MAX }));
    // A schema keyword: the panel's general sentence, the API's text only as the detail.
    expect(problemText(issue('too_big'), say('en'), 'en')).toBe(`${messages.en['common.error.invalid']}\nTechnical detail: /x: English.`);
  });

  it('adds the request id of a server error, and words a route the API does not have', () => {
    expect(problemText(refusal(500, { code: 'internal', requestId: 'req-7' }), say('fa'), 'fa')).toBe(`${messages.fa['common.error.server']}\nشناسه‌ی درخواست: req-7`);
    expect(problemText(refusal(404, { code: 'not_found', detail: 'No route for GET /v1/admin/nope' }), say('en'), 'en').split('\n')[0]).toBe(messages.en['common.error.badRequest']);
    expect(problemText(refusal(404, { code: 'not_found', detail: 'No such user.' }), say('en'), 'en')).toBe(messages.en['common.error.notFound']);
    expect(problemText(problemError(502, '<html>bad gateway</html>'), say('en'), 'en')).toBe(messages.en['common.error.server']);
  });
});

describe('a value this build has no words for', () => {
  it('shows as its code instead of breaking the page', () => {
    expect(translate('fa', 'auditAction.area.future' as MessageKey)).toBe('auditAction.area.future');
    expect(auditActionLabel('area.future', say('fa'))).toBe('area.future');
    expect(auditActionLabel('user.ban', say('fa'))).toBe(messages.fa['auditAction.user.ban']);
    expect(auditTargetLabel('future_target', say('fa'))).toBe('future_target');
  });
});
