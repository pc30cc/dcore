import { createHash } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { bodySnippet, defaultFetch, fetchWithTimeout, isRetryableStatus, type Fetch } from '../clients/http.js';

/**
 * LiveKit's server API (Twirp: `POST <api>/twirp/livekit.RoomService/<Method>`
 * with an admin JWT signed by the API secret), the participant join tokens,
 * and the verification of LiveKit's webhooks. No server SDK: the three
 * calls the server needs are written out here.
 *
 * The server talks to LiveKit directly (LIVEKIT_API_URL, http or https);
 * clients reach its signalling through their own `wsUrl` (network.ts).
 * Rooms are created by the server when a call is answered and LiveKit runs
 * with `auto_create: false`, so a token kept after the end cannot bring a
 * deleted room back.
 */

export interface LiveKitOptions {
  /** Base URL of LiveKit's HTTP API (`http://livekit:7880`); `ws(s)://` is accepted and mapped. */
  apiUrl: string;
  apiKey: string;
  apiSecret: string;
  fetch?: Fetch | undefined;
  /** Deadline of one call (ListParticipants uses at most 5 s). */
  timeoutMs?: number | undefined;
}

/** A Twirp call that failed: `code` is LiveKit's (`not_found`, `already_exists`, ...) or `unavailable` / `deadline_exceeded`. */
export class LiveKitError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(code: string, message: string, status: number, retryable: boolean, options?: ErrorOptions) {
    super(`livekit: ${message}`, options);
    this.name = 'LiveKitError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export class WebhookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookSignatureError';
  }
}

export interface RoomOptions {
  /** Seconds LiveKit keeps a room nobody joined (or everyone left). */
  emptyTimeoutSeconds: number;
  /** Room for a rejoin, which replaces the person's earlier connection. */
  maxParticipants: number;
  /** Room metadata: the call id only, never a person. */
  metadata: string;
}

export type DeleteRoomOutcome = 'deleted' | 'missing' | 'failed';

/** A participant state LiveKit names, by name (protojson) or by number. */
const DISCONNECTED = new Set<unknown>(['DISCONNECTED', 3]);

function httpBase(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (trimmed.startsWith('wss://')) return `https://${trimmed.slice(6)}`;
  if (trimmed.startsWith('ws://')) return `http://${trimmed.slice(5)}`;
  return trimmed;
}

/** One webhook event, as far as calls read it (LiveKit's WebhookEvent, protojson). */
export const livekitEventSchema = z.looseObject({
  event: z.string().min(1),
  id: z.string().optional(),
  createdAt: z.union([z.string(), z.number()]).optional(),
  room: z.looseObject({ sid: z.string().optional(), name: z.string().optional(), metadata: z.string().optional() }).optional(),
  participant: z
    .looseObject({
      sid: z.string().optional(),
      identity: z.string().optional(),
      state: z.union([z.string(), z.number()]).optional(),
      disconnectReason: z.union([z.string(), z.number()]).optional(),
    })
    .optional(),
});
export type LiveKitEvent = z.infer<typeof livekitEventSchema>;

export class LiveKitApi {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly secret: Uint8Array;
  private readonly fetch: Fetch;
  private readonly timeoutMs: number;

  constructor(options: LiveKitOptions) {
    if (!options.apiKey || !options.apiSecret) throw new TypeError('LiveKit needs its API key and secret');
    this.base = httpBase(options.apiUrl);
    this.apiKey = options.apiKey;
    this.secret = new TextEncoder().encode(options.apiSecret);
    this.fetch = options.fetch ?? defaultFetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** A server-side token for one Twirp call (never handed to a client). */
  private adminToken(room?: string): Promise<string> {
    const now = Math.floor(Date.now() / 1_000);
    return new SignJWT({ video: { roomCreate: true, roomList: true, roomAdmin: true, ...(room ? { room } : {}) } })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(this.apiKey)
      .setSubject(this.apiKey)
      .setNotBefore(now - 5)
      .setExpirationTime(now + 600)
      .sign(this.secret);
  }

  private async twirp<T>(method: string, body: Record<string, unknown>, room: string | undefined, timeoutMs = this.timeoutMs): Promise<T> {
    const url = `${this.base}/twirp/livekit.RoomService/${method}`;
    let response: Response;
    try {
      response = await fetchWithTimeout(
        this.fetch,
        url,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${await this.adminToken(room)}`, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
        },
        timeoutMs,
      );
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new LiveKitError(timedOut ? 'deadline_exceeded' : 'unavailable', `${method} ${timedOut ? 'timed out' : 'unreachable'}`, 0, true, { cause: error });
    }
    const text = response.ok ? await response.text() : await bodySnippet(response, 2_000);
    if (!response.ok) {
      let code = 'unknown';
      let message = text.slice(0, 200);
      try {
        const parsed = JSON.parse(text) as { code?: unknown; msg?: unknown };
        if (typeof parsed.code === 'string') code = parsed.code;
        if (typeof parsed.msg === 'string') message = parsed.msg.slice(0, 200);
      } catch {
        // keep the raw text
      }
      throw new LiveKitError(code, `${method} answered ${response.status} ${code}: ${message}`, response.status, isRetryableStatus(response.status));
    }
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return {} as T;
    }
  }

  /** Creates a room; one that already exists is fine (a retried answer). */
  async createRoom(name: string, options: RoomOptions): Promise<void> {
    try {
      await this.twirp(
        'CreateRoom',
        { name, empty_timeout: options.emptyTimeoutSeconds, max_participants: options.maxParticipants, metadata: options.metadata },
        undefined,
      );
    } catch (error) {
      if (error instanceof LiveKitError && error.code === 'already_exists') return;
      throw error;
    }
  }

  /** Deletes a room (which puts out whoever is in it). Never throws: a room already gone is `missing`. */
  async deleteRoom(name: string): Promise<DeleteRoomOutcome> {
    try {
      await this.twirp('DeleteRoom', { room: name }, name);
      return 'deleted';
    } catch (error) {
      if (error instanceof LiveKitError && error.code === 'not_found') return 'missing';
      return 'failed';
    }
  }

  /**
   * The identities in a room now (a participant on its way out is not in
   * it). A room LiveKit no longer has is an empty room. Throws
   * {@link LiveKitError} when LiveKit cannot be asked.
   */
  async listIdentities(name: string): Promise<string[]> {
    type Reply = { participants?: { identity?: unknown; state?: unknown }[] };
    let reply: Reply;
    try {
      reply = await this.twirp<Reply>('ListParticipants', { room: name }, name, Math.min(this.timeoutMs, 5_000));
    } catch (error) {
      if (error instanceof LiveKitError && error.code === 'not_found') return [];
      throw error;
    }
    return (reply.participants ?? [])
      .filter((p) => !DISCONNECTED.has(p.state))
      .map((p) => (typeof p.identity === 'string' ? p.identity : ''))
      .filter((identity) => identity.length > 0);
  }

  /**
   * A participant's join token: the opaque identity, no name, no metadata,
   * this room only.
   */
  async participantToken(input: { identity: string; room: string; ttlSeconds: number; now?: number | undefined }): Promise<{ token: string; expiresAtMs: number }> {
    const now = Math.floor((input.now ?? Date.now()) / 1_000);
    const exp = now + input.ttlSeconds;
    const token = await new SignJWT({
      video: { room: input.room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true },
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(this.apiKey)
      .setSubject(input.identity)
      .setNotBefore(now - 5)
      .setExpirationTime(exp)
      .sign(this.secret);
    return { token, expiresAtMs: exp * 1_000 };
  }

  /**
   * A webhook as LiveKit signs it: `Authorization` is a JWT (with or
   * without `Bearer `) signed with the API secret by the API key, whose
   * `sha256` claim is the base64 SHA-256 of the exact body.
   */
  async verifyWebhook(body: Buffer, authorization: string | undefined): Promise<LiveKitEvent> {
    const token = (authorization ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!token) throw new WebhookSignatureError('no signature');
    let claims: Record<string, unknown>;
    try {
      ({ payload: claims } = await jwtVerify(token, this.secret, { algorithms: ['HS256'], clockTolerance: 60 }));
    } catch {
      throw new WebhookSignatureError('the signature does not verify');
    }
    if (claims['iss'] !== undefined && claims['iss'] !== this.apiKey) throw new WebhookSignatureError('signed by another key');
    const expected = createHash('sha256').update(body).digest('base64');
    if (typeof claims['sha256'] !== 'string' || claims['sha256'] !== expected) throw new WebhookSignatureError('the body does not match its signature');
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      throw new WebhookSignatureError('the body is not JSON');
    }
    const event = livekitEventSchema.safeParse(parsed);
    if (!event.success) throw new WebhookSignatureError('the body is not a webhook event');
    return event.data;
  }
}

/** `participant_left` for a connection the same identity's new one replaced: not a person leaving. */
export function isReplacedConnection(event: LiveKitEvent): boolean {
  const reason = event.participant?.disconnectReason;
  return reason === 'DUPLICATE_IDENTITY' || reason === 2;
}
