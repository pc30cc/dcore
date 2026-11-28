import { expandGrants } from '@app/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { adminWith, fakeApi, problem, renderPanel, resetPanel, signInAs, type Call } from './panel';
import { HOLDERS, ROLES, role } from './systemFixtures';

/**
 * `/system/roles` (`admins.read`; edits `admins.manage`): every role with
 * its admins and permissions; the editor's boxes keep the server's rules
 * (users.chats on the admin role, the analyst on dashboards, restricted
 * permissions given by the owner role alone, nothing past the editor's own access); a save
 * sends every grant with the grants as read, and a role changed meanwhile
 * is read again.
 */

const OWNER = adminWith(expandGrants(['*']), ['superadmin']);

beforeEach(() => {
  resetPanel();
  signInAs(OWNER);
});

function api(handlers: Record<string, (call: Call) => unknown> = {}) {
  return fakeApi({
    'GET /v1/admin/roles': () => ({ items: ROLES }),
    'GET /v1/admin/roles/holders': () => HOLDERS,
    ...handlers,
  });
}

/** A role's card by its name. */
async function card(name: string) {
  const heading = await screen.findByRole('heading', { level: 2, name: new RegExp(`^${name.replace(/[()]/g, '\\$&')}`) });
  return within(heading.closest('li')!);
}

async function openEditor(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole('button', { name: `Edit permissions of ${name}` }));
  return within(await screen.findByRole('dialog', { name: `Permissions of ${name}` }));
}

type Editor = Awaited<ReturnType<typeof openEditor>>;

/** An area of the editor (its section, named by its heading). */
const area = (editor: Editor, name: string) => within(editor.getByRole('region', { name }));

/** An area's "All of this area" switch (named by its visible label; the area describes it). */
const areaSwitch = (editor: Editor, name: string) => area(editor, name).getByRole<HTMLButtonElement>('switch', { name: 'All of this area' });

describe('the roles page', () => {
  it('lists every role with its admins; the owner role locked, nothing to edit there', async () => {
    renderPanel('/system/roles', api());
    expect(await screen.findByRole('heading', { level: 1, name: 'Roles' })).toBeTruthy();
    const ownerCard = await card('Owner');
    expect(ownerCard.getByText('Locked')).toBeTruthy();
    expect(ownerCard.getByText('Everything, admins and keys included')).toBeTruthy();
    expect(ownerCard.queryByRole('button')).toBeNull();
    // The signed-in owner holds the owner role: it is also "Your role".
    expect(ownerCard.getByText('Your role')).toBeTruthy();
    const support = await card('Support');
    expect(await support.findByText('Admins: 2')).toBeTruthy();
    expect(support.getByText('Permissions: 4')).toBeTruthy();
    expect(support.getByRole('button', { name: 'Edit permissions of Support' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^Edit permissions of / })).toHaveLength(6);
  });

  it('gives an admin who only reads no Edit at all', async () => {
    signInAs(adminWith(['admins.read'], ['support']));
    renderPanel('/system/roles', api());
    await card('Analyst (read only)');
    expect(screen.queryByRole('button', { name: /^Edit permissions of / })).toBeNull();
  });

  it('gives a delegated manager Edit only for roles within their access, never their own', async () => {
    const roles = [...ROLES.filter((item) => item.key !== 'support'), role('support', ['dashboard.read', 'support.*', 'users.read', 'admins.read', 'admins.manage'])];
    signInAs(adminWith(expandGrants(roles.find((item) => item.key === 'support')!.grants), ['support']));
    renderPanel('/system/roles', api({ 'GET /v1/admin/roles': () => ({ items: roles }) }));
    const support = await card('Support');
    expect(support.getByText('Your role')).toBeTruthy();
    expect(support.queryByRole('button')).toBeNull();
    const moderator = await card('Moderator');
    expect(moderator.getByText('Beyond your access')).toBeTruthy();
    expect(moderator.queryByRole('button')).toBeNull();
    // Marketing holds campaigns.* and content.read, which the manager does not: beyond. The analyst's dashboard.revenue too.
    expect((await card('Marketing')).getByText('Beyond your access')).toBeTruthy();
    expect(screen.queryAllByRole('button', { name: /^Edit permissions of / })).toHaveLength(0);
  });

  it('edits a role: an area switch gives the whole area and fixes its boxes; the save sends the grants and the grants as read', async () => {
    const fake = api({
      'PUT /v1/admin/roles/support/permissions': (call) => {
        const body = call.body as { grants: string[] };
        return { role: role('support', body.grants), signedOut: { admins: 0, sessions: 0 }, announced: true, sideEffects: 'done' };
      },
    });
    const user = userEvent.setup();
    renderPanel('/system/roles', fake);
    const editor = await openEditor(user, 'Support');
    const save = editor.getByRole<HTMLButtonElement>('button', { name: 'Save changes' });
    expect(save.disabled).toBe(true);
    expect(editor.getByText('No unsaved changes')).toBeTruthy();
    // support.* is on: its boxes are ticked and fixed.
    const supportWrite = editor.getByRole<HTMLInputElement>('checkbox', { name: 'Answer support requests' });
    expect(supportWrite.checked).toBe(true);
    expect(supportWrite.disabled).toBe(true);
    await user.click(areaSwitch(editor, 'Campaigns'));
    expect(editor.getByText('2 added, 0 removed')).toBeTruthy();
    await user.click(save);
    await waitFor(() => expect(fake.of('PUT /v1/admin/roles/support/permissions')).toHaveLength(1));
    expect(fake.of('PUT /v1/admin/roles/support/permissions')[0]!.body).toEqual({
      grants: ['campaigns.*', 'dashboard.read', 'support.*', 'users.read'],
      base: ['dashboard.read', 'support.*', 'users.read'],
    });
    expect(await screen.findByText('Saved.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The card shows what the save answered.
    expect((await card('Support')).getByText('Permissions: 6')).toBeTruthy();
  });

  it('keeps users.chats on the admin role and the analyst on dashboards, for the owner too', async () => {
    const user = userEvent.setup();
    renderPanel('/system/roles', api());
    let editor = await openEditor(user, 'Support');
    const chats = editor.getByRole<HTMLInputElement>('checkbox', { name: /^Read conversations.*Admin role only/ });
    expect(chats.disabled).toBe(true);
    await user.click(editor.getByRole('button', { name: 'Cancel' }));
    editor = await openEditor(user, 'Analyst (read only)');
    // Said once, under the title: not under each of the boxes it fixes.
    expect(editor.getAllByText('Dashboards only')).toHaveLength(1);
    const users = area(editor, 'Users').getAllByRole<HTMLInputElement>('checkbox');
    expect(users.length).toBeGreaterThan(5);
    expect(users.every((box) => box.disabled)).toBe(true);
    expect(areaSwitch(editor, 'Users').disabled).toBe(true);
    expect(areaSwitch(editor, 'Dashboard').disabled).toBe(false);
  });

  it('warns that taking access away signs the role’s admins out, and says so after the save', async () => {
    const fake = api({
      'PUT /v1/admin/roles/support/permissions': (call) => ({ role: role('support', (call.body as { grants: string[] }).grants), signedOut: { admins: 2, sessions: 3 }, announced: true, sideEffects: 'done' }),
    });
    const user = userEvent.setup();
    renderPanel('/system/roles', fake);
    const editor = await openEditor(user, 'Support');
    await user.click(areaSwitch(editor, 'Support'));
    expect(editor.getByText('Saving signs out 2 admins who hold this role.')).toBeTruthy();
    expect(editor.getByText(/added, \d+ removed/).textContent).toMatch(/^0 added, [1-9]/);
    await user.click(editor.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Saved. 2 admins were signed out.')).toBeTruthy();
    expect(fake.of('PUT /v1/admin/roles/support/permissions')[0]!.body).toMatchObject({ grants: ['dashboard.read', 'users.read'] });
  });

  it('reads a role changed meanwhile again, shows it and says so, and keeps the editor open', async () => {
    let reads = 0;
    const changed = [...ROLES.filter((item) => item.key !== 'support'), role('support', ['dashboard.read', 'support.read', 'users.read'])];
    const fake = api({
      'GET /v1/admin/roles': () => ({ items: reads++ === 0 ? ROLES : changed }),
      'PUT /v1/admin/roles/support/permissions': () => problem(409, 'conflict', { reason: 'role_changed', detail: 'The role changed meanwhile.' }),
    });
    const user = userEvent.setup();
    renderPanel('/system/roles', fake);
    const editor = await openEditor(user, 'Support');
    await user.click(areaSwitch(editor, 'Campaigns'));
    await user.click(editor.getByRole('button', { name: 'Save changes' }));
    expect(await editor.findByText('Someone changed this role meanwhile. The latest version is shown.')).toBeTruthy();
    // The editor now holds the stored grants: support.* is off, nothing changed yet.
    expect(areaSwitch(editor, 'Support').getAttribute('aria-checked')).toBe('false');
    expect(areaSwitch(editor, 'Campaigns').getAttribute('aria-checked')).toBe('false');
    expect(editor.getByRole<HTMLButtonElement>('button', { name: 'Save changes' }).disabled).toBe(true);
  });

  it('words any other refusal in the editor', async () => {
    const fake = api({ 'PUT /v1/admin/roles/support/permissions': () => problem(422, 'validation_failed', { errors: [{ in: 'body', pointer: '/grants/0', code: 'chats_admin_only', message: 'no' }] }) });
    const user = userEvent.setup();
    renderPanel('/system/roles', fake);
    const editor = await openEditor(user, 'Support');
    await user.click(areaSwitch(editor, 'Campaigns'));
    await user.click(editor.getByRole('button', { name: 'Save changes' }));
    expect(await editor.findByText('Only the admin role may read people’s chats.')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('keeps restricted permissions and what a delegated manager does not hold out of their reach', async () => {
    const manager = role('ops', ['dashboard.read', 'support.*', 'users.read', 'admins.read', 'admins.manage']);
    const roles = [...ROLES, manager, role('helpdesk', ['dashboard.read'])];
    signInAs(adminWith(expandGrants(manager.grants), ['ops']));
    const user = userEvent.setup();
    renderPanel('/system/roles', api({ 'GET /v1/admin/roles': () => ({ items: roles }), 'GET /v1/admin/roles/holders': () => ({ items: [] }) }));
    const editor = await openEditor(user, 'helpdesk');
    // A reason of one box stays under it.
    expect(editor.getByRole<HTMLInputElement>('checkbox', { name: /^View admins.*Owner only/ }).disabled).toBe(true);
    // Each area says it once, beside its name, not under each box; the greyed boxes point to it.
    for (const name of ['Campaigns', 'Users']) {
      const region = area(editor, name);
      expect(region.getAllByText('Not yours to give'), name).toHaveLength(1);
      // Those with a reason of their own (owner only, admin role only) say it under the box.
      const greyed = region.getAllByRole<HTMLInputElement>('checkbox').filter((box) => box.disabled && !/Owner only|Admin role only/.test(box.closest('label')?.textContent ?? ''));
      expect(greyed.length, name).toBeGreaterThan(0);
      for (const box of greyed) expect(document.getElementById(box.getAttribute('aria-describedby') ?? '')?.textContent, name).toBe('Not yours to give');
    }
    // A box the manager holds (users.read) can be changed.
    expect(editor.getByRole<HTMLInputElement>('checkbox', { name: 'View people' }).disabled).toBe(false);
    expect(areaSwitch(editor, 'Support').disabled).toBe(false);
    expect(areaSwitch(editor, 'Users').disabled).toBe(true);
  });

  it('warns without a number while the holders are not known, and says when they could not be signed out', async () => {
    const fake = api({
      'GET /v1/admin/roles/holders': () => problem(503, 'service_unavailable', { detail: 'down' }),
      'PUT /v1/admin/roles/support/permissions': (call) => ({ role: role('support', (call.body as { grants: string[] }).grants), signedOut: { admins: 2, sessions: 2 }, announced: true, sideEffects: 'failed' }),
    });
    const user = userEvent.setup();
    renderPanel('/system/roles', fake);
    const editor = await openEditor(user, 'Support');
    await user.click(areaSwitch(editor, 'Support'));
    expect(editor.getByText('Saving signs out every admin who holds this role.')).toBeTruthy();
    await user.click(editor.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Saved, but its admins could not be signed out; they keep access until their session expires.')).toBeTruthy();
  });

  it('does not report a clean sign-out when the other servers were not told', async () => {
    const fake = api({
      'PUT /v1/admin/roles/support/permissions': (call) => ({ role: role('support', (call.body as { grants: string[] }).grants), signedOut: { admins: 2, sessions: 2 }, announced: false, sideEffects: 'done' }),
    });
    const user = userEvent.setup();
    renderPanel('/system/roles', fake);
    const editor = await openEditor(user, 'Support');
    await user.click(areaSwitch(editor, 'Support'));
    await user.click(editor.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Saved. The other servers pick it up within a minute.')).toBeTruthy();
  });

  it('words a refusal for a holder beyond the editor', async () => {
    const fake = api({ 'PUT /v1/admin/roles/support/permissions': () => problem(403, 'forbidden', { reason: 'beyond_holders', detail: 'no' }) });
    const user = userEvent.setup();
    renderPanel('/system/roles', fake);
    const editor = await openEditor(user, 'Support');
    await user.click(areaSwitch(editor, 'Support'));
    await user.click(editor.getByRole('button', { name: 'Save changes' }));
    expect(await editor.findByText('An admin with this role has access beyond yours, so you cannot take access from it.')).toBeTruthy();
  });

  it('keeps its title while the roles load and when they fail', async () => {
    renderPanel('/system/roles', api({ 'GET /v1/admin/roles': () => problem(500, 'internal', { detail: 'boom' }) }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Roles' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('reads in Persian', async () => {
    renderPanel('/system/roles', api(), { locale: 'fa' });
    expect(await screen.findByRole('heading', { level: 1, name: 'نقش‌ها' })).toBeTruthy();
    expect(await screen.findByText('قفل‌شده')).toBeTruthy();
    expect(await screen.findAllByText('مدیران: ۲')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /^ویرایش دسترسی‌های / })).toHaveLength(6);
  });
});
