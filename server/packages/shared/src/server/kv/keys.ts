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

    // Config
    configVersion: () => k('cfg', 'v'),
    catalogueVersion: () => k('cfg', 'catv'),
    configChannel: () => k('cfg', 'changed'),

    // Activity
    activeDay: (day: string) => k('la', day),
    lastSeen: (uid: string | bigint) => k('ls', uid),
    presence: (uid: string | bigint) => k('pres', uid),
    accountsHidden: () => k('vis', 'out'),
  };
}
