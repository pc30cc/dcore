import { expandGrants, permissionAreas } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { areaNote, areaSwitch, callerGrants, editorAreas, editorState, grantsChange, permissionBox, roleStanding, sameGrants, toGrants, withArea, withPermission } from '../src/lib/roles';
import { ROLES, role } from './systemFixtures';

/** The role editor's rules, as the server keeps them (`admin/grants.ts`), drawn as boxes. */

const OWNER = ['*'];
/** A delegated manager: the support role plus admins.read and admins.manage by name. */
const MANAGER = ['dashboard.read', 'support.*', 'users.read', 'admins.read', 'admins.manage'];

describe('the editor’s state', () => {
  it('reads a role’s grants as area switches and boxes, and writes them back as the server keeps them', () => {
    const state = editorState(['support.*', 'users.read', 'users.chats', 'zzz.read']);
    expect([...state.areas]).toEqual(['support']);
    expect([...state.exact].sort()).toEqual(['users.chats', 'users.read']);
    expect(toGrants(state)).toEqual(['support.*', 'users.chats', 'users.read']);
    // A switch turned on drops the boxes it covers, never a restricted one.
    const all = withArea(withPermission(state, 'users.edit', true), 'users', true);
    expect(toGrants(all)).toEqual(['support.*', 'users.*', 'users.chats']);
    // Off again: the boxes ticked one by one are back.
    expect(toGrants(withArea(all, 'users', false))).toEqual(['support.*', 'users.chats', 'users.edit', 'users.read']);
  });

  it('counts what a change adds and takes away, expanded', () => {
    expect(grantsChange(['support.*'], ['support.read'])).toEqual({ added: [], removed: ['support.write'] });
    expect(grantsChange(['users.read'], ['users.read', 'campaigns.read']).added).toEqual(['campaigns.read']);
    expect(sameGrants(['a.b', 'c.d'], ['c.d', 'a.b'])).toBe(true);
    expect(sameGrants(['a.b'], ['a.b', 'c.d'])).toBe(false);
  });

  it('lists every area of the catalogue once, in its order, with a switch where a wildcard covers something', () => {
    const areas = editorAreas();
    expect(areas.map((area) => area.area)).toEqual([...permissionAreas]);
    expect(areas.find((area) => area.area === 'admins')?.wildcard).toBe(false);
    expect(areas.find((area) => area.area === 'users')?.wildcard).toBe(true);
  });
});

describe('the boxes', () => {
  const support = editorState(['dashboard.read', 'support.*', 'users.read']);

  it('keep users.chats on the admin role alone, for the owner too', () => {
    expect(permissionBox(support, 'support', OWNER, 'users.chats')).toEqual({ checked: false, disabled: true, block: 'adminOnly' });
    expect(permissionBox(editorState([]), 'admin', OWNER, 'users.chats')).toEqual({ checked: false, disabled: false, block: null });
    // Held against the rule (written by hand): it may be cleared.
    expect(permissionBox(editorState(['users.chats']), 'support', OWNER, 'users.chats').disabled).toBe(false);
  });

  it('keep the analyst on dashboards, for the owner too', () => {
    const analyst = editorState(['dashboard.read']);
    expect(permissionBox(analyst, 'analyst', OWNER, 'users.read')).toEqual({ checked: false, disabled: true, block: 'dashboardsOnly' });
    expect(permissionBox(analyst, 'analyst', OWNER, 'dashboard.revenue').disabled).toBe(false);
    expect(areaSwitch(analyst, 'analyst', OWNER, 'users')).toEqual({ checked: false, disabled: true, block: 'dashboardsOnly' });
    expect(areaSwitch(analyst, 'analyst', OWNER, 'dashboard').disabled).toBe(false);
  });

  it('give a box covered by its area’s switch as ticked and fixed', () => {
    expect(permissionBox(support, 'support', OWNER, 'support.write')).toEqual({ checked: true, disabled: true, block: 'area' });
  });

  it('leave restricted permissions to the owner, and what an editor does not hold out of their reach', () => {
    const marketing = editorState(['campaigns.*', 'content.read', 'dashboard.read']);
    expect(permissionBox(marketing, 'marketing', MANAGER, 'admins.read')).toEqual({ checked: false, disabled: true, block: 'ownerOnly' });
    expect(permissionBox(marketing, 'marketing', MANAGER, 'billing.read')).toEqual({ checked: false, disabled: true, block: 'notHeld' });
    expect(permissionBox(marketing, 'marketing', MANAGER, 'support.read')).toEqual({ checked: false, disabled: false, block: null });
    // A wildcard only by an editor holding the same one.
    expect(areaSwitch(marketing, 'marketing', MANAGER, 'support').disabled).toBe(false);
    expect(areaSwitch(marketing, 'marketing', MANAGER, 'users')).toEqual({ checked: false, disabled: true, block: 'notHeld' });
    expect(permissionBox(marketing, 'marketing', OWNER, 'admins.read').disabled).toBe(false);
  });
});

describe('a role’s standing', () => {
  it('marks the owner role, the editor’s own role and a role beyond the editor', () => {
    const me = { roles: ['support'] };
    const grants = MANAGER;
    expect(roleStanding(ROLES[0]!, me, grants)).toEqual({ owner: true, yours: false, beyond: false });
    expect(roleStanding(ROLES[3]!, me, grants).yours).toBe(true);
    // The moderator holds what the manager does not.
    expect(roleStanding(ROLES[2]!, me, grants).beyond).toBe(true);
    // Within the manager's permissions but holding a wildcard the manager lacks.
    expect(roleStanding(role('ops', ['dashboard.*']), me, ['dashboard.read', 'dashboard.revenue', 'admins.manage']).beyond).toBe(true);
    expect(roleStanding(role('ops', ['dashboard.read']), me, ['dashboard.read', 'admins.manage']).beyond).toBe(false);
    // The owner reaches every role.
    expect(roleStanding(ROLES[2]!, { roles: ['superadmin'] }, OWNER).beyond).toBe(false);
  });

  it('takes the editor’s grants from the roles they hold', () => {
    expect(callerGrants(ROLES, { roles: ['support', 'analyst'] }).sort()).toEqual(['dashboard.read', 'dashboard.revenue', 'support.*', 'users.read']);
    expect(callerGrants(ROLES, null)).toEqual([]);
    expect(expandGrants(callerGrants(ROLES, { roles: ['superadmin'] })).length).toBeGreaterThan(40);
  });
});

describe('a reason said once per area', () => {
  const areaOf = (name: string) => editorAreas().find((item) => item.area === name)!;

  it('names the general reason of an area’s greyed boxes, said beside the area once', () => {
    const fresh = editorState(['dashboard.read']);
    // A manager who holds nothing of campaigns, or only some of users: not theirs to give.
    expect(areaNote(fresh, 'helpdesk', MANAGER, areaOf('campaigns'))).toBe('notHeld');
    expect(areaNote(fresh, 'helpdesk', MANAGER, areaOf('users'))).toBe('notHeld');
    // Support is the manager's (support.*): nothing to say.
    expect(areaNote(fresh, 'helpdesk', MANAGER, areaOf('support'))).toBeNull();
    // The analyst: dashboards only, for the owner too; its own area is free.
    const analyst = editorState(['dashboard.read', 'dashboard.revenue']);
    expect(areaNote(analyst, 'analyst', OWNER, areaOf('reports'))).toBe('dashboardsOnly');
    expect(areaNote(analyst, 'analyst', OWNER, areaOf('dashboard'))).toBeNull();
    // An area of restricted permissions only keeps its boxes' own reason (owner only).
    expect(areaNote(fresh, 'helpdesk', MANAGER, areaOf('admins'))).toBeNull();
    // The owner may change everything elsewhere.
    expect(areaNote(fresh, 'helpdesk', OWNER, areaOf('campaigns'))).toBeNull();
  });
});
