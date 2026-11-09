import { createHash } from 'node:crypto';
import { z } from 'zod';
import { checkOrigin } from '../../api/origins.js';
import type { DataSealer } from '../crypto/index.js';
import { mintTurnCredential, turnPassword } from './turnAuth.js';

/**
 * How a client reaches a call: the signalling URL it hands to LiveKit, and
 * the in-country TURN relay for the participants whose network needs it.
 *
 * - Signalling goes through a Cloudflare-proxied hostname (a direct
 *   WebSocket from some mobile networks dies after its first few KB), so
 *   `wsUrl` is that hostname, reduced to an origin: LiveKit's SDK adds its
 *   own path, and `wss://host/rtc` would become `wss://host/rtc/rtc`.
 * - Media from some networks cannot reach LiveKit abroad, its own TURN
 *   included; a coturn relay in the country, relaying only to LiveKit, fixes
 *   it. A client handed TURN URLs uses them instead of LiveKit's ICE servers,
 *   so the relay goes only to a participant whose own trusted country (as
 *   Cloudflare saw the request) is on the relay's list; everyone else keeps
 *   LiveKit's. Each participant's token request decides it for that
 *   participant.
 *
 * The settings live in `app_config` under {@link RTC_SETTINGS_KEY}, written
 * only by the admin RTC route; the shared secret is sealed (AES-256-GCM
 * under DATA_KEYS) and shown only as a fingerprint.
 */

export const RTC_SETTINGS_KEY = 'providers.rtc';
/** The sealing purpose of the relay's shared secret. */
export const TURN_SECRET_PURPOSE = 'providers.rtc.turn_secret';

export const TURN_CREDENTIAL_TTL_DEFAULT_SECONDS = 6 * 3_600;
export const TURN_CREDENTIAL_TTL_MIN_SECONDS = 600;
export const TURN_CREDENTIAL_TTL_MAX_SECONDS = 86_400;

/**
 * A TURN server URL as ICE wants it (RFC 7065): the scheme, host[:port], at
 * most `?transport=`. No `//`, no path: a bare hostname or an http URL makes
 * the peer connection throw while it is built, and every call with it.
 */
export const TURN_URL = /^turns?:(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::[0-9]{1,5})?(?:\?transport=(?:udp|tcp))?$/;

export class RtcSettingsError extends Error {
  /** The patch field the problem is in (`/turnUrls/0`), for the admin's answer. */
  readonly pointer: string;

  constructor(message: string, pointer: string) {
    super(message);
    this.name = 'RtcSettingsError';
    this.pointer = pointer;
  }
}

/**
 * The client signalling URL as an origin: `http(s)` becomes `ws(s)`, any
 * path, query or trailing slash goes. Null for anything else.
 */
export function normalizeClientWsUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  const protocol = parsed.protocol === 'https:' ? 'wss:' : parsed.protocol === 'http:' ? 'ws:' : parsed.protocol;
  if (protocol !== 'wss:' && protocol !== 'ws:') return null;
  if (!parsed.host || parsed.username || parsed.password) return null;
  return `${protocol}//${parsed.host}`;
}

/**
 * The signalling URL an admin may give clients, as an origin: `wss://` (or
 * `https://`, which becomes `wss://`) on a public host name, by the rules
 * the panel's hosts follow (no IP address, no local, private or reserved
 * name): every LiveKit token is handed over it, so never in plain text and
 * never to an inside host. The reason when it is not one.
 */
export function checkClientWsUrl(raw: string): { ok: true; value: string } | { ok: false; message: string } {
  const text = raw.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return { ok: false, message: 'must be a URL such as wss://rtc.example.com' };
  }
  if (parsed.protocol !== 'wss:' && parsed.protocol !== 'https:') return { ok: false, message: 'must use wss:// (or https://)' };
  if (parsed.username || parsed.password) return { ok: false, message: 'must not carry a user name or password' };
  const checked = checkOrigin(`https://${parsed.host}`, { allowIpHosts: false });
  if (!checked.ok) return checked;
  return { ok: true, value: checked.value.replace(/^https:/, 'wss:') };
}

/** A stored signalling URL as clients may get it; null (the brand's host is used) for one that breaks the rules. */
function storedClientWsUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const checked = checkClientWsUrl(raw);
  return checked.ok ? checked.value : null;
}

/** Two-letter codes (upper case) or `*`, each once; anything else is dropped. */
export function normalizeTurnCountries(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const code = item.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code) && code !== '*') continue;
    if (!out.includes(code)) out.push(code);
  }
  return out;
}

/** A credential lifetime inside 600..86400 s; anything unreadable is the default. */
export function clampTurnCredentialTtl(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n)) return TURN_CREDENTIAL_TTL_DEFAULT_SECONDS;
  return Math.max(TURN_CREDENTIAL_TTL_MIN_SECONDS, Math.min(Math.round(n), TURN_CREDENTIAL_TTL_MAX_SECONDS));
}

/** The host of a TURN URL (brackets of an IPv6 address removed), lower case. */
export function turnUrlHost(url: string): string | null {
  const m = TURN_URL.exec(url.trim());
  if (!m) return null;
  return (m[1]!).replace(/^\[|\]$/g, '').toLowerCase();
}

/**
 * What the admin can compare with the relay's own copy of the secret
 * (`printf %s "$secret" | sha256sum | cut -c1-12`): 12 hex digits of its
 * SHA-256. Never the secret.
 */
export function turnSecretFingerprint(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 12);
}

/** The stored row (lenient: a hand-edited value must not take calls down; the admin route refuses bad values). */
const storedSchema = z.looseObject({
  wsUrl: z.string().nullable().optional(),
  turn: z
    .looseObject({
      urls: z.array(z.unknown()).optional(),
      secret: z.string().optional(),
      countries: z.array(z.unknown()).optional(),
      credentialTtlSeconds: z.unknown().optional(),
    })
    .optional(),
  maxLiveCalls: z.number().int().nonnegative().nullable().optional(),
});
export type StoredRtcSettings = z.infer<typeof storedSchema>;

export function parseStoredRtcSettings(value: unknown): StoredRtcSettings {
  const parsed = storedSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : {};
}

/** The settings as a process uses them, the secret opened. */
export interface RtcSettings {
  /** The stored signalling URL as an origin; null: the brand's `rtc` host. */
  wsUrl: string | null;
  relay: {
    urls: string[];
    /** Null when none is stored, or when it cannot be opened (DATA_KEYS changed): the relay is then withheld. */
    secret: string | null;
    /** Whether a secret is stored at all (opened or not). */
    secretStored: boolean;
    countries: string[];
    credentialTtlSeconds: number;
  };
  /** At most this many calls with a ring or a room at once; null: no cap. */
  maxLiveCalls: number | null;
}

export const EMPTY_RTC_SETTINGS: RtcSettings = {
  wsUrl: null,
  relay: { urls: [], secret: null, secretStored: false, countries: [], credentialTtlSeconds: TURN_CREDENTIAL_TTL_DEFAULT_SECONDS },
  maxLiveCalls: null,
};

/** Opens a stored row; never throws (an unopenable secret is no secret). */
export function rtcSettingsOf(value: unknown, sealer: DataSealer | null, onSecretError?: (error: unknown) => void): RtcSettings {
  const stored = parseStoredRtcSettings(value);
  const turn = stored.turn ?? {};
  let secret: string | null = null;
  if (turn.secret && sealer) {
    try {
      secret = sealer.openText(Buffer.from(turn.secret, 'base64'), TURN_SECRET_PURPOSE);
      if (secret.length === 0) secret = null;
    } catch (error) {
      onSecretError?.(error);
      secret = null;
    }
  }
  return {
    wsUrl: storedClientWsUrl(stored.wsUrl ?? null),
    relay: {
      urls: (turn.urls ?? []).filter((u): u is string => typeof u === 'string' && TURN_URL.test(u.trim())).map((u) => u.trim()),
      secret,
      secretStored: Boolean(turn.secret),
      countries: normalizeTurnCountries(turn.countries),
      credentialTtlSeconds: clampTurnCredentialTtl(turn.credentialTtlSeconds),
    },
    maxLiveCalls: stored.maxLiveCalls ?? null,
  };
}

/** Whether the relay serves a participant in `country` (null: not known, never served). `*` serves everyone. */
export function relayServes(countries: readonly string[], country: string | null): boolean {
  if (countries.includes('*')) return true;
  return country !== null && countries.includes(country);
}

export interface ParticipantNetwork {
  turn: { urls: string[]; username: string; credential: string } | null;
  /** The participant was handed the relay. */
  relayed: boolean;
  /** `turn_missing`: the participant's network needs the relay and none can be given. */
  warnings: string[];
}

/** The shortest life a relay credential is minted with (a call this close to its guard still gets one). */
export const TURN_CREDENTIAL_FLOOR_SECONDS = 60;
/** A participant's relay credential is replaced once less than this is left of it (at most half its lifetime). */
export const TURN_RENEWAL_MAX_SECONDS = 30 * 60;

const TURN_USERNAME = /^([0-9]{1,12}):r[0-9a-f]{16}$/;

/** The expiry (unix seconds) a relay username carries, or null for anything that is not one. */
export function turnUsernameExpiry(username: string | null | undefined): number | null {
  const m = TURN_USERNAME.exec(username ?? '');
  return m ? Number(m[1]) : null;
}

export interface ParticipantNetworkOptions {
  /**
   * When the call can last no longer (its guard): no credential is minted
   * to outlive it, whatever the relay setting's lifetime.
   */
  notAfterMs?: number | undefined;
  /** 8 random bytes for the username (tests pass fixed ones). */
  nonce?: Buffer | undefined;
}

/**
 * The TURN part of one participant's token answer, from their own trusted
 * country, with a newly minted username. coturn's `user-quota` counts
 * allocations per username and a credential cannot be revoked before its
 * expiry, so the token route hands each participant of a call one username
 * (kept in the call hash, see {@link turnReuseFloorSeconds}) and uses this
 * one only when none is kept or the kept one is about to run out.
 */
export function participantNetwork(settings: RtcSettings, country: string | null, now: number, options: ParticipantNetworkOptions = {}): ParticipantNetwork {
  const relay = settings.relay;
  if (!relayServes(relay.countries, country)) return { turn: null, relayed: false, warnings: [] };
  if (relay.urls.length === 0 || relay.secret === null) return { turn: null, relayed: false, warnings: ['turn_missing'] };
  let ttlSeconds = relay.credentialTtlSeconds;
  if (options.notAfterMs !== undefined) {
    const left = Math.floor(options.notAfterMs / 1_000) - Math.floor(now / 1_000);
    ttlSeconds = Math.max(TURN_CREDENTIAL_FLOOR_SECONDS, Math.min(ttlSeconds, left));
  }
  const minted = mintTurnCredential({ sharedSecret: relay.secret, ttlSeconds, now, nonce: options.nonce });
  return { turn: { urls: [...relay.urls], username: minted.username, credential: minted.credential }, relayed: true, warnings: [] };
}

/**
 * The earliest expiry (unix seconds) a username handed before may have to
 * be handed again: less than the renewal margin left, a new one is minted;
 * near the call's guard, where every new username would expire at the
 * guard too, the kept one stands.
 */
export function turnReuseFloorSeconds(settings: RtcSettings, now: number, notAfterMs?: number): number {
  const margin = Math.min(TURN_RENEWAL_MAX_SECONDS, Math.floor(settings.relay.credentialTtlSeconds / 2));
  const floor = Math.floor(now / 1_000) + margin;
  return notAfterMs === undefined ? floor : Math.min(floor, Math.floor(notAfterMs / 1_000));
}

/** The same network with a username handed out earlier: its password under the current secret. */
export function withTurnUsername(settings: RtcSettings, network: ParticipantNetwork, username: string): ParticipantNetwork {
  if (!network.turn || settings.relay.secret === null) return network;
  return { ...network, turn: { urls: network.turn.urls, username, credential: turnPassword(settings.relay.secret, username) } };
}

/** A change of the settings from the admin panel. `sharedSecret`: absent keeps it, '' removes it, text replaces it. */
export interface RtcSettingsPatch {
  wsUrl?: string | null | undefined;
  turnUrls?: readonly string[] | undefined;
  sharedSecret?: string | undefined;
  countries?: readonly string[] | undefined;
  credentialTtlSeconds?: number | undefined;
  maxLiveCalls?: number | null | undefined;
}

export interface MergedRtcSettings {
  /** The value to store: the stored row with the patch applied (unknown keys kept). */
  value: Record<string, unknown>;
  /** What changed, by name; never a value. */
  changed: string[];
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Merges a patch onto the stored row (read uncached, so keys this build does
 * not know and the sealed secret survive), seals a new secret, and checks
 * the merged value, not the patch: a patch that adds only a URL is judged
 * against the secret already stored.
 */
export function mergeRtcSettings(storedValue: unknown, patch: RtcSettingsPatch, sealer: DataSealer): MergedRtcSettings {
  const stored = (storedValue && typeof storedValue === 'object' && !Array.isArray(storedValue) ? storedValue : {}) as Record<string, unknown>;
  const storedTurn = (stored['turn'] && typeof stored['turn'] === 'object' && !Array.isArray(stored['turn']) ? stored['turn'] : {}) as Record<string, unknown>;
  const value: Record<string, unknown> = { ...stored };
  const turn: Record<string, unknown> = { ...storedTurn };
  const changed: string[] = [];

  if (patch.wsUrl !== undefined) {
    if (patch.wsUrl === null || patch.wsUrl.trim() === '') {
      value['wsUrl'] = null;
    } else {
      const checked = checkClientWsUrl(patch.wsUrl);
      if (!checked.ok) throw new RtcSettingsError(`The signalling URL ${checked.message}: a wss:// (or https://) address on a public host name.`, '/wsUrl');
      value['wsUrl'] = checked.value;
    }
  }
  if (patch.turnUrls !== undefined) {
    const urls: string[] = [];
    patch.turnUrls.forEach((raw, i) => {
      const url = raw.trim();
      if (!TURN_URL.test(url)) {
        throw new RtcSettingsError(
          `Not a TURN server URL: use turn:host:3478, turn:host:3478?transport=tcp or turns:host:5349 (a bare hostname takes every call down).`,
          `/turnUrls/${i}`,
        );
      }
      if (!urls.includes(url)) urls.push(url);
    });
    turn['urls'] = urls;
  }
  if (patch.countries !== undefined) {
    patch.countries.forEach((raw, i) => {
      const code = raw.trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(code) && code !== '*') throw new RtcSettingsError('A relay country is a two-letter code (or * for everyone).', `/countries/${i}`);
    });
    turn['countries'] = normalizeTurnCountries(patch.countries);
  }
  if (patch.credentialTtlSeconds !== undefined) {
    const ttl = patch.credentialTtlSeconds;
    if (!Number.isInteger(ttl) || ttl < TURN_CREDENTIAL_TTL_MIN_SECONDS || ttl > TURN_CREDENTIAL_TTL_MAX_SECONDS) {
      throw new RtcSettingsError(
        `The credential lifetime is between ${TURN_CREDENTIAL_TTL_MIN_SECONDS} and ${TURN_CREDENTIAL_TTL_MAX_SECONDS} seconds.`,
        '/credentialTtlSeconds',
      );
    }
    turn['credentialTtlSeconds'] = ttl;
  }
  if (patch.maxLiveCalls !== undefined) value['maxLiveCalls'] = patch.maxLiveCalls;

  let secretChanged = false;
  if (patch.sharedSecret !== undefined) {
    if (patch.sharedSecret === '') {
      secretChanged = typeof turn['secret'] === 'string';
      delete turn['secret'];
    } else {
      if (patch.sharedSecret.trim() !== patch.sharedSecret || patch.sharedSecret.length < 16) {
        throw new RtcSettingsError('The shared secret is at least 16 characters, without spaces around it.', '/sharedSecret');
      }
      turn['secret'] = sealer.seal(patch.sharedSecret, TURN_SECRET_PURPOSE).toString('base64');
      secretChanged = true;
    }
  }

  // The merged value must be usable: a TURN URL needs a secret to mint credentials from, and
  // LiveKit's own signalling host is never a relay (LiveKit hands its own TURN credentials over signalling).
  const urls = Array.isArray(turn['urls']) ? (turn['urls'] as unknown[]).filter((u): u is string => typeof u === 'string') : [];
  if (urls.length > 0 && typeof turn['secret'] !== 'string') {
    throw new RtcSettingsError('TURN URLs need the relay\'s shared secret to mint credentials from.', '/sharedSecret');
  }
  const signalling = normalizeClientWsUrl(typeof value['wsUrl'] === 'string' ? value['wsUrl'] : null);
  const signallingHost = signalling ? new URL(signalling.replace(/^ws/, 'http')).hostname.toLowerCase() : null;
  urls.forEach((url, i) => {
    if (signallingHost && turnUrlHost(url) === signallingHost) {
      throw new RtcSettingsError('Never list LiveKit\'s own host as the relay.', `/turnUrls/${i}`);
    }
  });

  value['turn'] = turn;
  for (const field of ['wsUrl', 'maxLiveCalls']) if (!same(stored[field], value[field])) changed.push(field);
  for (const field of ['urls', 'countries', 'credentialTtlSeconds']) if (!same(storedTurn[field], turn[field])) changed.push(`turn.${field}`);
  if (secretChanged) changed.push('turn.sharedSecret');
  return { value, changed };
}
