import { accountStatus, type AccountStatus } from './codes.js';

/**
 * The visibility rule, as the database applies it: `user_listable`,
 * `can_see` and `visible_subset` (migration 0006). Every list goes through
 * it: the deck (discovery membership), who liked me, profiles opened from a
 * list, conversation lists, calls and requests. This is its TypeScript
 * mirror, for the paths that decide without a statement (which hides
 * reach the deck and the conversation lists, whose list versions move);
 * `listableCases` and `canSeeCases` are the one table of cases both sides
 * are tested against.
 *
 * Contexts:
 * - 1 `discovery` (deck, explore, who liked me, search): only active and not
 *   shadowbanned; snoozed, in review, suspended, banned and deleted
 *   accounts vanish.
 * - 2 `relationship` (matches, conversations, calls): a snoozed account stays
 *   in its existing conversations; everything else as in 1.
 * Any other context lists nobody.
 *
 * `can_see` adds, for a pair: never oneself, test accounts (users.flags 1)
 * and everyone else never see each other, and a block either way hides
 * both from each other. The viewer's own status does not count (a
 * shadowbanned person behaves as active to themselves).
 */

export const visibilityContext = { discovery: 1, relationship: 2 } as const;
export type VisibilityContextName = keyof typeof visibilityContext;
export type VisibilityContext = (typeof visibilityContext)[VisibilityContextName];

const ACTIVE = accountStatus.code('active');
const SNOOZED = accountStatus.code('snoozed');
const TEST_ACCOUNT = 1;

/** `user_listable(status, shadowbanned, ctx)`: may a person of this state appear in a list of context `ctx`? */
export function userListable(status: number, shadowbanned: boolean, ctx: number): boolean {
  if (shadowbanned) return false;
  switch (ctx) {
    case visibilityContext.discovery:
      return status === ACTIVE;
    case visibilityContext.relationship:
      return status === ACTIVE || status === SNOOZED;
    default:
      return false;
  }
}

export interface VisibilityParty {
  id: string;
  /** users.flags (bit 1: test account). */
  flags: number;
}

export interface VisibilityTarget extends VisibilityParty {
  status: number;
  shadowbanned: boolean;
}

/** `can_see(viewer, target, ctx)` over the facts it reads: the two accounts and whether a block row joins them. */
export function canSee(viewer: VisibilityParty, target: VisibilityTarget, blocked: boolean, ctx: number): boolean {
  if (viewer.id === target.id) return false;
  if (!userListable(target.status, target.shadowbanned, ctx)) return false;
  if ((viewer.flags & TEST_ACCOUNT) !== (target.flags & TEST_ACCOUNT)) return false;
  return !blocked;
}

/** `visible_subset(viewer, ids, ctx)`: the targets the viewer may list, in input order. */
export function visibleSubset(viewer: VisibilityParty, targets: readonly (VisibilityTarget & { blocked: boolean })[], ctx: number): string[] {
  return targets.filter((t) => canSee(viewer, t, t.blocked, ctx)).map((t) => t.id);
}

/** What a change of an account's state means for the lists of others. */
export interface VisibilityChange {
  /** It left the discovery lists (decks, likes): `vis:out`. */
  leftDiscovery: boolean;
  /** It left the relationship lists (its peers' conversation lists change: their versions move). */
  leftRelationships: boolean;
  /** It came back to the discovery lists. */
  joinedDiscovery: boolean;
  /** It came back to the relationship lists. */
  joinedRelationships: boolean;
}

export function visibilityChange(
  before: { status: number; shadowbanned: boolean },
  after: { status: number; shadowbanned: boolean },
): VisibilityChange {
  const d0 = userListable(before.status, before.shadowbanned, visibilityContext.discovery);
  const d1 = userListable(after.status, after.shadowbanned, visibilityContext.discovery);
  const r0 = userListable(before.status, before.shadowbanned, visibilityContext.relationship);
  const r1 = userListable(after.status, after.shadowbanned, visibilityContext.relationship);
  return { leftDiscovery: d0 && !d1, leftRelationships: r0 && !r1, joinedDiscovery: !d0 && d1, joinedRelationships: !r0 && r1 };
}

// ─── The case table ──────────────────────────────────────────────────────

export interface ListableCase {
  status: AccountStatus;
  shadowbanned: boolean;
  /** Expected in context 1. */
  discovery: boolean;
  /** Expected in context 2. */
  relationship: boolean;
}

/** Every account status, with and without a shadowban, and what each context must answer (any other context: false). */
export const listableCases: readonly ListableCase[] = [
  { status: 'onboarding', shadowbanned: false, discovery: false, relationship: false },
  { status: 'pending_review', shadowbanned: false, discovery: false, relationship: false },
  { status: 'active', shadowbanned: false, discovery: true, relationship: true },
  { status: 'snoozed', shadowbanned: false, discovery: false, relationship: true },
  { status: 'suspended', shadowbanned: false, discovery: false, relationship: false },
  { status: 'banned', shadowbanned: false, discovery: false, relationship: false },
  { status: 'deleted', shadowbanned: false, discovery: false, relationship: false },
  { status: 'purged', shadowbanned: false, discovery: false, relationship: false },
  { status: 'onboarding', shadowbanned: true, discovery: false, relationship: false },
  { status: 'pending_review', shadowbanned: true, discovery: false, relationship: false },
  { status: 'active', shadowbanned: true, discovery: false, relationship: false },
  { status: 'snoozed', shadowbanned: true, discovery: false, relationship: false },
  { status: 'suspended', shadowbanned: true, discovery: false, relationship: false },
  { status: 'banned', shadowbanned: true, discovery: false, relationship: false },
  { status: 'deleted', shadowbanned: true, discovery: false, relationship: false },
  { status: 'purged', shadowbanned: true, discovery: false, relationship: false },
];

/** Contexts the table is checked in: the two real ones and two that list nobody. */
export const checkedContexts = [0, 1, 2, 3] as const;

export interface CanSeeCase {
  name: string;
  /** The viewer is the target. */
  self?: true;
  viewer: { status: AccountStatus; shadowbanned?: boolean; test?: boolean };
  target: { status: AccountStatus; shadowbanned?: boolean; test?: boolean };
  /** Who blocked whom (users of the pair). */
  block?: 'viewer' | 'target' | 'both';
  /** Expected in context 1 and 2. */
  discovery: boolean;
  relationship: boolean;
}

/** Pairs: the block, the test-account separation, self, and the viewer's own state not counting. */
export const canSeeCases: readonly CanSeeCase[] = [
  { name: 'two active people', viewer: { status: 'active' }, target: { status: 'active' }, discovery: true, relationship: true },
  { name: 'oneself', self: true, viewer: { status: 'active' }, target: { status: 'active' }, discovery: false, relationship: false },
  { name: 'the viewer blocked the target', viewer: { status: 'active' }, target: { status: 'active' }, block: 'viewer', discovery: false, relationship: false },
  { name: 'the target blocked the viewer', viewer: { status: 'active' }, target: { status: 'active' }, block: 'target', discovery: false, relationship: false },
  { name: 'both blocked each other', viewer: { status: 'active' }, target: { status: 'active' }, block: 'both', discovery: false, relationship: false },
  { name: 'a snoozed target', viewer: { status: 'active' }, target: { status: 'snoozed' }, discovery: false, relationship: true },
  { name: 'a snoozed target that blocked the viewer', viewer: { status: 'active' }, target: { status: 'snoozed' }, block: 'target', discovery: false, relationship: false },
  { name: 'a shadowbanned target', viewer: { status: 'active' }, target: { status: 'active', shadowbanned: true }, discovery: false, relationship: false },
  { name: 'a shadowbanned viewer sees others as before', viewer: { status: 'active', shadowbanned: true }, target: { status: 'active' }, discovery: true, relationship: true },
  { name: 'a suspended target', viewer: { status: 'active' }, target: { status: 'suspended' }, discovery: false, relationship: false },
  { name: 'a banned target', viewer: { status: 'active' }, target: { status: 'banned' }, discovery: false, relationship: false },
  { name: 'a deleted target', viewer: { status: 'active' }, target: { status: 'deleted' }, discovery: false, relationship: false },
  { name: 'a target in review', viewer: { status: 'active' }, target: { status: 'pending_review' }, discovery: false, relationship: false },
  { name: 'a test account sees a real one', viewer: { status: 'active', test: true }, target: { status: 'active' }, discovery: false, relationship: false },
  { name: 'a real account sees a test one', viewer: { status: 'active' }, target: { status: 'active', test: true }, discovery: false, relationship: false },
  { name: 'two test accounts', viewer: { status: 'active', test: true }, target: { status: 'active', test: true }, discovery: true, relationship: true },
  { name: 'a snoozed viewer', viewer: { status: 'snoozed' }, target: { status: 'active' }, discovery: true, relationship: true },
  { name: 'a banned viewer', viewer: { status: 'banned' }, target: { status: 'active' }, discovery: true, relationship: true },
];
