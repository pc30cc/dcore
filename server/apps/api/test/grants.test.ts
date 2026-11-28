import { describe, expect, it } from 'vitest';
import { checkRoleEdit, checkRoleRules, isOwnerLike, normalizeGrants, removedPermissions } from '../src/admin/grants.js';

/** The role editor's rules, as a decision table (no database). */

const SUPPORT = ['dashboard.read', 'support.*', 'users.read'];

describe('normalizeGrants', () => {
  it('keeps known grants, drops duplicates and permissions a wildcard covers, and sorts', () => {
    expect(normalizeGrants(['users.read', 'support.*', 'support.read', 'users.read', 'dashboard.read'])).toEqual({ grants: ['dashboard.read', 'support.*', 'users.read'] });
    // A restricted permission is never covered by its area's wildcard: kept beside it.
    expect(normalizeGrants(['users.*', 'users.chats', 'users.read'])).toEqual({ grants: ['users.*', 'users.chats'] });
    expect(normalizeGrants([])).toEqual({ grants: [] });
  });

  it("refuses '*', unknown permissions and wildcards of areas that do not exist, at their index", () => {
    expect(normalizeGrants(['users.read', '*'])).toEqual({ issue: { pointer: '/grants/1', code: 'owner_grant' } });
    expect(normalizeGrants(['users.fly'])).toEqual({ issue: { pointer: '/grants/0', code: 'unknown_permission' } });
    expect(normalizeGrants(['users.read', 'zzz.*'])).toEqual({ issue: { pointer: '/grants/1', code: 'unknown_permission' } });
  });
});

describe('checkRoleRules', () => {
  it('keeps users.chats on the admin role and the analyst on dashboards, whoever edits', () => {
    expect(checkRoleRules('support', ['users.read', 'users.chats'])).toEqual({ pointer: '/grants/1', code: 'chats_admin_only' });
    expect(checkRoleRules('moderator', ['users.*'])).toBeNull();
    expect(checkRoleRules('admin', ['users.*', 'users.chats'])).toBeNull();
    expect(checkRoleRules('analyst', ['dashboard.read', 'dashboard.revenue', 'dashboard.*'])).toBeNull();
    expect(checkRoleRules('analyst', ['dashboard.read', 'users.read'])).toEqual({ pointer: '/grants/1', code: 'analyst_dashboards_only' });
    expect(checkRoleRules('analyst', ['users.chats'])).toEqual({ pointer: '/grants/0', code: 'chats_admin_only' });
  });
});

describe('checkRoleEdit', () => {
  it('lets the owner do anything within the rules', () => {
    expect(checkRoleEdit({ callerGrants: ['*'], stored: SUPPORT, requested: [...SUPPORT, 'campaigns.read', 'admins.read'] })).toBeNull();
    expect(checkRoleEdit({ callerGrants: ['*'], stored: ['users.*', 'users.chats'], requested: ['users.*'] })).toBeNull();
  });

  it('refuses a role beyond the editor, wildcards the editor lacks, grants beyond the editor and restricted changes', () => {
    // A delegated manager: support with admins.manage and admins.read by name.
    const manager = [...SUPPORT, 'admins.manage', 'admins.read'];
    expect(checkRoleEdit({ callerGrants: manager, stored: ['users.*', 'moderation.*'], requested: ['users.read'] })).toEqual({ reason: 'beyond_role' });
    expect(checkRoleEdit({ callerGrants: manager, stored: ['dashboard.read'], requested: ['dashboard.read', 'users.read'] })).toBeNull();
    expect(checkRoleEdit({ callerGrants: manager, stored: ['dashboard.read'], requested: ['dashboard.read', 'campaigns.read'] })).toEqual({ reason: 'beyond_grants', permissions: ['campaigns.read'] });
    // A wildcard is given only by an editor holding the same one (it covers permissions a later build adds).
    expect(checkRoleEdit({ callerGrants: ['users.read', 'users.edit', 'admins.manage', 'admins.read'], stored: ['users.read'], requested: ['users.*'] })).toMatchObject({ reason: 'beyond_grants' });
    expect(checkRoleEdit({ callerGrants: manager, stored: ['dashboard.read'], requested: ['support.*'] })).toBeNull();
    // Restricted permissions are given or taken with '*' only, even when the editor holds them.
    expect(checkRoleEdit({ callerGrants: manager, stored: ['dashboard.read'], requested: ['dashboard.read', 'admins.read'] })).toEqual({ reason: 'restricted_permission', permissions: ['admins.read'] });
    expect(checkRoleEdit({ callerGrants: manager, stored: ['admins.read', 'dashboard.read'], requested: ['dashboard.read'] })).toEqual({ reason: 'restricted_permission', permissions: ['admins.read'] });
    expect(checkRoleEdit({ callerGrants: manager, stored: ['admins.read', 'dashboard.read'], requested: ['admins.read', 'dashboard.read', 'users.read'] })).toBeNull();
  });
});

describe('the rest', () => {
  it('treats the owner role and any role holding * as untouchable', () => {
    expect(isOwnerLike('superadmin', [])).toBe(true);
    expect(isOwnerLike('support', ['*'])).toBe(true);
    expect(isOwnerLike('support', SUPPORT)).toBe(false);
  });

  it('names what a change takes away, by permission', () => {
    expect(removedPermissions(['support.*', 'users.read'], ['support.read', 'users.read'])).toEqual(['support.write']);
    expect(removedPermissions(['support.read'], ['support.*'])).toEqual([]);
  });
});
