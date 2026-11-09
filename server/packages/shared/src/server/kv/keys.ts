/**
 * Valkey key names, in one place. Every name carries the deployment prefix
 * (`REDIS_KEY_PREFIX`, e.g. `app:`), so several environments can share an
 * instance; clients are created without ioredis' own `keyPrefix`, and Lua
 * scripts get the full names in `KEYS[]`.
 *
 * `<uid>` is the raw user id (decimal), never the public id: these names
 * stay on the server.
 */

const PREFIX = /^[a-z0-9][a-z0-9:_-]{0,31}:$/;
const SEGMENT = /^[A-Za-z0-9._:+-]{1,200}$/;

function seg(value: string | number | bigint): string {
  const text = String(value);
  if (!SEGMENT.test(text)) throw new TypeError(`"${text.slice(0, 40)}" cannot be part of a key name`);
  return text;
}

/** `YYYYMMDD` in UTC, the day part of daily keys. */
export function utcDay(time: Date | number): string {
  return new Date(time).toISOString().slice(0, 10).replaceAll('-', '');
}

export type KeyBuilder = ReturnType<typeof createKeys>;

export function createKeys(prefix: string) {
  if (!PREFIX.test(prefix)) throw new TypeError('the key prefix must be lowercase and end with ":"');
  const k = (...parts: (string | number | bigint)[]): string => prefix + parts.map(seg).join(':');
  return {
    prefix,
    /** Any other name under the prefix; prefer a named builder. */
    raw: k,

    // Ids and leases
    idLease: (generator: number) => k('idgen', generator),
    jobLease: (job: string) => k('lease', job),

    // Sessions
    denySession: (sid: string | bigint) => k('deny', 'sid', sid),
    denyUser: (uid: string | bigint) => k('deny', 'uid', uid),
    refreshGrace: (sid: string | bigint) => k('rtg', sid),

    // Sign-in
    otp: (phoneHash: string) => k('otp', phoneHash),
    otpPhoneLimit: (phoneHash: string) => k('otp', 'rl', 'p', phoneHash),
    otpIpLimit: (ip: string) => k('otp', 'rl', 'ip', ip),
    otpPrefixLimit: (prefix: string, hour: string) => k('otp', 'rl', 'cc', prefix, hour),
    otpChallenge: (challengeId: string) => k('otp', 'c', challengeId),
    otpResendWait: (phoneHash: string) => k('otp', 'rl', 'w', phoneHash),
    otpVerifyIpLimit: (ip: string) => k('otp', 'rl', 'v', ip),
    otpInstallLimit: (installId: string) => k('otp', 'rl', 'i', installId),
    otpReviewWrong: (phoneHash: string) => k('otp', 'rl', 'rv', phoneHash),
    signInIpLimit: (route: string, ip: string) => k('si', 'rl', route, ip),
    googleNonce: (nonceId: string) => k('gn', nonceId),
    deletionRequest: (token: string) => k('delreq', token),
    deletionRequestByPhone: (phoneHash: string) => k('delreq', 'p', phoneHash),
    minorPhone: (phoneHash: string) => k('minor', phoneHash),
    minorDevice: (deviceKeyHash: string) => k('minor', 'd', deviceKeyHash),
    rateLimit: (route: string, key: string) => k('rl', route, key),

    // Own account
    meVersion: (uid: string | bigint) => k('mev', uid),
    meView: (uid: string | bigint, version: number) => k('me', uid, version),
    location: (uid: string | bigint) => k('loc', uid),
    device: (did: string | bigint) => k('dev', did),
    upload: (photoId: string | bigint) => k('up', photoId),
    entitlements: (uid: string | bigint, store: number) => k('ent', uid, store),
    /** The week's data export (kv-core, set by the API: the export's id). */
    exportRequest: (uid: string | bigint) => k('exp', uid),
    /** The export once its archive is stored (kv-core, set by the worker: its id and when its link runs out). */
    exportReady: (uid: string | bigint) => k('exp', 'r', uid),

    // Config
    configVersion: () => k('cfg', 'v'),
    catalogueVersion: () => k('cfg', 'catv'),
    configChannel: () => k('cfg', 'changed'),

    // Activity
    activeDay: (day: string) => k('la', day),
    lastSeen: (uid: string | bigint) => k('ls', uid),
    presence: (uid: string | bigint) => k('pres', uid),
    accountsHidden: () => k('vis', 'out'),
    /** People whose card changed lately (zset uid → a per-person increasing stamp, about the time in ms). */
    profilesChanged: () => k('vis', 'chg'),

    // Deck (kv-cache): the prepared queue (ids only), its metadata, the refill guard, cards, boosts, seen filters
    deckQueue: (uid: string | bigint) => k('deck', uid),
    deckMeta: (uid: string | bigint) => k('deckm', uid),
    deckLock: (uid: string | bigint) => k('deck', 'lock', uid),
    card: (uid: string | bigint, version: number | string, catalogue: number | string) => k('card', uid, version, catalogue),
    boosted: (cellR5: string | bigint) => k('bst', cellR5),
    /** Bloom filter of the people `uid` swiped in 15-day period `period`; tier 0, 1 (`:x`), 2 (`:y`). */
    seen: (uid: string | bigint, period: number, tier: 0 | 1 | 2) =>
      tier === 0 ? k('seen', uid, period) : k('seen', uid, period, tier === 1 ? 'x' : 'y'),
    seenCount: (uid: string | bigint, period: number) => k('seen', uid, period, 'n'),

    // Likes received (kv-core): weekly buckets of pending likers ({@link likeWeek}), the cap marker, the rebuilt flag
    likesIn: (uid: string | bigint, week: number) => k('lkin', uid, week),
    likesInFull: (uid: string | bigint, week: number) => k('lkin', uid, week, 'full'),
    likesReady: () => k('lk', 'ready'),
    /** The super likers among a bucket's likers (small: super likes are rationed). */
    likesInSuper: (uid: string | bigint, week: number) => k('lkin', uid, week, 's'),
    /** The day's one open like on a free plan (the liker's id), chosen once a day. */
    likesReveal: (uid: string | bigint, day: string) => k('lkr', uid, day),
    /** Set when two people matched: a like between them sent again later (a resend, a stale card) changes nothing. */
    likesMatched: (a: string | bigint, b: string | bigint) => (BigInt(a) < BigInt(b) ? k('lkm', a, b) : k('lkm', b, a)),
    /** Set while one of the two blocks the other: a like between them enters no bucket and tells nobody. */
    likesBlocked: (a: string | bigint, b: string | bigint) => (BigInt(a) < BigInt(b) ? k('lkb', a, b) : k('lkb', b, a)),
    /** Held for a minute while a super like of `target` by `actor` is paid from the wallet, so a resend cannot pay twice. */
    superLikePaying: (actor: string | bigint, target: string | bigint) => k('slp', actor, target),

    // Swipes (kv-core): daily, weekly and monthly quotas (`q:likes:<uid>:<yyyymmdd>`, `q:sl:<uid>:<yyyyww>`)
    quota: (feature: string, uid: string | bigint, period: string) => k('q', feature, uid, period),

    // Write-behind streams (kv-core): `wb:like`, `wb:match` (W3), `wb:msg` (W4), their dead letters and watermarks
    stream: (name: 'like' | 'match' | 'msg') => k('wb', name),
    streamDead: (name: 'like' | 'match' | 'msg') => k('wb', name, 'dead'),
    /** The smallest app id not yet durable in PostgreSQL for that stream (every id below it is). */
    streamWatermark: (name: 'like' | 'msg') => k('wb', name, 'wm'),

    // Conversations (matches): eligibility cache (kv-cache), lists and their versions (kv-core)
    matchState: (matchId: string | bigint) => k('mt', matchId),
    /** Set for an hour when a conversation ends, so an announcement that read the match before the end does nothing. */
    matchEnded: (matchId: string | bigint) => k('mte', matchId),
    conversationList: (uid: string | bigint) => k('cl', uid),
    conversationVersion: (uid: string | bigint) => k('cv', uid),
    /** Set while a conversation list's peers were checked against the visibility rule less than a minute ago. */
    conversationListChecked: (uid: string | bigint) => k('cl', 'ok', uid),
    /** A person's name, first photo and badge for lists, under their own-account version `mev` (kv-cache). */
    peerSummary: (uid: string | bigint, version: number) => k('ps', uid, version),
  };
}

/** Like buckets kept per person: the current ISO-style week and the four before it. */
export const LIKE_BUCKET_WEEKS = 5;

/**
 * The like bucket week of a time: whole weeks since Monday 1969-12-29 UTC
 * (ISO weeks start on Monday), so consecutive weeks are consecutive numbers.
 */
export function likeWeek(time: Date | number): number {
  const ms = typeof time === 'number' ? time : time.getTime();
  return Math.floor((Math.floor(ms / 86_400_000) + 3) / 7);
}

/** The weeks whose buckets are live at `time`, oldest first (`w-4 … w`). */
export function likeWeeks(time: Date | number): number[] {
  const w = likeWeek(time);
  return Array.from({ length: LIKE_BUCKET_WEEKS }, (_, i) => w - (LIKE_BUCKET_WEEKS - 1) + i);
}
