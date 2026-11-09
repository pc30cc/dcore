import { createHash } from 'node:crypto';
import { createPool, instrumentPool, statementCounter, type Pool } from '@app/db';
import { userChannel, type RealtimeEnvelope } from '@app/shared';
import { FakePushSender, LiveKitApi, type CallJobQueue, type FakeRealtimePublisher, type Fetch } from '@app/shared/server';
import { callsQueue, loadConfig, type CallJob, type CallJobResult, type JobContext } from '@app/worker';
import { SignJWT, decodeJwt } from 'jose';
import { Redis } from 'ioredis';
import pino from 'pino';
import type { MemoryJobProducer, RecordedJob } from '../src/services/jobs.js';
import type { Harness } from './accountSupport.js';

/**
 * What the call suites run beside the API: a LiveKit that answers the
 * server API in memory (rooms, who is in them, unreachable on demand), the
 * webhooks it would sign, a clock the suite moves, and the worker's `calls`
 * jobs run in the test process from the jobs the API and the jobs
 * themselves queued.
 */

export const LIVEKIT_KEY = 'APIcallstest01';
export const LIVEKIT_SECRET = 'livekit-test-secret-0123456789abcdef0123';
export const IDENTITY_SECRET = 'identity-test-secret-0123456789abcdef01';
export const LIVEKIT_ENV = {
  LIVEKIT_API_URL: 'http://livekit.test.invalid:7880',
  LIVEKIT_API_KEY: LIVEKIT_KEY,
  LIVEKIT_API_SECRET: LIVEKIT_SECRET,
  LIVEKIT_IDENTITY_SECRET: IDENTITY_SECRET,
};

interface FakeRoom {
  metadata: string;
  maxParticipants: number;
  identities: Set<string>;
}

/** LiveKit's RoomService over a `fetch`, in memory. */
export class FakeLiveKit {
  readonly rooms = new Map<string, FakeRoom>();
  readonly calls: { method: string; body: Record<string, unknown> }[] = [];
  unreachable = false;
  /** Runs before a CreateRoom is answered; 'fail' makes that one request fail as an unreachable LiveKit would. */
  beforeCreate: ((name: string) => Promise<'ok' | 'fail'>) | null = null;

  readonly fetch: Fetch = async (input, init) => {
    if (this.unreachable) throw new TypeError('fetch failed');
    const url = new URL(String(input));
    const method = url.pathname.replace('/twirp/livekit.RoomService/', '');
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    const claims = decodeJwt(auth.replace(/^Bearer /, ''));
    if (claims.iss !== LIVEKIT_KEY) return json(401, { code: 'unauthenticated', msg: 'bad key' });
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
    this.calls.push({ method, body });
    switch (method) {
      case 'CreateRoom': {
        const name = String(body['name']);
        if (this.beforeCreate && (await this.beforeCreate(name)) === 'fail') throw new TypeError('fetch failed');
        if (!this.rooms.has(name)) {
          this.rooms.set(name, { metadata: typeof body['metadata'] === 'string' ? body['metadata'] : '', maxParticipants: Number(body['max_participants'] ?? 0), identities: new Set() });
        }
        return json(200, { name });
      }
      case 'DeleteRoom': {
        const name = String(body['room']);
        if (!this.rooms.delete(name)) return json(404, { code: 'not_found', msg: 'room not found' });
        return json(200, {});
      }
      case 'ListParticipants': {
        const room = this.rooms.get(String(body['room']));
        if (!room) return json(404, { code: 'not_found', msg: 'room not found' });
        return json(200, { participants: [...room.identities].map((identity) => ({ identity, state: 'ACTIVE' })) });
      }
      default:
        return json(404, { code: 'bad_route', msg: method });
    }
  };

  client(): LiveKitApi {
    return new LiveKitApi({ apiUrl: LIVEKIT_ENV.LIVEKIT_API_URL, apiKey: LIVEKIT_KEY, apiSecret: LIVEKIT_SECRET, fetch: this.fetch });
  }

  /** Someone joins a room (as LiveKit would let them with a token). */
  join(room: string, identity: string): void {
    this.rooms.get(room)?.identities.add(identity);
  }

  leave(room: string, identity: string): void {
    this.rooms.get(room)?.identities.delete(identity);
  }

  methods(): string[] {
    return this.calls.map((c) => c.method);
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A webhook as LiveKit signs it: the JWT's `sha256` is the body's hash. */
export async function signedWebhook(event: Record<string, unknown>, options: { secret?: string; tamper?: boolean } = {}): Promise<{ body: string; authorization: string }> {
  const body = JSON.stringify(event);
  const hashed = options.tamper ? `${body} ` : body;
  const token = await new SignJWT({ sha256: createHash('sha256').update(hashed).digest('base64') })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(LIVEKIT_KEY)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(options.secret ?? LIVEKIT_SECRET));
  return { body, authorization: token };
}

/** A clock the suite moves. */
export class TestClock {
  constructor(public ms: number = Date.now()) {}
  readonly now = (): number => this.ms;
  advance(ms: number): void {
    this.ms += ms;
  }
}

export interface RunOptions {
  /** As BullMQ counts a retry. */
  attemptsMade?: number;
  /** The worker dies when the job goes to record that its rows were written (they are committed by then). */
  crashAfterCommit?: boolean;
}

export interface CallWorker {
  context: JobContext;
  pool: Pool;
  push: FakePushSender;
  /** Runs one queued job of the API or of earlier jobs; `delayed` when it rescheduled itself. */
  run(job: RecordedJob, options?: RunOptions): Promise<{ result?: CallJobResult; delayed: boolean; statements: number; texts: string[] }>;
  /** The queued call jobs named `name` (and the call, when given) not run yet. */
  pending(name: string, callId?: string): RecordedJob[];
  /** Runs every pending job named `name` (for a call); the results. */
  runAll(name: string, callId?: string): Promise<{ result?: CallJobResult; delayed: boolean; statements: number; texts: string[] }[]>;
  stop(): Promise<void>;
}

/**
 * The worker's `calls` queue in the test process: the same database and
 * Valkey prefix as the API, a fake FCM, the suite's clock and LiveKit; the
 * jobs it queues land in the same memory producer as the API's.
 */
export async function startCallWorker(h: Harness, realtime: FakeRealtimePublisher, jobs: MemoryJobProducer, livekit: FakeLiveKit, clock: TestClock): Promise<CallWorker> {
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: h.db.url,
    REDIS_URL: h.app.config.redis.url,
    REDIS_KEY_PREFIX: h.prefix,
    ID_PUBLIC_KEY: h.app.config.ids.publicKey,
    ID_BILLING_KEY: h.app.config.ids.billingKey,
    WORKER_ID: 'calls-test-worker',
    ...LIVEKIT_ENV,
  });
  const pool = instrumentPool(createPool({ connectionString: h.db.url, applicationName: 'calls-test-worker', max: 4 }), statementCounter);
  const redis = new Redis(h.app.config.redis.url, { maxRetriesPerRequest: null });
  const push = new FakePushSender();
  const context: JobContext = {
    config,
    redis,
    log: pino({ level: 'silent' }),
    token: 'test-token',
    services: {
      pg: pool,
      cache: redis,
      ids: h.app.ids,
      keys: h.app.keys,
      publicIds: h.app.publicIds,
      realtime,
      media: null,
      photoModerator: { moderate: async () => ({ decision: 'review' }) } as never,
      push,
    },
  };
  const queueJobs: CallJobQueue = { add: (name, id, data, opts = {}) => jobs.add('calls', name, id, data, opts) };
  const queue = callsQueue({ livekit: livekit.client(), identitySecret: IDENTITY_SECRET, now: clock.now, jobs: queueJobs });
  const ran = new Set<RecordedJob>();
  const run = async (recorded: RecordedJob, options: RunOptions = {}) => {
    let crash = options.crashAfterCommit === true;
    const job: CallJob = {
      name: recorded.name,
      data: recorded.data,
      attemptsMade: options.attemptsMade ?? 0,
      attemptsStarted: (options.attemptsMade ?? 0) + 1,
      opts: { attempts: recorded.options.attempts ?? 1 },
      moveToDelayed: async () => undefined,
      updateData: async (data: unknown) => {
        if (crash && (data as { done?: { rows?: boolean } }).done?.rows === true) {
          crash = false;
          throw new Error('the worker died');
        }
        recorded.data = data as Record<string, unknown>;
        job.data = data;
      },
    };
    try {
      const { result, tally } = await statementCounter.measure(() => queue.process(job as never, context));
      ran.add(recorded);
      return { result, delayed: false, statements: tally.statements, texts: tally.texts };
    } catch (error) {
      if (error instanceof Error && error.name === 'DelayedError') return { delayed: true, statements: 0, texts: [] };
      throw error;
    }
  };
  const pending = (name: string, callId?: string) =>
    jobs.jobs.filter((j) => j.queue === 'calls' && j.name === name && !ran.has(j) && (callId === undefined || j.data['callId'] === callId));
  return {
    context,
    pool,
    push,
    run,
    pending,
    async runAll(name, callId) {
      const out = [];
      for (const job of pending(name, callId)) out.push(await run(job));
      return out;
    },
    async stop() {
      await redis.quit();
      await pool.end();
    },
  };
}

/** The events a person's channel received, of one type. */
export function eventsOf(realtime: FakeRealtimePublisher, publicUid: string, type: RealtimeEnvelope['t']): RealtimeEnvelope[] {
  return realtime.on(userChannel(publicUid)).filter((e) => e.t === type);
}

/** The latest `call` event a person got for a call. */
export function lastCallEvent(realtime: FakeRealtimePublisher, publicUid: string, callId: string): Record<string, unknown> | undefined {
  const events = eventsOf(realtime, publicUid, 'call').filter((e) => (e.d as { id: string }).id === callId);
  return events.at(-1)?.d;
}
