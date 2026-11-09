import { HttpProblem } from '../lib/problem.js';
import { DummyHash, hashPassword, needsRehash, verifyPassword, type Argon2Params } from './password.js';

/**
 * Every Argon2 run of the API process goes through one gate. An Argon2id
 * hash (64 MiB, 3 passes) is a job on libuv's thread pool, which DNS
 * lookups, file reads, zlib and WebCrypto (PostgreSQL's SCRAM) share: a
 * backlog of hashes would stall them for every route. The gate lets at most
 * `concurrency` hashes run at once and `queue` more wait in order; past
 * that a request is refused at once (503 with Retry-After) instead of
 * waiting behind the backlog. Unknown e-mails (the dummy hash) and wrong
 * passwords wait in the same queue, so a refusal says nothing about the
 * account.
 */

export interface HashGateOptions {
  /** Hashes running at once. */
  concurrency: number;
  /** Hashes waiting for a slot; one more is refused. */
  queue: number;
}

export const DEFAULT_HASH_GATE: HashGateOptions = { concurrency: 2, queue: 16 };

export const HASH_BUSY_RETRY_SECONDS = 5;

export class HashGateFullError extends Error {
  constructor() {
    super('admin: the password hashing queue is full');
    this.name = 'HashGateFullError';
  }
}

/** A counting semaphore with a bounded FIFO queue. */
export class HashGate {
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly options: HashGateOptions;

  constructor(options: HashGateOptions = DEFAULT_HASH_GATE) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || !Number.isInteger(options.queue) || options.queue < 0) {
      throw new RangeError('hash gate: concurrency must be a positive integer and queue a non-negative one');
    }
    this.options = { ...options };
  }

  /** Hashes running and waiting now. */
  get load(): { running: number; waiting: number } {
    return { running: this.running, waiting: this.waiting.length };
  }

  /** Runs `work` when a slot is free; throws {@link HashGateFullError} at once when the queue is full. */
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.running < this.options.concurrency) {
      this.running += 1;
    } else {
      if (this.waiting.length >= this.options.queue) throw new HashGateFullError();
      // The slot is handed over by the run that ends (running stays counted).
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running -= 1;
    }
  }
}

function busy(): HttpProblem {
  const retryAfter = String(HASH_BUSY_RETRY_SECONDS);
  return new HttpProblem('service_unavailable', { detail: 'Too many sign-ins at once; try again in a few seconds.', headers: { 'retry-after': retryAfter } });
}

/** The admin password operations of the process, each through the gate (a full queue answers 503). */
export class AdminPasswords {
  readonly params: Argon2Params;
  readonly gate: HashGate;
  private readonly dummy: DummyHash;

  constructor(params: Argon2Params, gate: HashGate) {
    this.params = params;
    this.gate = gate;
    this.dummy = new DummyHash(params);
  }

  private async gated<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await this.gate.run(work);
    } catch (error) {
      if (error instanceof HashGateFullError) throw busy();
      throw error;
    }
  }

  /** Makes the dummy hash ahead of the first unknown e-mail (outside the gate: once per process). */
  prime(): Promise<string> {
    return this.dummy.prime();
  }

  hash(password: string): Promise<string> {
    return this.gated(() => hashPassword(password, this.params));
  }

  verify(password: string, stored: string): Promise<boolean> {
    return this.gated(() => verifyPassword(password, stored));
  }

  /** The cost of a check against no account (an unknown e-mail). */
  burn(password: string): Promise<void> {
    return this.gated(() => this.dummy.burn(password));
  }

  needsRehash(stored: string): boolean {
    return needsRehash(stored, this.params);
  }
}
