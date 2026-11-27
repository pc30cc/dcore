import { ephemeralEventTypes, type RealtimeEnvelope } from '../../realtime.js';
import { bodySnippet, defaultFetch, fetchWithTimeout, isRetryableStatus, ProviderError, type Fetch } from './http.js';

/**
 * Publishing to Centrifugo v6 through its per-method HTTP API (`/api/publish`,
 * `/api/broadcast`, `/api/refresh`) with `X-API-Key`. The envelope id is
 * the publication's idempotency key, so a retried publish is delivered once.
 * Events like `typing` skip the channel history.
 */
export interface RealtimePublisher {
  /** One channel (a user's own events). */
  publish(channel: string, envelope: RealtimeEnvelope): Promise<void>;
  /** Several channels with identical data (both people of a pair). */
  broadcast(channels: readonly string[], envelope: RealtimeEnvelope): Promise<void>;
  /**
   * Closes every connection of a user (ban, suspension, deletion, sign-out)
   * with 3005 "connection expired": apps drop their connection token and ask
   * for a new one, which the API refuses for a revoked session or account.
   */
  disconnect(publicUid: string): Promise<void>;
}

export interface CentrifugoOptions {
  /** Base URL of the server API, e.g. `http://centrifugo:8000`. */
  apiUrl: string;
  apiKey: string;
  fetch?: Fetch | undefined;
  timeoutMs?: number | undefined;
}

interface ApiReply {
  error?: { code?: number; message?: string };
  result?: { responses?: { error?: { code?: number; message?: string } }[] };
}

export class CentrifugoPublisher implements RealtimePublisher {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly fetch: Fetch;
  private readonly timeoutMs: number;

  constructor(options: CentrifugoOptions) {
    this.base = options.apiUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.fetch = options.fetch ?? defaultFetch;
    this.timeoutMs = options.timeoutMs ?? 3_000;
  }

  private async call(method: string, body: unknown): Promise<ApiReply> {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        this.fetch,
        `${this.base}/api/${method}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey },
          body: JSON.stringify(body),
        },
        this.timeoutMs,
      );
    } catch (error) {
      throw new ProviderError('centrifugo', `${method} unreachable`, { retryable: true, cause: error });
    }
    if (!response.ok) {
      throw new ProviderError('centrifugo', `${method} answered ${response.status}: ${await bodySnippet(response)}`, {
        status: response.status,
        retryable: isRetryableStatus(response.status),
      });
    }
    const reply = (await response.json()) as ApiReply;
    if (reply.error) {
      // Code 100 is Centrifugo's "internal error"; the others are refusals.
      throw new ProviderError('centrifugo', `${method} refused: ${reply.error.code ?? '?'} ${reply.error.message ?? ''}`.trim(), {
        status: response.status,
        retryable: reply.error.code === 100,
      });
    }
    return reply;
  }

  async publish(channel: string, envelope: RealtimeEnvelope): Promise<void> {
    await this.call('publish', {
      channel,
      data: envelope,
      idempotency_key: envelope.id,
      ...(ephemeralEventTypes.has(envelope.t) ? { skip_history: true } : {}),
    });
  }

  async broadcast(channels: readonly string[], envelope: RealtimeEnvelope): Promise<void> {
    if (channels.length === 0) return;
    const reply = await this.call('broadcast', {
      channels,
      data: envelope,
      idempotency_key: envelope.id,
      ...(ephemeralEventTypes.has(envelope.t) ? { skip_history: true } : {}),
    });
    const failed = reply.result?.responses?.find((r) => r.error);
    if (failed?.error) {
      throw new ProviderError('centrifugo', `broadcast refused for a channel: ${failed.error.code ?? '?'}`, {
        retryable: failed.error.code === 100,
      });
    }
  }

  async disconnect(publicUid: string): Promise<void> {
    // Always `expired`: a refresh without it (or expire_at) makes the user's connections non-expiring.
    await this.call('refresh', { user: publicUid, expired: true });
  }
}

/** Records what would be published, for tests and for development without Centrifugo. */
export class FakeRealtimePublisher implements RealtimePublisher {
  readonly published: { channels: string[]; envelope: RealtimeEnvelope }[] = [];
  readonly disconnected: string[] = [];
  /** Makes the next calls fail, to test callers' error paths. */
  failWith: Error | null = null;

  async publish(channel: string, envelope: RealtimeEnvelope): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.published.push({ channels: [channel], envelope });
  }

  async broadcast(channels: readonly string[], envelope: RealtimeEnvelope): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.published.push({ channels: [...channels], envelope });
  }

  async disconnect(publicUid: string): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.disconnected.push(publicUid);
  }

  /** Everything a channel received, in order. */
  on(channel: string): RealtimeEnvelope[] {
    return this.published.filter((p) => p.channels.includes(channel)).map((p) => p.envelope);
  }
}

/**
 * People connected to Centrifugo now: `/api/info`, the sum of `num_users`
 * over its nodes (a person connected to two nodes counts twice). Throws a
 * `ProviderError` when Centrifugo cannot be asked.
 */
export async function centrifugoOnlineUsers(options: CentrifugoOptions): Promise<number> {
  const base = options.apiUrl.replace(/\/+$/, '');
  let response: Response;
  try {
    response = await fetchWithTimeout(
      options.fetch ?? defaultFetch,
      `${base}/api/info`,
      { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': options.apiKey }, body: '{}' },
      options.timeoutMs ?? 2_000,
    );
  } catch (error) {
    throw new ProviderError('centrifugo', 'info unreachable', { retryable: true, cause: error });
  }
  if (!response.ok) {
    throw new ProviderError('centrifugo', `info answered ${response.status}: ${await bodySnippet(response)}`, {
      status: response.status,
      retryable: isRetryableStatus(response.status),
    });
  }
  const reply = (await response.json().catch(() => null)) as { error?: unknown; result?: { nodes?: { num_users?: unknown }[] } } | null;
  const nodes = reply?.result?.nodes;
  if (!Array.isArray(nodes) || reply?.error) throw new ProviderError('centrifugo', 'info answered without nodes', { retryable: true });
  return nodes.reduce((sum, node) => sum + (typeof node.num_users === 'number' && node.num_users > 0 ? Math.floor(node.num_users) : 0), 0);
}
