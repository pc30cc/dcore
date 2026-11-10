import { z } from 'zod';

/**
 * Every enumeration is a `smallint` in PostgreSQL and a lowercase string on
 * the wire. This module is the one place the two meet: each table maps a
 * wire name to its code, and carries the words the SQL table comment uses
 * for it, so a test can hold the tables against the migrations' COMMENTs.
 *
 * Bit sets (flags columns) are listed as bit values: their codes are powers
 * of two and a column holds their sum.
 */

export interface CodeEntry {
  readonly code: number;
  /** The words the SQL comment uses for this code (`'waiting for a human'`), without notes in parentheses. */
  readonly sql: string;
}

/** Where a code table is documented in SQL: the table whose COMMENT lists it, and the key in that comment. */
export interface CodeSource {
  readonly table: string;
  readonly key: string;
}

export class CodeTable<N extends string> {
  readonly names: readonly N[];
  readonly codes: readonly number[];
  readonly source: CodeSource;
  readonly entries: Readonly<Record<N, CodeEntry>>;
  /** Names of the codes that never leave the server (a shadowban, a purged account). */
  readonly internal: readonly N[];
  /** zod schema of the wire name (every name, internal ones included). */
  readonly schema: z.ZodEnum<{ [K in N]: K }>;
  private readonly byCode: ReadonlyMap<number, N>;

  constructor(source: CodeSource, entries: Readonly<Record<N, CodeEntry>>, internal: readonly N[] = []) {
    this.source = source;
    this.entries = entries;
    this.names = Object.keys(entries) as N[];
    this.codes = this.names.map((name) => entries[name].code);
    this.internal = internal;
    const byCode = new Map<number, N>();
    for (const name of this.names) {
      const { code } = entries[name];
      if (!Number.isInteger(code) || code < 0 || code > 32_767) throw new RangeError(`${name}: ${code} is not a smallint code`);
      if (byCode.has(code)) throw new Error(`${source.table}.${source.key}: code ${code} is used twice`);
      byCode.set(code, name);
    }
    this.byCode = byCode;
    this.schema = z.enum(this.names as [N, ...N[]]);
  }

  /** The code of a wire name. */
  code(name: N): number {
    return this.entries[name].code;
  }

  /** The wire name of a code; throws on a code the table does not know (a database value out of range is a bug). */
  name(code: number): N {
    const name = this.byCode.get(code);
    if (name === undefined) throw new RangeError(`${this.source.table}.${this.source.key}: unknown code ${code}`);
    return name;
  }

  /** The wire name of a code, or `undefined`. */
  nameOrUndefined(code: number | null | undefined): N | undefined {
    return code === null || code === undefined ? undefined : this.byCode.get(code);
  }

  has(name: string): name is N {
    return Object.hasOwn(this.entries, name);
  }

  /** The names a client may see: every name but the internal ones. */
  get publicNames(): N[] {
    return this.names.filter((name) => !this.internal.includes(name));
  }
}

function codes<N extends string>(
  table: string,
  key: string,
  entries: Readonly<Record<N, readonly [code: number, sql: string]>>,
  internal: readonly NoInfer<N>[] = [],
): CodeTable<N> {
  const out = {} as Record<N, CodeEntry>;
  for (const name of Object.keys(entries) as N[]) {
    const [code, sql] = entries[name];
    out[name] = { code, sql };
  }
  return new CodeTable({ table, key }, out, internal);
}

/** Sum of bit values into a bitmask column, and back. */
export function toBitmask(bits: Iterable<number>): number {
  let mask = 0;
  for (const bit of bits) mask |= bit;
  return mask;
}

export function hasBit(mask: number, bit: number): boolean {
  return (mask & bit) === bit;
}

/** A set of codes as the bitmask `sum(1 << code)` (preferences.interested_in, preferences.intents). */
export function codesToMask(values: Iterable<number>): number {
  let mask = 0;
  for (const value of values) mask |= 1 << value;
  return mask;
}

export function maskToCodes(mask: number, candidates: readonly number[]): number[] {
  return candidates.filter((code) => (mask & (1 << code)) !== 0);
}

// ─── Accounts (0002) ─────────────────────────────────────────────────────

export const accountStatus = codes(
  'users',
  'status',
  {
    onboarding: [1, 'onboarding'],
    pending_review: [2, 'pending_review'],
    active: [3, 'active'],
    snoozed: [4, 'snoozed'],
    suspended: [5, 'suspended'],
    banned: [6, 'banned'],
    deleted: [7, 'deleted'],
    purged: [8, 'purged'],
  },
  ['purged'],
);
export type AccountStatus = (typeof accountStatus.names)[number];

export const gender = codes('users', 'gender', {
  woman: [1, 'woman'],
  man: [2, 'man'],
  nonbinary: [3, 'non-binary'],
});
export type Gender = (typeof gender.names)[number];

export const deletedVia = codes('users', 'deleted_via', {
  app: [1, 'app'],
  web: [2, 'web page'],
  admin: [3, 'admin'],
  under_age: [4, 'under-age refusal'],
});
export type DeletedVia = (typeof deletedVia.names)[number];

/** users.flags bits. */
export const userFlags = codes('users', 'flags', { test_account: [1, 'test account'] });

export const consentKind = codes('user_consents', 'kind', {
  terms: [1, 'terms of service'],
  privacy: [2, 'privacy policy'],
  guidelines: [3, 'community guidelines'],
  sensitive_fields: [4, 'sensitive profile fields'],
  gender_matching: [5, 'matching on gender preference'],
  marketing_push: [6, 'marketing push'],
  selfie_biometrics: [7, 'selfie biometrics'],
});
export type ConsentKind = (typeof consentKind.names)[number];

/** The consents tied to a legal text version (`app_config legal.versions`). */
export const legalConsentKinds = ['terms', 'privacy', 'guidelines'] as const satisfies readonly ConsentKind[];
export type LegalConsentKind = (typeof legalConsentKinds)[number];

export const authProvider = codes('auth_identities', 'provider', {
  phone: [1, 'phone'],
  google: [2, 'Google'],
  apple: [3, 'Apple'],
});
export type AuthProvider = (typeof authProvider.names)[number];

export const platform = codes('devices', 'platform', { android: [1, 'android'], ios: [2, 'ios'] });

/**
 * The store a device, session, product or purchase belongs to. Wire names are
 * the ones the app sends in `X-Client` (`bazaar/12031`); `app_config` keys use
 * the SQL words (`cafe_bazaar`, `google_play`).
 */
export const store = codes(
  'devices',
  'store',
  {
    play: [1, 'google_play'],
    bazaar: [2, 'cafe_bazaar'],
    app_store: [3, 'app_store'],
  },
  ['app_store'],
);
export type StoreName = (typeof store.names)[number];
/** The stores an Android build ships in. */
export const appStores = ['bazaar', 'play'] as const satisfies readonly StoreName[];
export type AppStore = (typeof appStores)[number];
export const appStoreSchema = z.enum(appStores);

export const integrity = codes('devices', 'integrity', {
  unknown: [0, 'unknown/unsupported'],
  basic: [1, 'basic'],
  device: [2, 'device'],
  strong: [3, 'strong'],
  failed: [4, 'failed'],
});

export const revokeReason = codes('sessions', 'revoke_reason', {
  logout: [1, 'logout'],
  logout_all: [2, 'logout_all'],
  reuse_detected: [3, 'reuse_detected'],
  admin: [4, 'admin'],
  ban: [5, 'ban'],
  account_deleted: [6, 'account_deleted'],
  idle_expired: [7, 'idle_expired'],
});
export type RevokeReason = (typeof revokeReason.names)[number];

// ─── Profiles (0004) ─────────────────────────────────────────────────────

export const fieldType = codes('profile_field_defs', 'type', {
  single: [1, 'single choice'],
  multi: [2, 'multiple choice'],
  text: [3, 'short text'],
  number: [4, 'number'],
  country: [5, 'country'],
});
export type FieldType = (typeof fieldType.names)[number];

export const promptKind = codes('prompt_defs', 'kind', { text: [1, 'text answer'], voice: [2, 'voice answer'] });

export const intention = codes('profiles', 'intention', {
  serious: [1, 'serious relationship'],
  marriage: [2, 'marriage'],
  friendship: [3, 'friendship'],
  not_sure: [4, 'not sure'],
});
export type Intention = (typeof intention.names)[number];

/** profiles.text_state; profile_prompts.status uses the same codes. */
export const textState = codes('profiles', 'text_state', {
  checking: [1, 'checking'],
  approved: [2, 'approved'],
  rejected: [3, 'rejected'],
});
export type TextState = (typeof textState.names)[number];

export const promptStatus = codes('profile_prompts', 'status', {
  checking: [1, 'checking'],
  approved: [2, 'approved'],
  rejected: [3, 'rejected'],
});

export const photoStatus = codes('photos', 'status', {
  processing: [1, 'processing'],
  review: [2, 'waiting for a human'],
  approved: [3, 'approved'],
  rejected: [4, 'rejected'],
});
export type PhotoStatus = (typeof photoStatus.names)[number];

/** photos.mod_flags bits (automatic labels). */
export const photoModFlags = codes('photos', 'mod_flags', {
  nudity: [1, 'nudity'],
  violence: [2, 'violence'],
  text: [4, 'text'],
  possible_minor: [8, 'possible minor'],
  no_face: [16, 'no face'],
  duplicate: [32, 'duplicate/stolen'],
});

/** preferences.flags bits. */
export const preferenceFlags = codes('preferences', 'flags', {
  whole_country: [1, 'whole country'],
  verified_only: [2, 'verified profiles only'],
});

export const locationSource = codes('user_locations', 'source', {
  gps: [1, 'GPS'],
  city: [2, 'city chosen by hand'],
  network: [3, 'country from the network'],
});
export type LocationSource = (typeof locationSource.names)[number];

export const verificationMethod = codes('verifications', 'method', {
  selfie: [1, 'selfie liveness'],
  video: [2, 'video selfie'],
});

export const verificationStatus = codes('verifications', 'status', {
  started: [1, 'started'],
  review: [2, 'waiting for a human'],
  approved: [3, 'approved'],
  rejected: [4, 'rejected'],
  expired: [5, 'expired'],
  lapsed: [6, 'lapsed'],
});

/**
 * profiles.ui_template (0025): the visual template a person chose. `default`
 * follows the admin panel's default; the other names are the ids of
 * `uiTemplates` (templates.ts), held equal by a test. Codes never move.
 */
export const uiTemplateChoice = codes('profiles', 'ui_template', {
  default: [0, 'default'],
  neon: [1, 'neon'],
  white: [2, 'white'],
});

// ─── Social (0005) ───────────────────────────────────────────────────────

export const matchState = codes('matches', 'state', {
  active: [1, 'active'],
  unmatched: [2, 'unmatched'],
  blocked: [3, 'ended by a block'],
  account_gone: [4, 'ended by a ban or deletion'],
  admin: [5, 'ended by an admin'],
});

export const matchSource = codes('matches', 'source', {
  like: [1, 'mutual like'],
  super_like: [2, 'super like'],
  request: [3, 'message request accepted'],
  item_like: [4, 'like on a photo or prompt'],
});
export type ConversationSource = (typeof matchSource.names)[number];

/** matches.flags bits. */
export const matchFlags = codes('matches', 'flags', {
  lo_calls: [1, 'user_lo allows calls'],
  hi_calls: [2, 'user_hi allows calls'],
  lo_muted: [4, 'user_lo muted'],
  hi_muted: [8, 'user_hi muted'],
});

export const likeKind = codes('likes', 'kind', { like: [1, 'like'], superlike: [2, 'super like'] });
export type LikeKind = (typeof likeKind.names)[number];

export const likeItemKind = codes('likes', 'item_kind', {
  profile: [0, 'the profile'],
  photo: [1, 'a photo'],
  prompt: [2, 'a prompt'],
});

export const requestStatus = codes('message_requests', 'status', {
  pending: [1, 'pending'],
  accepted: [2, 'accepted'],
  declined: [3, 'declined'],
  expired: [4, 'expired'],
  withdrawn: [5, 'withdrawn or the sender left'],
});

export const messageKind = codes('messages', 'kind', {
  text: [1, 'text'],
  image: [2, 'image'],
  voice: [3, 'voice'],
  gif: [4, 'GIF'],
  call: [5, 'call line'],
  like_note: [6, 'like note'],
  reaction: [7, 'reaction'],
  unsend: [8, 'unsend'],
});
export type MessageKind = (typeof messageKind.names)[number];

/** messages.flags bits. */
export const messageFlags = codes('messages', 'flags', {
  risky: [1, 'risky pattern'],
  hidden: [2, 'hidden by moderation'],
  warned: [4, 'sent after an "are you sure?" warning'],
  body_removed: [8, 'body removed after an unsend'],
});

export const reportContext = codes('reports', 'context', {
  profile: [1, 'profile'],
  chat: [2, 'chat'],
  photo: [3, 'photo'],
  call: [4, 'call'],
  social: [5, 'social'],
});

export const reportReason = codes('reports', 'reason', {
  fake: [1, 'fake'],
  harassment: [2, 'harassment'],
  inappropriate: [3, 'inappropriate content'],
  scam: [4, 'scam'],
  under_18: [5, 'under 18'],
  threat: [6, 'threat or danger'],
  spam: [7, 'spam'],
  child_safety: [8, 'child safety'],
  other: [99, 'other'],
});
export type ReportReason = (typeof reportReason.names)[number];

export const reportStatus = codes('reports', 'status', {
  open: [1, 'open'],
  in_review: [2, 'in review'],
  actioned: [3, 'actioned'],
  dismissed: [4, 'dismissed'],
  duplicate: [5, 'duplicate'],
});

export const callKind = codes('calls', 'kind', { audio: [1, 'audio'], video: [2, 'video'] });
export type CallKind = (typeof callKind.names)[number];

export const callOutcome = codes('calls', 'outcome', {
  completed: [1, 'completed'],
  declined: [2, 'declined'],
  cancelled: [3, 'cancelled'],
  missed: [4, 'missed'],
  failed: [5, 'failed'],
});
export type CallOutcome = (typeof callOutcome.names)[number];

export const callEndedBy = codes('calls', 'ended_by', { caller: [1, 'caller'], callee: [2, 'callee'], system: [3, 'system'] });

/** calls.end_reason. `callee_busy` is internal: both people see a missed call. */
export const callEndReason = codes(
  'calls',
  'end_reason',
  {
    hangup: [1, 'hangup'],
    declined: [2, 'declined'],
    cancelled: [3, 'cancelled'],
    ring_timeout: [4, 'ring timeout'],
    peer_left: [5, 'peer left'],
    room_gone: [6, 'room gone'],
    connect_timeout: [7, 'connect timeout'],
    room_failed: [8, 'room failed'],
    expired: [9, 'expired'],
    callee_busy: [10, 'callee busy'],
  },
  ['callee_busy'],
);

// ─── Moderation and admin (0008) ─────────────────────────────────────────

/**
 * moderation_actions.kind. Only warnings, suspensions and bans are shown to
 * their subject (with the reason and an appeal); a shadowban never is.
 */
export const moderationKind = codes(
  'moderation_actions',
  'kind',
  {
    warning: [1, 'warning'],
    suspension: [2, 'suspension'],
    ban: [3, 'ban'],
    shadowban: [4, 'shadowban'],
    lift: [5, 'lift'],
    photo_rejected: [6, 'photo rejected'],
    text_rejected: [7, 'text rejected'],
    verification_revoked: [8, 'verification revoked by an admin'],
    device_ban: [9, 'device or phone ban'],
    sessions_revoked: [10, 'sessions revoked'],
  },
  ['shadowban'],
);
export type ModerationKind = (typeof moderationKind.names)[number];
/** The kinds a person sees in the app, in `GET /v1/me` and `GET /v1/me/moderation`. */
export const visibleModerationKinds = ['warning', 'suspension', 'ban'] as const satisfies readonly ModerationKind[];
export type VisibleModerationKind = (typeof visibleModerationKinds)[number];

export const appealStatus = codes('appeals', 'status', {
  open: [1, 'open'],
  upheld: [2, 'upheld'],
  overturned: [3, 'overturned'],
});
export type AppealStatus = (typeof appealStatus.names)[number];

export const deviceBanKind = codes('device_bans', 'kind', {
  device: [1, 'device key'],
  phone: [2, 'phone number'],
  google: [3, 'Google account'],
});

export const legalHoldKind = codes('legal_holds', 'kind', {
  child_safety: [1, 'child safety'],
  threat: [2, 'threat or violence'],
  authority: [3, 'request from an authority'],
});

export const supportTicketStatus = codes('support_tickets', 'status', {
  open: [1, 'open'],
  answered: [2, 'waiting for the user'],
  closed: [3, 'closed'],
});

/** audit_log.target_type: what an audit row is about (`targetId` names the row of that kind). */
export const auditTarget = codes('audit_log', 'target_type', {
  none: [0, 'none'],
  user: [1, 'user'],
  photo: [2, 'photo'],
  report: [3, 'report'],
  appeal: [4, 'appeal'],
  purchase: [5, 'purchase'],
  config: [6, 'config'],
  admin: [7, 'admin'],
  campaign: [8, 'campaign'],
  ticket: [9, 'ticket'],
  verification: [10, 'verification'],
  message: [11, 'message'],
  feature_flag: [12, 'feature flag'],
  i18n_string: [13, 'i18n string'],
  product: [14, 'product'],
  plan: [15, 'plan'],
  legal_hold: [16, 'legal hold'],
});
export type AuditTarget = (typeof auditTarget.names)[number];

/** admin_sessions.revoke_reason (0023). */
export const adminRevokeReason = codes('admin_sessions', 'revoke_reason', {
  logout: [1, 'logout'],
  logout_all: [2, 'logout_all'],
  reuse_detected: [3, 'reuse_detected'],
  owner: [4, 'owner'],
  disabled: [5, 'disabled'],
  password_changed: [6, 'password_changed'],
  totp_reset: [7, 'totp_reset'],
});
export type AdminRevokeReason = (typeof adminRevokeReason.names)[number];

// ─── Billing (0007) ──────────────────────────────────────────────────────

export const productKind = codes('store_products', 'kind', {
  subscription: [1, 'auto-renewing subscription'],
  consumable: [2, 'consumable'],
});

export const walletItem = codes('store_products', 'grant_item', {
  superlike: [1, 'super like'],
  boost: [2, 'boost'],
  spotlight: [3, 'spotlight'],
  dm: [4, 'direct message'],
});
export type WalletItem = (typeof walletItem.names)[number];

export const purchaseState = codes('store_purchases', 'state', {
  pending: [1, 'pending'],
  active: [2, 'active'],
  canceled: [3, 'canceled'],
  grace: [4, 'in grace period'],
  on_hold: [5, 'on hold'],
  paused: [6, 'paused'],
  expired: [7, 'expired'],
  revoked: [8, 'revoked/refunded'],
  replaced: [9, 'replaced by a linked token'],
  consumed: [10, 'consumed'],
  unclaimed: [11, 'unclaimed'],
  purchased: [12, 'purchased'],
});

export const productBadge = codes(
  'store_products',
  'badge',
  {
    none: [0, 'none'],
    popular: [1, 'most popular'],
    best_value: [2, 'best value'],
    new: [3, 'new'],
  },
  ['none'],
);

/** plans.badge (0024): the same marks as a product's, shown with the plan on the paywall. */
export const planBadge = codes(
  'plans',
  'badge',
  {
    none: [0, 'none'],
    popular: [1, 'most popular'],
    best_value: [2, 'best value'],
    new: [3, 'new'],
  },
  ['none'],
);

/** store_events.event: the kind of state change an event row records. */
export const storeEventKind = codes('store_events', 'event', {
  verified: [1, 'verified'],
  renewed: [2, 'renewed'],
  auto_renew_off: [3, 'auto-renew off'],
  auto_renew_on: [4, 'auto-renew on/restarted'],
  grace: [5, 'grace'],
  on_hold: [6, 'on hold'],
  recovered: [7, 'recovered'],
  paused: [8, 'paused'],
  expired: [9, 'expired'],
  revoked: [10, 'revoked or refunded'],
  replaced: [11, 'replaced'],
  acknowledged: [12, 'acknowledged'],
  consumed: [13, 'consumed'],
  credited: [14, 'credited'],
  other: [99, 'other'],
});

/** store_events.source: what made the server look at the purchase. */
export const storeEventSource = codes('store_events', 'source', {
  app: [1, 'app'],
  rtdn: [2, 'Play RTDN'],
  recheck: [3, 'scheduled re-check'],
  voided: [4, 'Play voided purchases list'],
  admin: [5, 'admin'],
  restore: [6, 'restore'],
  bazaar: [7, 'Bazaar validation'],
});

export const subscriptionStatus = codes('subscriptions', 'status', {
  renewing: [1, 'active and renewing'],
  until_expiry: [2, 'active until expires_at'],
  grace: [3, 'grace period'],
  granted: [4, 'granted'],
});

export const ledgerReason = codes('wallet_ledger', 'reason', {
  purchase: [1, 'purchase credit'],
  use: [2, 'use'],
  refund: [3, 'refund reversal'],
  gift: [4, 'admin gift'],
  referral: [5, 'referral reward'],
  allowance: [6, 'plan allowance'],
  expiry: [7, 'expiry'],
  correction: [8, 'admin correction'],
  restored: [9, 'restored'],
});

/**
 * users.notify_flags bits (migration 0010): which pushes a person gets, and
 * whether they show the message text and names (`previews`).
 */
export const notifyFlags = codes('users', 'notify_flags', {
  messages: [1, 'messages'],
  matches: [2, 'matches'],
  likes: [4, 'likes'],
  calls: [8, 'calls'],
  offers: [16, 'offers'],
  previews: [32, 'previews'],
});
export type NotifyFlag = (typeof notifyFlags.names)[number];
/** messages, matches, likes and calls on; offers and previews off. */
export const NOTIFY_FLAGS_DEFAULT = 15;

/** Every table, for the test that holds them against the SQL comments. */
export const codeTables: readonly CodeTable<string>[] = [
  accountStatus,
  gender,
  deletedVia,
  userFlags,
  consentKind,
  authProvider,
  platform,
  store,
  integrity,
  revokeReason,
  fieldType,
  promptKind,
  intention,
  textState,
  promptStatus,
  photoStatus,
  photoModFlags,
  preferenceFlags,
  locationSource,
  verificationMethod,
  verificationStatus,
  uiTemplateChoice,
  matchState,
  matchSource,
  matchFlags,
  likeKind,
  likeItemKind,
  requestStatus,
  messageKind,
  messageFlags,
  reportContext,
  reportReason,
  reportStatus,
  callKind,
  callOutcome,
  callEndedBy,
  callEndReason,
  moderationKind,
  appealStatus,
  deviceBanKind,
  legalHoldKind,
  supportTicketStatus,
  auditTarget,
  adminRevokeReason,
  productKind,
  walletItem,
  purchaseState,
  productBadge,
  planBadge,
  storeEventKind,
  storeEventSource,
  subscriptionStatus,
  ledgerReason,
  notifyFlags,
];
