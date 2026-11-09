import { z } from 'zod';
import { timeSchema } from './common.js';

/**
 * The signed origins document: where the apps find the API, realtime, call
 * signalling, the CDN and the website, so that every host can change without
 * a new app build.
 *
 * On the wire it is an envelope:
 *
 *   { "alg": "Ed25519", "kid": "<key id>", "payload": "<base64url>", "sig": "<base64url>" }
 *
 * `payload` is the base64url (no padding) of the UTF-8 JSON of
 * {@link OriginsPayload}; `sig` is the Ed25519 signature (64 bytes, base64url)
 * of the ASCII bytes of `ORIGINS_SIGNING_CONTEXT + payload`, so the verifier
 * checks exactly the text it received before decoding anything. `kid` names
 * the key; an app accepts the keys its build lists (two during a rotation).
 *
 * Every host list is in order of preference. Entries are bare `https`
 * origins (`https://api.example.com`, a port when not 443); `bootstrap` lists
 * full `https` URLs where copies of the document itself are published.
 * Documents are ordered by (`version`, `issuedAt`): `version` grows with
 * every change of the hosts and never goes back; `issuedAt` moves when the
 * same hosts are signed again.
 */

export const originRoles = ['api', 'realtime', 'rtc', 'cdn', 'web'] as const;
export type OriginRole = (typeof originRoles)[number];

export const ORIGINS_ALGORITHM = 'Ed25519';
/** What the signature covers: this text, then the payload exactly as sent. */
export const ORIGINS_SIGNING_CONTEXT = 'origins-v1.';
export const ORIGINS_PER_ROLE_MAX = 8;
export const ORIGINS_BOOTSTRAP_MAX = 8;
/** The version of a document whose hosts were never saved in the panel (the deployment's own hosts). */
export const ORIGINS_DEFAULT_VERSION = 1;

const KID = /^[A-Za-z0-9._-]{1,32}$/;
export const originsKeyIdSchema = z.string().regex(KID, 'must be 1-32 letters, digits, ".", "_" or "-"');

/** An Ed25519 public key: 32 bytes in base64url (43 characters, no padding). */
export const ed25519PublicKeySchema = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/, 'must be 32 bytes in base64url (43 characters)');

// ─── Host rules ────────────────────────────────────────────────────────────

const HOST_NAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;
/** Names that never resolve on the public internet (RFC 6761, 6762, 8375, 7686, and `internal`). */
const SPECIAL_USE = /(^|\.)(localhost|local|test|invalid|example|internal|onion|home\.arpa)$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const MAX_URL = 300;

function ipv4Public(parts: readonly number[]): boolean {
  const [a = 0, b = 0, c = 0] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // shared address space
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

/** The eight 16-bit groups of an IPv6 address as the URL parser writes it (`::1`, `2001:db8::1`, `::ffff:7f00:1`). */
function ipv6Groups(text: string): number[] | null {
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  const groups = all.map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? Number.parseInt(group, 16) : Number.NaN));
  return groups.some(Number.isNaN) ? null : groups;
}

function ipv6Public(groups: readonly number[]): boolean {
  const [g0 = 0, g1 = 0] = groups;
  if (groups.every((g) => g === 0)) return false; // unspecified
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return false; // loopback
  if (groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0xffff || groups[5] === 0)) return false; // IPv4-mapped or compatible
  if ((g0 & 0xfe00) === 0xfc00) return false; // unique local
  if ((g0 & 0xffc0) === 0xfe80) return false; // link local
  if ((g0 & 0xff00) === 0xff00) return false; // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // documentation
  return true;
}

export interface HostRules {
  /** IP literals are refused unless this is set; private and reserved addresses are refused always. */
  allowIpHosts: boolean;
}

/** Checks the host of a parsed URL; returns a reason when it is not one an app may be sent to. */
function hostProblem(hostname: string, rules: HostRules): string | null {
  if (hostname.startsWith('[')) {
    if (!rules.allowIpHosts) return 'an IP address is not allowed here (allowIpHosts is off)';
    const groups = ipv6Groups(hostname.slice(1, -1));
    return groups && ipv6Public(groups) ? null : 'must be a public IP address';
  }
  const v4 = IPV4.exec(hostname);
  if (v4) {
    if (!rules.allowIpHosts) return 'an IP address is not allowed here (allowIpHosts is off)';
    const parts = v4.slice(1).map(Number);
    return parts.every((p) => p <= 255) && ipv4Public(parts) ? null : 'must be a public IP address';
  }
  if (!HOST_NAME.test(hostname)) return 'must be a fully qualified host name';
  if (SPECIAL_USE.test(hostname)) return 'must be a public host name (not a local or reserved name)';
  return null;
}

function parseHttps(value: string): URL | string {
  const text = value.trim();
  if (text.length === 0) return 'must not be empty';
  if (text.length > MAX_URL) return `must be at most ${MAX_URL} characters`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return 'must be a URL such as https://api.example.com';
  }
  if (url.protocol !== 'https:') return 'must use https';
  if (url.username !== '' || url.password !== '') return 'must not carry a user name or password';
  if (url.hash !== '' || text.includes('#')) return 'must not carry a fragment';
  return url;
}

export type Checked = { ok: true; value: string } | { ok: false; message: string };

/** `https://host[:port]`, lower case, without a trailing slash; or why the value is not one. */
export function checkOrigin(value: string, rules: HostRules): Checked {
  const url = parseHttps(value);
  if (typeof url === 'string') return { ok: false, message: url };
  if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || value.trim().endsWith('?')) {
    return { ok: false, message: 'must be an origin only (no path or query)' };
  }
  const problem = hostProblem(url.hostname, rules);
  if (problem) return { ok: false, message: problem };
  return { ok: true, value: url.origin };
}

/** An `https` URL of a published copy of the document (a path, no query); or why it is not one. */
export function checkBootstrapUrl(value: string, rules: HostRules): Checked {
  const url = parseHttps(value);
  if (typeof url === 'string') return { ok: false, message: url };
  if (url.search !== '' || value.trim().includes('?')) return { ok: false, message: 'must not carry a query' };
  if (url.pathname === '/' || url.pathname.endsWith('/')) return { ok: false, message: 'must name a file (a path that does not end with /)' };
  const problem = hostProblem(url.hostname, rules);
  if (problem) return { ok: false, message: problem };
  return { ok: true, value: url.toString() };
}

// ─── Hosts and the stored settings ─────────────────────────────────────────

const urlText = z.string().min(1).max(MAX_URL);

/** Host lists per role (strings; their rules are checked by {@link validateOrigins}). */
export const originHostsSchema = z.strictObject({
  api: z.array(urlText).min(1).max(ORIGINS_PER_ROLE_MAX),
  realtime: z.array(urlText).max(ORIGINS_PER_ROLE_MAX),
  rtc: z.array(urlText).max(ORIGINS_PER_ROLE_MAX),
  cdn: z.array(urlText).max(ORIGINS_PER_ROLE_MAX),
  web: z.array(urlText).max(ORIGINS_PER_ROLE_MAX),
});
export type OriginHosts = z.infer<typeof originHostsSchema>;

export interface OriginsInput {
  hosts: Readonly<Partial<Record<OriginRole, readonly string[] | undefined>>>;
  bootstrap?: readonly string[] | undefined;
  allowIpHosts?: boolean | undefined;
}

export interface OriginsIssue {
  /** JSON Pointer into the input, e.g. `/hosts/api/1`. */
  pointer: string;
  message: string;
}

export type ValidatedOrigins =
  | { ok: true; hosts: OriginHosts; bootstrap: string[]; allowIpHosts: boolean }
  | { ok: false; issues: OriginsIssue[] };

/**
 * The rules of a host change: `https` only, origins without a path, no IP
 * address unless `allowIpHosts`, never a private, local or reserved one, at
 * least one API host, at most eight per role, no entry twice in a role.
 * Entries come back normalised (lower case, no trailing slash).
 */
export function validateOrigins(input: OriginsInput): ValidatedOrigins {
  const rules: HostRules = { allowIpHosts: input.allowIpHosts === true };
  const issues: OriginsIssue[] = [];
  const hosts = { api: [], realtime: [], rtc: [], cdn: [], web: [] } as Record<OriginRole, string[]>;
  for (const role of originRoles) {
    const list = input.hosts[role] ?? [];
    if (list.length > ORIGINS_PER_ROLE_MAX) issues.push({ pointer: `/hosts/${role}`, message: `at most ${ORIGINS_PER_ROLE_MAX} entries` });
    list.forEach((entry, index) => {
      const checked = checkOrigin(entry, rules);
      if (!checked.ok) issues.push({ pointer: `/hosts/${role}/${index}`, message: checked.message });
      else if (hosts[role].includes(checked.value)) issues.push({ pointer: `/hosts/${role}/${index}`, message: 'is listed twice' });
      else hosts[role].push(checked.value);
    });
  }
  if ((input.hosts.api ?? []).length === 0) issues.push({ pointer: '/hosts/api', message: 'at least one API host is required' });
  const bootstrap: string[] = [];
  const urls = input.bootstrap ?? [];
  if (urls.length > ORIGINS_BOOTSTRAP_MAX) issues.push({ pointer: '/bootstrap', message: `at most ${ORIGINS_BOOTSTRAP_MAX} entries` });
  urls.forEach((entry, index) => {
    const checked = checkBootstrapUrl(entry, rules);
    if (!checked.ok) issues.push({ pointer: `/bootstrap/${index}`, message: checked.message });
    else if (bootstrap.includes(checked.value)) issues.push({ pointer: `/bootstrap/${index}`, message: 'is listed twice' });
    else bootstrap.push(checked.value);
  });
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, hosts, bootstrap, allowIpHosts: rules.allowIpHosts };
}

/**
 * The stored value of app_config `origins.hosts`: null until the panel saves
 * hosts (the document then carries the deployment's own, at version 1).
 */
export const originsSettingsSchema = z
  .strictObject({
    /** Grows by at least one with every save; never below 2 (1 is the deployment's own hosts). */
    version: z.number().int().min(ORIGINS_DEFAULT_VERSION + 1).max(Number.MAX_SAFE_INTEGER),
    hosts: originHostsSchema,
    bootstrap: z.array(urlText).max(ORIGINS_BOOTSTRAP_MAX),
    allowIpHosts: z.boolean(),
  })
  .superRefine((value, ctx) => {
    const checked = validateOrigins(value);
    if (!checked.ok) for (const issue of checked.issues) ctx.addIssue({ code: 'custom', path: issue.pointer.split('/').slice(1), message: issue.message });
  });
export type OriginsSettings = z.infer<typeof originsSettingsSchema>;

// ─── The document ──────────────────────────────────────────────────────────

/** What the signature covers. Clients ignore keys they do not know. */
export const originsPayloadSchema = z.strictObject({
  /** The brand the document is for (`brand.json` `id`); an app refuses another brand's. */
  brand: z.string().regex(/^[a-z0-9_][a-z0-9_-]{0,39}$/),
  version: z.number().int().min(ORIGINS_DEFAULT_VERSION).max(Number.MAX_SAFE_INTEGER),
  issuedAt: timeSchema,
  expiresAt: timeSchema,
  hosts: originHostsSchema,
  bootstrap: z.array(urlText).max(ORIGINS_BOOTSTRAP_MAX),
});
export type OriginsPayload = z.infer<typeof originsPayloadSchema>;

/** `GET /v1/origins` and every published copy. */
export const originsDocumentSchema = z.strictObject({
  alg: z.literal(ORIGINS_ALGORITHM),
  kid: originsKeyIdSchema,
  payload: z.string().min(1).max(16_384).regex(/^[A-Za-z0-9_-]+$/),
  /** 64 bytes, base64url. */
  sig: z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/),
});
export type OriginsDocument = z.infer<typeof originsDocumentSchema>;

/** The signed text of a document: the context and the payload, as ASCII bytes. */
export function originsSigningInput(payload: string): Uint8Array {
  return new TextEncoder().encode(ORIGINS_SIGNING_CONTEXT + payload);
}

function base64urlToBytes(text: string): Uint8Array {
  const base64 = text.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** The payload of a document, decoded and checked against its schema (the signature is not checked here). */
export function readOriginsPayload(document: OriginsDocument): OriginsPayload {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(base64urlToBytes(document.payload));
  return originsPayloadSchema.parse(JSON.parse(text));
}

// ─── Admin API (`/v1/admin/origins`) ───────────────────────────────────────

const inputList = z.array(z.string().max(MAX_URL)).max(ORIGINS_PER_ROLE_MAX * 2);

/** A change of the hosts; the rules of {@link validateOrigins} apply (422 `field_invalid` with the pointers). */
export const originsUpdateSchema = z.strictObject({
  hosts: z.strictObject({
    api: inputList,
    realtime: inputList.optional(),
    rtc: inputList.optional(),
    cdn: inputList.optional(),
    web: inputList.optional(),
  }),
  /** Absent: the URLs saved before (or the brand's) stay. */
  bootstrap: inputList.optional(),
  /** Absent: false. */
  allowIpHosts: z.boolean().optional(),
  /** The version the panel was showing; when another save came in between, the change is refused (409 `conflict`). */
  baseVersion: z.number().int().min(ORIGINS_DEFAULT_VERSION).optional(),
});
export type OriginsUpdateBody = z.infer<typeof originsUpdateSchema>;

const hostsView = z.object({
  api: z.array(z.string()),
  realtime: z.array(z.string()),
  rtc: z.array(z.string()),
  cdn: z.array(z.string()),
  web: z.array(z.string()),
});

export const originsAdminViewSchema = z.object({
  /** False until the panel saves hosts: the document then carries the deployment's own. */
  saved: z.boolean(),
  version: z.number().int(),
  hosts: hostsView,
  bootstrap: z.array(z.string()),
  allowIpHosts: z.boolean(),
  /** The deployment's own hosts (environment and brand.json), what a first save starts from. */
  defaults: z.object({ hosts: hostsView, bootstrap: z.array(z.string()) }),
  signing: z.object({
    /** Whether this API has a signing key (`ORIGINS_SIGNING_KEY`); without one `GET /v1/origins` answers 503. */
    configured: z.boolean(),
    kid: z.string().nullable(),
    /** The public key apps must carry (brand.json `origins.publicKeys`). */
    publicKey: z.string().nullable(),
    /** Whether brand.json lists this key under this id (null: brand.json lists no key). */
    trusted: z.boolean().nullable(),
  }),
  /** The document this API process serves now. */
  document: z.object({ version: z.number().int(), issuedAt: timeSchema, expiresAt: timeSchema }).nullable(),
});
export type OriginsAdminView = z.infer<typeof originsAdminViewSchema>;
